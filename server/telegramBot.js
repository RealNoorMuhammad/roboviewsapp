/**
 * Auto-discover new channel posts via Telegram Bot API (getUpdates).
 * Does NOT need t.me scrape. Works when api.telegram.org is reachable
 * (VPN, proxy, or cloud host). Requires bot as admin of the public channel(s).
 *
 * Env: TELEGRAM_BOT_TOKEN
 * Watches settings.channelUsernames (default: bansyndicate + robogems).
 * Channel map: bansyndicate→Flow 4, robogems→Flow Robo; others→Flow 1.
 */

const db = require("./db");
const worker = require("./worker");
const live = require("./live");
const { flowIdForChannel, flowIdForLink } = require("./logic/curve");

const POLL_MS = Number(process.env.TELEGRAM_BOT_POLL_MS || 200);
const DEFAULT_CHANNELS = ["bansyndicate", "robogems"];

function token() {
  return String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
}

function normalizeChannelName(raw) {
  return String(raw || "")
    .replace(/^@/, "")
    .replace(/^https?:\/\/t\.me\//i, "")
    .split(/[/?#]/)[0]
    .trim()
    .toLowerCase();
}

function channelsWanted() {
  const s = db.read().settings || {};
  let list = [];
  if (Array.isArray(s.channelUsernames) && s.channelUsernames.length) {
    list = s.channelUsernames.map(normalizeChannelName).filter(Boolean);
  } else if (s.channelUsername) {
    list = [normalizeChannelName(s.channelUsername)];
  } else if (process.env.CHANNEL_USERNAMES) {
    list = String(process.env.CHANNEL_USERNAMES)
      .split(/[,;\s]+/)
      .map(normalizeChannelName)
      .filter(Boolean);
  } else if (process.env.CHANNEL_USERNAME) {
    list = [normalizeChannelName(process.env.CHANNEL_USERNAME)];
  }
  if (!list.length) list = [...DEFAULT_CHANNELS];
  return new Set(list);
}

function afterMessageId(username) {
  const s = db.read().settings || {};
  const key = normalizeChannelName(username);
  const w = (s.channelWaters && s.channelWaters[key]) || {};
  const per = Number(w.discoverAfterMessageId || 0);
  if (per) return per;
  // Legacy global only for primary
  const primary = normalizeChannelName(
    (Array.isArray(s.channelUsernames) && s.channelUsernames[0]) ||
      s.channelUsername ||
      ""
  );
  if (key === primary) return Number(s.discoverAfterMessageId || 0);
  return 0;
}

async function botFetch(path, params = {}) {
  const t = token();
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN missing");
  const url = new URL(`https://api.telegram.org/bot${t}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const msg = data.description || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.code = "TELEGRAM_BOT";
      throw err;
    }
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convert channel_post update → t.me link if it matches a watched channel.
 */
function postFromUpdate(update, wantedSet) {
  const msg = update.channel_post || update.edited_channel_post;
  if (!msg || !msg.chat) return null;
  const chat = msg.chat;
  const uname = normalizeChannelName(chat.username || "");
  if (!uname || !wantedSet.has(uname)) return null;
  if (chat.type && chat.type !== "channel") return null;

  const messageId = Number(msg.message_id);
  if (!Number.isFinite(messageId)) return null;

  const link = `https://t.me/${uname}/${messageId}`;
  const text = String(msg.text || msg.caption || "").slice(0, 160);
  const date = msg.date
    ? new Date(msg.date * 1000).toISOString()
    : new Date().toISOString();

  return { messageId, link, text, date, username: uname };
}

/**
 * Long-poll getUpdates. Calls onPost for each new post on any watched channel.
 */
async function pollOnce(offset) {
  const wanted = channelsWanted();
  if (!wanted.size) return { offset, posts: [] };

  const updates = await botFetch("getUpdates", {
    offset,
    timeout: 25,
    allowed_updates: JSON.stringify(["channel_post"]),
  });

  let next = offset;
  const posts = [];
  for (const u of updates || []) {
    if (u.update_id >= next) next = u.update_id + 1;
    const p = postFromUpdate(u, wanted);
    if (p) posts.push(p);
  }
  return { offset: next, posts };
}

/**
 * Ingest one discovered bot post into the drip engine.
 * Channel map: @robogems → Flow Robo, @bansyndicate → Flow 4; others → Flow 1.
 */
function ingestDiscovered(post, source = "bot") {
  const afterId = afterMessageId(post.username);
  if (afterId && post.messageId <= afterId) {
    return { skipped: true, reason: `id ≤ ${afterId}` };
  }

  const existing = db.read().posts.find((p) => p.link === post.link);
  if (existing) return { skipped: true, reason: "already tracked", post: existing };

  const flowId = flowIdForChannel(post.username, "1");
  const created = worker.addPost({
    link: post.link,
    title: post.text || post.link,
    startAt: new Date().toISOString(),
    source,
    flowId,
  });

  live.broadcast("post_hit", {
    postId: created.id,
    link: created.link,
    source,
    message: `HIT via Bot API · Flow ${flowId} · ${created.link}`,
  });

  return { skipped: false, post: created };
}

let botLoopRunning = false;
let botOffset = 0;
let lastBotError = null;
let lastBotOkAt = null;

function botStatus() {
  return {
    enabled: Boolean(token()),
    lastError: lastBotError,
    lastOkAt: lastBotOkAt,
    offset: botOffset,
    channels: [...channelsWanted()],
  };
}

async function botDiscoverLoop() {
  if (botLoopRunning) return;
  if (!token()) {
    console.log("[bot-discover] TELEGRAM_BOT_TOKEN not set — scrape-only mode");
    return;
  }
  botLoopRunning = true;
  console.log(
    "[bot-discover] listening for channel_post updates…",
    [...channelsWanted()].map((c) => `@${c}`).join(" + ")
  );

  // Drop pending backlog of old updates so we only care about NEW posts after boot
  try {
    const warm = await botFetch("getUpdates", {
      offset: -1,
      timeout: 0,
      allowed_updates: JSON.stringify(["channel_post"]),
    });
    if (warm && warm.length) {
      botOffset = warm[warm.length - 1].update_id + 1;
    }
    lastBotError = null;
    lastBotOkAt = new Date().toISOString();
  } catch (e) {
    lastBotError = e.message;
    console.error("[bot-discover] warm-up failed:", e.message);
  }

  for (;;) {
    if (!token()) {
      await sleep(5000);
      continue;
    }
    const auto = db.read().settings?.autoDiscover !== false;
    if (!auto) {
      await sleep(2000);
      continue;
    }
    let gotPosts = 0;
    try {
      const { offset, posts } = await pollOnce(botOffset);
      botOffset = offset || botOffset;
      lastBotError = null;
      lastBotOkAt = new Date().toISOString();
      gotPosts = (posts || []).length;

      for (const p of posts) {
        const r = ingestDiscovered(p, "bot");
        if (!r.skipped) {
          console.log("[bot-discover] NEW", p.link);
          db.logEvent(
            "sync",
            `Bot API: new post ${p.link} · Flow ${flowIdForLink(p.link, "1")} started`
          );
        }
      }
    } catch (e) {
      lastBotError = e.message;
      console.error("[bot-discover]", e.message);
      await sleep(Math.max(POLL_MS, 3000));
      continue;
    }
    // Long-poll already waited up to 25s. Extra sleep after a hit delayed detection.
    if (!gotPosts) await sleep(Math.min(POLL_MS, 50));
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  token,
  botStatus,
  botDiscoverLoop,
  ingestDiscovered,
  pollOnce,
  channelsWanted,
};
