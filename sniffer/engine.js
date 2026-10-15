/**
 * Ultra-fast public-channel post sniffer.
 * Network RTT is milliseconds; we measure confirm time with hrtime (ns) and
 * probe the next message id in parallel with keep-alive + first-hit-wins.
 */

const fs = require("fs");
const path = require("path");

let Agent = null;
try {
  ({ Agent } = require("undici"));
} catch {
  Agent = null;
}

const {
  listFlows,
  getFlow,
  normalizeFlowId,
  flowIdForChannel,
} = require("../server/logic/curve");

const DATA_PATH = path.join(__dirname, "..", "data", "sniffer.json");
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const HOT_MS = Math.max(0, Number(process.env.SNIFFER_HOT_MS || 0));
const CRUISE_MS = Math.max(0, Number(process.env.SNIFFER_CRUISE_MS || 5));
const HOT_WINDOW_MS = Math.max(10_000, Number(process.env.SNIFFER_HOT_WINDOW_MS || 300_000));
const AHEAD = Math.min(3, Math.max(1, Number(process.env.SNIFFER_AHEAD || 1)));
/** How many next-id probes to keep in flight per channel (lower detect delay). */
const CONCURRENCY = Math.min(8, Math.max(1, Number(process.env.SNIFFER_CONCURRENCY || 4)));
const TRY_DIRECT = String(process.env.SNIFFER_TRY_DIRECT || "false").toLowerCase() === "true";
/** Empty-embed from this source is enough to say "no post yet" — do not wait for slower relays. */
let preferredEmbed = "gtranslate";
const sourceLatencyEwma = Object.create(null);

const dispatcher = Agent
  ? new Agent({
      connections: 96,
      pipelining: 1,
      keepAliveTimeout: 90_000,
      keepAliveMaxTimeout: 180_000,
      connect: { timeout: 500 },
    })
  : undefined;

const sourceCooldownUntil = Object.create(null);
const listeners = new Set();
let state = loadState();
const loops = new Map();

function nowNs() {
  return process.hrtime.bigint();
}

function nsToMs(ns) {
  return Number(ns) / 1e6;
}

function defaultState() {
  return {
    auto: true,
    channels: {},
    hits: [],
    stats: {
      probes: 0,
      confirms: 0,
      misses: 0,
      forwarded: 0,
      forwardErrors: 0,
    },
  };
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    return {
      ...defaultState(),
      ...raw,
      channels: raw.channels || {},
      hits: Array.isArray(raw.hits) ? raw.hits.slice(0, 200) : [],
      stats: { ...defaultState().stats, ...(raw.stats || {}) },
    };
  } catch {
    return defaultState();
  }
}

let saveTimer = null;
function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
      fs.writeFileSync(DATA_PATH, JSON.stringify(state, null, 2));
    } catch (e) {
      console.error("[sniffer] save failed", e.message);
    }
  }, 80);
}

function emit(type, payload = {}) {
  const event = { type, at: new Date().toISOString(), ...payload };
  for (const fn of listeners) {
    try {
      fn(event);
    } catch (_) {}
  }
  return event;
}

function onEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function normalizeChannel(raw) {
  return String(raw || "")
    .replace(/^@/, "")
    .replace(/^https?:\/\/t\.me\//i, "")
    .split(/[/?#]/)[0]
    .trim()
    .toLowerCase();
}

function sourceOk(id) {
  return Date.now() >= (sourceCooldownUntil[id] || 0);
}

function cool(id, ms) {
  sourceCooldownUntil[id] = Date.now() + ms;
}

function defaultFlowFor(username) {
  return flowIdForChannel(username, "1");
}

function ensureFlow(ch) {
  if (!ch) return;
  // Mapped channels (robogems→F4, bansyndicate→F4) always win
  ch.flowId = flowIdForChannel(ch.username, ch.flowId || "1");
  ch.alwaysOn = ch.alwaysOn !== false;
}

function channelRecord(username) {
  const u = normalizeChannel(username);
  if (!u) return null;
  if (!state.channels[u]) {
    state.channels[u] = {
      username: u,
      auto: true,
      alwaysOn: true,
      enabled: true,
      flowId: defaultFlowFor(u),
      lastId: 0,
      hotUntil: 0,
      lastProbeAt: null,
      lastHitAt: null,
      lastLatencyMs: null,
      lastLatencyNs: null,
      lastSource: null,
      probes: 0,
      hits: 0,
      errors: 0,
      status: "idle",
      addedAt: new Date().toISOString(),
    };
  }
  ensureFlow(state.channels[u]);
  return state.channels[u];
}

function browserHeaders() {
  return {
    "User-Agent": BROWSER_UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
}

async function getText(url, headers, timeoutMs, parentSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onParent = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener("abort", onParent, { once: true });
  }
  try {
    const opts = {
      signal: controller.signal,
      headers: { ...browserHeaders(), ...headers },
      redirect: "follow",
    };
    if (dispatcher) opts.dispatcher = dispatcher;
    const res = await fetch(url, opts);
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener("abort", onParent);
  }
}

function parseEmbed(html, username, messageId) {
  if (!html || typeof html !== "string") return null;
  const id = Number(messageId);
  if (!Number.isFinite(id) || id < 1) return null;
  const dataPostOk =
    html.includes(`data-post="${username}/${id}"`) ||
    html.includes(`data-post='${username}/${id}'`);
  if (!dataPostOk) return null;
  if (!html.includes("tgme_widget_message")) return null;
  if (/tgme_widget_message_error|peer_id_invalid|Post not found/i.test(html)) {
    return null;
  }

  let date = null;
  const timeMatch = html.match(/datetime="([^"]+)"/);
  if (timeMatch) date = timeMatch[1];

  let text = "";
  const textMatch = html.match(
    /tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i
  );
  if (textMatch) {
    text = textMatch[1]
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
  }

  return {
    messageId: id,
    username,
    link: `https://t.me/${username}/${id}`,
    date,
    text,
  };
}

function classifyEmbed(html, username, messageId) {
  const post = parseEmbed(html, username, messageId);
  if (post) return { kind: "hit", post };
  if (!html) return { kind: "unknown" };
  // Translate/direct empty id: widget chrome, no data-post → definitive miss
  if (
    html.includes("tgme_widget_message") &&
    !html.includes(`data-post="${username}/${messageId}"`) &&
    !html.includes(`data-post='${username}/${messageId}'`)
  ) {
    return { kind: "miss" };
  }
  if (/Post not found|peer_id_invalid/i.test(html)) return { kind: "miss" };
  return { kind: "unknown" };
}

function noteSourceLatency(id, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const prev = sourceLatencyEwma[id];
  sourceLatencyEwma[id] = prev == null ? ms : prev * 0.7 + ms * 0.3;
}

function embedSources(username, id) {
  const embed = `https://t.me/${username}/${id}?embed=1`;
  const bust = Date.now();
  const all = [];
  if (TRY_DIRECT) {
    all.push({
      id: "direct",
      timeoutMs: 350,
      url: `${embed}&_=${bust}`,
    });
  }
  all.push(
    {
      id: "gtranslate",
      timeoutMs: 900,
      url: `https://translate.google.com/translate?sl=auto&tl=en&u=${encodeURIComponent(
        embed
      )}&_=${bust}`,
    },
    {
      id: "allorigins",
      timeoutMs: 800,
      url: `https://api.allorigins.win/raw?url=${encodeURIComponent(embed)}`,
    },
    {
      id: "jina",
      timeoutMs: 650,
      url: `https://r.jina.ai/https://t.me/${username}/${id}?embed=1`,
      headers: { Accept: "text/plain" },
    }
  );
  // Prefer sticky winner, then historically fastest
  all.sort((a, b) => {
    if (a.id === preferredEmbed) return -1;
    if (b.id === preferredEmbed) return 1;
    return (sourceLatencyEwma[a.id] || 9999) - (sourceLatencyEwma[b.id] || 9999);
  });
  return all.filter((s) => sourceOk(s.id));
}

/**
 * Race sources in parallel. First definitive hit OR miss wins (abort the rest).
 * This cuts confirm ms vs waiting on a single slow preferred source.
 */
async function probeOneId(username, id) {
  const sources = embedSources(username, id);
  if (!sources.length) return { post: null, source: null, ns: 0n, starved: true };

  const started = nowNs();
  const parent = new AbortController();

  return await new Promise((resolve) => {
    let settled = false;
    let pending = sources.length;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      parent.abort();
      resolve({ ...result, ns: nowNs() - started });
    };

    for (const src of sources) {
      const t0 = Date.now();
      getText(src.url, src.headers || {}, src.timeoutMs, parent.signal)
        .then((html) => {
          if (settled) return;
          const cls = classifyEmbed(html, username, id);
          const ms = Date.now() - t0;
          if (cls.kind === "hit") {
            noteSourceLatency(src.id, ms);
            preferredEmbed = src.id;
            finish({ post: cls.post, source: src.id });
            return;
          }
          if (cls.kind === "miss") {
            noteSourceLatency(src.id, ms);
            preferredEmbed = src.id;
            finish({ post: null, source: src.id });
          }
        })
        .catch((e) => {
          if (settled) return;
          const msg = String(e.message || "");
          if (e.status === 429) cool(src.id, 6_000);
          else if (e.status === 403 || e.status === 520) cool(src.id, 4_000);
          else if (/fetch failed/i.test(msg)) cool(src.id, 800);
        })
        .finally(() => {
          pending -= 1;
          if (!settled && pending <= 0) {
            finish({ post: null, source: null });
          }
        });
    }
  });
}

async function warmConnections() {
  const probes = [
    "https://translate.google.com/",
    "https://api.allorigins.win/",
  ];
  await Promise.all(
    probes.map((url) =>
      getText(url, {}, 1500).catch(() => null)
    )
  );
}

async function seedLastId(username) {
  const u = normalizeChannel(username);
  const channel = `https://t.me/s/${u}`;
  const sources = [
    {
      id: "list-gtranslate",
      url: `https://translate.google.com/translate?sl=auto&tl=en&u=${encodeURIComponent(
        channel
      )}&_=${Date.now()}`,
      timeoutMs: 3500,
    },
    {
      id: "list-direct",
      url: `${channel}?_=${Date.now()}`,
      timeoutMs: 900,
    },
  ];

  for (const src of sources) {
    if (!sourceOk(src.id)) continue;
    try {
      const html = await getText(src.url, {}, src.timeoutMs);
      const re = new RegExp(`data-post="${u}/(\\d+)"`, "gi");
      let max = 0;
      let m;
      while ((m = re.exec(html)) !== null) {
        const n = Number(m[1]);
        if (n > max) max = n;
      }
      if (max > 0) return max;
    } catch (e) {
      if (e.status === 429) cool(src.id, 30_000);
    }
  }
  return 0;
}

function isHot(ch) {
  if (state.auto && ch.auto && ch.alwaysOn !== false) return true;
  return Date.now() < Number(ch.hotUntil || 0);
}

function intervalFor(ch) {
  return isHot(ch) ? HOT_MS : CRUISE_MS;
}

async function tickChannel(username) {
  const ch = channelRecord(username);
  if (!ch || !ch.enabled) return;
  if (!state.auto || !ch.auto) {
    ch.status = "paused";
    saveState();
    return;
  }

  ch.status = isHot(ch) ? "HOT" : "cruise";
  ch.lastProbeAt = new Date().toISOString();
  ch.probes += 1;
  state.stats.probes += 1;

  if (!ch.lastId) {
    const lastSeed = Number(ch.lastSeedAt || 0);
    if (Date.now() - lastSeed < 1500) return;
    ch.lastSeedAt = Date.now();
    const seeded = await seedLastId(username);
    if (seeded) {
      ch.lastId = seeded;
      ch.status = "armed";
      saveState();
      emit("armed", {
        username,
        lastId: seeded,
        message: `@${username} armed at ${seeded}`,
      });
    }
    return;
  }

  const ids = [];
  for (let i = 1; i <= AHEAD; i++) ids.push(ch.lastId + i);

  const results = await Promise.all(ids.map((id) => probeOneId(username, id)));
  if (results.some((r) => r && r.starved)) {
    await sleep(150);
    return;
  }
  let found = null;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.post) {
      found = r;
      break;
    }
  }

  if (!found || !found.post) {
    state.stats.misses += 1;
    // Keep lastLatencyMs as last HIT only — miss RTT was confusing the UI
    const sample = results[0];
    if (sample && sample.source) ch.lastSource = sample.source;
    return;
  }

  const post = found.post;
  if (post.messageId <= ch.lastId) return;

  ch.lastId = post.messageId;
  ch.hits += 1;
  ch.lastHitAt = new Date().toISOString();
  ch.lastSource = found.source;
  ch.lastLatencyNs = String(found.ns);
  ch.lastLatencyMs = Math.round(nsToMs(found.ns) * 1000) / 1000;
  state.stats.confirms += 1;

  const flowId = flowIdForChannel(username, ch.flowId);
  ch.flowId = flowId;

  const hit = {
    id: `hit_${Date.now()}_${post.messageId}`,
    username,
    messageId: post.messageId,
    link: post.link,
    text: post.text,
    date: post.date,
    source: found.source,
    flowId,
    flowName: getFlow(flowId).name,
    latencyMs: ch.lastLatencyMs,
    latencyNs: String(found.ns),
    hot: isHot(ch),
    at: new Date().toISOString(),
  };
  state.hits.unshift(hit);
  if (state.hits.length > 250) state.hits.length = 250;

  emit("hit", {
    ...hit,
    message: `HIT @${username}/${post.messageId} · ${getFlow(flowId).name} · ${ch.lastLatencyMs}ms`,
  });

  forwardHit(hit).catch(() => {});
  saveState();
}

async function forwardHit(hit) {
  const url = String(process.env.SNIFFER_FORWARD_URL || "").trim();
  if (!url) return;
  const ch = state.channels[normalizeChannel(hit.username)] || {};
  const flowId = flowIdForChannel(hit.username, hit.flowId || ch.flowId);
  const flow = getFlow(flowId);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        link: hit.link,
        title: hit.text || hit.link,
        flowId,
        forceFlow: false,
        source: "sniffer",
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.stats.forwarded += 1;
    emit("forward", {
      link: hit.link,
      ok: true,
      flowId,
      message: `Forwarded ${hit.link} · ${flow.name} (24h)`,
    });
  } catch (e) {
    state.stats.forwardErrors += 1;
    emit("forward", { link: hit.link, ok: false, error: e.message });
  }
  saveState();
}

async function loopChannel(username) {
  const key = normalizeChannel(username);
  if (loops.get(key)) return;
  loops.set(key, true);

  // Overlap probes: fire next check before previous network call finishes.
  // That is what actually lowers detect delay (time until we notice a new post).
  let inFlight = 0;
  let stopping = false;

  const pump = async () => {
    const ch = state.channels[key];
    if (!ch || !ch.enabled) {
      stopping = true;
      return;
    }
    inFlight += 1;
    try {
      await tickChannel(key);
    } catch (e) {
      ch.errors += 1;
      ch.status = "error";
      emit("error", { username: key, error: e.message });
    } finally {
      inFlight -= 1;
    }
  };

  while (state.channels[key] && state.channels[key].enabled && !stopping) {
    const ch = state.channels[key];
    const want = state.auto && ch.auto ? CONCURRENCY : 1;
    while (inFlight < want && state.channels[key]?.enabled) {
      pump();
      // Stagger launches a few ms so we don't stampede the same source
      await sleep(Math.max(HOT_MS, 8));
    }
    await sleep(Math.max(intervalFor(ch), 15));
  }

  // Drain
  while (inFlight > 0) await sleep(40);
  loops.delete(key);
}

function startChannelLoop(username) {
  const u = normalizeChannel(username);
  if (!u || loops.get(u)) return;
  loopChannel(u).catch((e) => console.error("[sniffer] loop", u, e.message));
}

function armHot(username, ms = HOT_WINDOW_MS) {
  const ch = channelRecord(username);
  if (!ch) return null;
  ch.hotUntil = Date.now() + ms;
  ch.auto = true;
  ch.enabled = true;
  ch.status = "HOT";
  saveState();
  startChannelLoop(ch.username);
  emit("hot", {
    username: ch.username,
    hotUntil: new Date(ch.hotUntil).toISOString(),
    intervalMs: HOT_MS,
    message: `BEAST MODE @${ch.username} · ${HOT_MS}ms probes for ${Math.round(ms / 1000)}s`,
  });
  return ch;
}

function addChannel(raw, { auto = true, flowId } = {}) {
  const u = normalizeChannel(raw);
  if (!u) throw new Error("Channel username required");
  const existed = Boolean(state.channels[u]);
  const ch = channelRecord(u);
  ch.enabled = true;
  ch.auto = !!auto;
  ch.alwaysOn = true;
  ch.flowId = normalizeFlowId(flowId || ch.flowId || defaultFlowFor(u));
  if (!existed) ch.lastId = 0;
  saveState();
  if (state.auto && ch.auto) {
    armHot(u);
  } else {
    startChannelLoop(u);
  }
  emit("channel", {
    username: u,
    auto: ch.auto,
    flowId: ch.flowId,
    message: auto
      ? `Added @${u} · ${getFlow(ch.flowId).name} · 24/7 detect`
      : `Added @${u} (auto off) · ${getFlow(ch.flowId).name}`,
  });
  return snapshotChannel(ch);
}

function setChannelFlow(raw, flowId) {
  const ch = channelRecord(raw);
  if (!ch) throw new Error("Unknown channel");
  // Mapped channels stay forced (robogems→4, bansyndicate→4)
  ch.flowId = flowIdForChannel(ch.username, flowId);
  ch.alwaysOn = true;
  saveState();
  emit("channel", {
    username: ch.username,
    flowId: ch.flowId,
    message: `@${ch.username} flow set to ${getFlow(ch.flowId).name} · 24/7`,
  });
  return snapshotChannel(ch);
}

function removeChannel(raw) {
  const u = normalizeChannel(raw);
  if (state.channels[u]) {
    state.channels[u].enabled = false;
    delete state.channels[u];
    saveState();
    emit("channel", { username: u, removed: true, message: `Dropped @${u}` });
  }
}

function setAuto(on) {
  state.auto = !!on;
  saveState();
  if (state.auto) {
    for (const u of Object.keys(state.channels)) {
      const ch = state.channels[u];
      if (ch.auto && ch.enabled) armHot(u);
    }
  }
  emit("auto", {
    auto: state.auto,
    message: state.auto ? "Global AUTO ON — all channels go HOT" : "Global AUTO OFF",
  });
  return { auto: state.auto };
}

function setChannelAuto(raw, on) {
  const ch = channelRecord(raw);
  if (!ch) throw new Error("Unknown channel");
  ch.auto = !!on;
  ch.enabled = true;
  saveState();
  if (state.auto && ch.auto) armHot(ch.username);
  return snapshotChannel(ch);
}

function snapshotChannel(ch) {
  ensureFlow(ch);
  const flow = getFlow(ch.flowId);
  return {
    ...ch,
    flowId: flow.id,
    flowName: flow.name,
    hot: isHot(ch),
    intervalMs: intervalFor(ch),
    hotRemainMs: Math.max(0, Number(ch.hotUntil || 0) - Date.now()),
  };
}

function getSnapshot() {
  for (const ch of Object.values(state.channels)) ensureFlow(ch);
  return {
    auto: state.auto,
    hotMs: HOT_MS,
    cruiseMs: CRUISE_MS,
    ahead: AHEAD,
    concurrency: CONCURRENCY,
    hotWindowMs: HOT_WINDOW_MS,
    preferredSource: preferredEmbed,
    sourceLatencyMs: { ...sourceLatencyEwma },
    forwardUrl: String(process.env.SNIFFER_FORWARD_URL || "").trim() || null,
    flows: listFlows().map((f) => ({
      id: f.id,
      name: f.name,
      instantViews: f.instantViews,
      totalViews: f.totalViews,
      totalOrders: f.totalOrders,
    })),
    stats: state.stats,
    channels: Object.values(state.channels).map(snapshotChannel),
    hits: state.hits.slice(0, 80),
    note:
      "Overlapping probes + source race. last ms = confirm time of last HIT only. Restart sniffer after speed changes.",
  };
}

function startAll() {
  for (const ch of Object.values(state.channels)) ensureFlow(ch);
  warmConnections().catch(() => {});
  if (!Object.keys(state.channels).length) {
    const envList = String(
      process.env.CHANNEL_USERNAMES || process.env.CHANNEL_USERNAME || ""
    )
      .split(/[,;\s]+/)
      .map(normalizeChannel)
      .filter(Boolean);
    for (const u of envList) {
      try {
        addChannel(u, { auto: true });
      } catch (_) {}
    }
  }
  for (const u of Object.keys(state.channels)) {
    if (state.channels[u].enabled) startChannelLoop(u);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  addChannel,
  removeChannel,
  setAuto,
  setChannelAuto,
  setChannelFlow,
  armHot,
  getSnapshot,
  onEvent,
  startAll,
  normalizeChannel,
};
