/**
 * Public channel discovery without BotFather.
 * Listing pages (t.me / Translate) can be blocked, rate-limited, or stale.
 * Primary "instant" path: probe next message IDs via embed pages.
 */

const FETCH_TIMEOUT_MS = Number(process.env.TELEGRAM_FETCH_TIMEOUT_MS || 10_000);
const LIST_MIN_INTERVAL_MS = Number(process.env.TELEGRAM_LIST_INTERVAL_MS || 8_000);
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Sticky sources that last returned posts. */
let preferredListSource = null;
let preferredEmbedSource = null;

/** Per-source cooldown after 429 / failure (ms epoch). */
const sourceCooldownUntil = Object.create(null);

/** Throttle full-channel list scrapes (gtranslate dies if hit every 500ms). */
let lastListAt = 0;
let lastListPosts = [];
let lastListUsername = "";

function browserHeaders() {
  return {
    "User-Agent": BROWSER_UA,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
}

function sourceAvailable(id) {
  return Date.now() >= (sourceCooldownUntil[id] || 0);
}

function coolSource(id, ms, reason = "") {
  sourceCooldownUntil[id] = Date.now() + ms;
  if (reason) {
    // quiet; avoid flood
  }
}

async function fetchChannelPosts(username, limit = 20) {
  const clean = String(username || "").replace(/^@/, "").trim();
  if (!clean) return [];

  // Serve throttled cache so we don't hammer Translate every auto loop
  if (
    clean === lastListUsername &&
    Date.now() - lastListAt < LIST_MIN_INTERVAL_MS &&
    lastListPosts.length
  ) {
    return lastListPosts.slice(0, limit);
  }

  const sources = buildListSources(clean);
  if (preferredListSource) {
    sources.sort((a, b) =>
      a.id === preferredListSource ? -1 : b.id === preferredListSource ? 1 : 0
    );
  }

  let lastErr = null;
  for (const src of sources) {
    if (!sourceAvailable(src.id)) continue;
    try {
      const hit = await trySource(src, clean, limit);
      if (hit && hit.posts.length) {
        preferredListSource = src.id;
        lastListAt = Date.now();
        lastListUsername = clean;
        lastListPosts = hit.posts;
        return hit.posts;
      }
      if (hit && hit.emptyOk) {
        preferredListSource = src.id;
        lastListAt = Date.now();
        lastListUsername = clean;
        lastListPosts = [];
        return [];
      }
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || "");
      if (/HTTP 429/.test(msg)) coolSource(src.id, 90_000);
      else if (/HTTP 403|HTTP 520|HTTP 503/.test(msg)) coolSource(src.id, 30_000);
      else if (/timeout|abort|fetch failed/i.test(msg)) coolSource(src.id, 15_000);
    }
  }

  // Stale cache better than hard fail for watermarks
  if (lastListPosts.length && clean === lastListUsername) {
    return lastListPosts.slice(0, limit);
  }

  throw wrapTelegramError(lastErr);
}

function invalidateListCache() {
  lastListAt = 0;
  lastListPosts = [];
}

/**
 * Instant path: look for posts with messageId > afterId.
 * Used every auto-discover tick so new channel posts show up in ~1s without listing.
 */
async function probeNewPosts(username, afterId, opts = {}) {
  const clean = String(username || "").replace(/^@/, "").trim();
  const from = Number(afterId) || 0;
  if (!clean || from < 0) return [];

  const maxAhead = Math.min(40, Number(opts.maxAhead || 6));
  const missLimit = Number(opts.missLimit != null ? opts.missLimit : 1);
  const aggressive = !!opts.aggressive;

  let start = from + 1;
  let end = from + maxAhead;

  if (aggressive) {
    const high = await findHighestId(clean, from);
    if (high && high > from) {
      // Prefer newest few in range
      end = high;
      start = Math.max(from + 1, high - 8);
    } else {
      return [];
    }
  }

  const found = [];
  let misses = 0;
  for (let id = start; id <= end; id++) {
    const post = await fetchOnePost(clean, id);
    if (post) {
      found.push(post);
      misses = 0;
    } else {
      misses += 1;
      // Waiting for the next post: after 2 consecutive misses, stop (nothing new yet)
      if (!aggressive && found.length === 0 && misses >= missLimit) break;
      if (aggressive && misses >= 3) break;
    }
  }

  found.sort((a, b) => b.messageId - a.messageId);
  return found;
}

/**
 * Exponential + binary search for highest existing message id above `from`.
 */
async function findHighestId(username, from) {
  let lo = from;
  let probe = from + 1;
  let exists = await fetchOnePost(username, probe);
  if (!exists) return null;

  lo = probe;
  // expand
  for (let i = 0; i < 8; i++) {
    probe = from + Math.min(256, 2 ** (i + 1));
    const hit = await fetchOnePost(username, probe);
    if (hit) lo = probe;
    else break;
  }
  // binary between lo and next miss upper bound
  let hi = Math.min(lo + 64, from + 512);
  // refine: walk up from lo a bit (bounded)
  for (let id = lo + 1; id <= lo + 40; id++) {
    const hit = await fetchOnePost(username, id);
    if (hit) lo = id;
    else break;
  }
  return lo;
}

async function fetchOnePost(username, messageId) {
  const id = Number(messageId);
  if (!Number.isFinite(id) || id < 1) return null;

  const embed = `https://t.me/${username}/${id}?embed=1`;
  const sources = [
    // Fast path on this host: Translate embed works; direct t.me usually fails hard
    // Keep timeouts tight — hung relays used to stall auto-detect for 8–12s
    {
      id: "gtranslate-embed",
      url: `https://translate.google.com/translate?sl=auto&tl=en&u=${encodeURIComponent(
        embed
      )}&_=${Date.now()}`,
      headers: browserHeaders(),
      timeoutMs: Number(process.env.TELEGRAM_PROBE_TIMEOUT_MS || 3500),
      kind: "html",
    },
    {
      id: "jina-embed",
      url: `https://r.jina.ai/https://t.me/${username}/${id}?embed=1`,
      headers: { Accept: "text/plain" },
      timeoutMs: 2500,
      kind: "jina",
    },
    {
      id: "direct-embed",
      url: embed,
      headers: browserHeaders(),
      timeoutMs: 2000,
      kind: "html",
    },
    {
      id: "allorigins-embed",
      url: `https://api.allorigins.win/raw?url=${encodeURIComponent(embed)}`,
      headers: { Accept: "text/html,*/*", "User-Agent": BROWSER_UA },
      timeoutMs: 3000,
      kind: "html",
    },
  ];

  // Prefer last good embed source first
  if (preferredEmbedSource) {
    sources.sort((a, b) =>
      a.id === preferredEmbedSource ? -1 : b.id === preferredEmbedSource ? 1 : 0
    );
  }

  for (const src of sources) {
    if (!sourceAvailable(src.id)) continue;
    try {
      const html = await getHtml(src.url, src.headers, src.timeoutMs);
      const post = parseSinglePost(html, username, id, src.kind);
      if (post) {
        preferredEmbedSource = src.id;
        return post;
      }
      // Translate embed for a missing id still returns 200 + widget chrome but NO data-post.
      // That is definitive — skip slower relays (was adding ~12s per idle poll).
      if (
        (src.id === "gtranslate-embed" || src.id === "direct-embed") &&
        html.includes("tgme_widget_message") &&
        !html.includes(`data-post="${username}/${id}"`) &&
        !html.includes(`data-post='${username}/${id}'`)
      ) {
        return null;
      }
      if (
        !html.includes("tgme_widget_message") &&
        /Post not found|peer_id_invalid/i.test(html)
      ) {
        return null;
      }
    } catch (e) {
      const msg = String(e.message || "");
      if (/HTTP 429/.test(msg)) coolSource(src.id, 60_000);
      else if (/HTTP 403|HTTP 520/.test(msg)) coolSource(src.id, 15_000);
      else if (/timeout|abort|fetch failed/i.test(msg)) coolSource(src.id, 2_500);
    }
  }
  return null;
}

function parseSinglePost(html, username, messageId, kind) {
  if (!html || typeof html !== "string") return null;
  const id = Number(messageId);
  if (!Number.isFinite(id) || id < 1) return null;

  // HARD rule: real embeds always include data-post="user/id".
  // Missing-post Translate pages still have tgme_widget_message chrome → was falsely accepted.
  const dataPostOk =
    html.includes(`data-post="${username}/${id}"`) ||
    html.includes(`data-post='${username}/${id}'`);

  // Translate sometimes rewrites attributes; accept only explicit path on known hosts
  // tied to a real message widget foot/media block with this id nearby
  const hostPathOk = new RegExp(
    `(?:t\\.me|telegram\\.me|t-me\\.translate\\.goog)/${username}/${id}(?:[?"'#\\s>]|$)`,
    "i"
  ).test(html);

  if (kind === "jina" || kind === "text") {
    // Jina is loose text — require clear post link AND not a 404/not-found shell
    if (
      !new RegExp(`(?:t\\.me|telegram\\.me)/${username}/${id}\\b`).test(html)
    ) {
      return null;
    }
    if (
      /Post not found|not found|404|No messages|Sorry, this/i.test(
        html.slice(0, 800)
      )
    ) {
      return null;
    }
  } else {
    // HTML: require data-post match (authoritative). Without it → not a real post.
    if (!dataPostOk) return null;
    if (!html.includes("tgme_widget_message")) return null;
  }

  // Extra reject for service/error shells
  if (
    /tgme_widget_message_error|peer_id_invalid|Post not found/i.test(html) &&
    !dataPostOk
  ) {
    return null;
  }

  let date = null;
  const timeMatch = html.match(/datetime="([^"]+)"/);
  if (timeMatch) date = timeMatch[1];
  // Prefer real post time; missing date is OK but do NOT invent "now" for ranking
  // (caller may treat missing as fresh)

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
  } else if (kind === "jina") {
    const lines = html
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    text = (lines.find((l) => l.length > 2 && l.length < 160) || "").slice(
      0,
      160
    );
  }

  // For non-jina: host path should still reference the id when present
  if (kind !== "jina" && !hostPathOk && !dataPostOk) return null;

  return {
    messageId: id,
    link: `https://t.me/${username}/${id}`,
    views: null,
    date,
    text,
  };
}

async function trySource(src, username, limit) {
  const html = await getHtml(src.url, src.headers, src.timeoutMs);
  const posts =
    src.kind === "jina" || src.kind === "text"
      ? parsePostsLoose(html, username, limit)
      : parsePosts(html, username, limit);

  if (posts.length) return { posts, emptyOk: false };

  if (
    html.includes("tgme_channel_info") ||
    html.includes("tgme_page") ||
    html.includes("tgme_widget_message")
  ) {
    return { posts: [], emptyOk: true };
  }
  return null;
}

function buildListSources(username) {
  const channel = `https://t.me/s/${username}`;
  const enc = encodeURIComponent(channel);
  const bust = Date.now();
  return [
    {
      id: "gtranslate",
      kind: "html",
      url: `https://translate.google.com/translate?sl=auto&tl=en&u=${enc}&_=${bust}`,
      headers: browserHeaders(),
      timeoutMs: 14_000,
    },
    {
      id: "t.me",
      kind: "html",
      url: `${channel}?_=${bust}`,
      headers: browserHeaders(),
      timeoutMs: 6_000,
    },
    {
      id: "telegram.me",
      kind: "html",
      url: `https://telegram.me/s/${username}?_=${bust}`,
      headers: browserHeaders(),
      timeoutMs: 6_000,
    },
    {
      id: "allorigins",
      kind: "html",
      url: `https://api.allorigins.win/raw?url=${enc}`,
      headers: { Accept: "text/html,*/*", "User-Agent": BROWSER_UA },
      timeoutMs: 12_000,
    },
    {
      id: "jina-https",
      kind: "jina",
      url: `https://r.jina.ai/https://t.me/s/${username}`,
      headers: { Accept: "text/plain" },
      timeoutMs: 10_000,
    },
  ];
}

async function getHtml(url, extraHeaders = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      ...browserHeaders(),
      ...extraHeaders,
    };
    delete headers["Accept-Encoding"];

    const res = await fetch(url, {
      signal: controller.signal,
      headers,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let body = await res.text();

    if (url.includes("allorigins.win/get?")) {
      try {
        const j = JSON.parse(body);
        body = j.contents || j.data || body;
      } catch (_) {
        /* keep */
      }
    }

    return body;
  } finally {
    clearTimeout(timer);
  }
}

function wrapTelegramError(err) {
  const cause = err?.cause?.message || err?.cause?.code || "";
  const raw = [err?.message, cause].filter(Boolean).join(" — ");
  const blocked =
    /timeout|abort|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|UND_ERR|HTTP 403|HTTP 429|HTTP 502|HTTP 503|HTTP 520/i.test(
      raw
    );

  const msg = blocked
    ? "Can't reach Telegram public pages from this network (direct + relays failed). Try VPN, or paste post links."
    : `Telegram scrape failed: ${raw || "unknown error"}`;

  const e = new Error(msg);
  e.code = blocked ? "TELEGRAM_UNREACHABLE" : "TELEGRAM_SCRAPE";
  e.cause = err;
  return e;
}

function parsePosts(html, username, limit) {
  const posts = [];
  const blocks = html.split(/class="tgme_widget_message_wrap/);
  for (let i = blocks.length - 1; i >= 1; i--) {
    const block = blocks[i];
    const messageId = extractMessageId(block, username);
    if (!messageId) continue;
    const link = `https://t.me/${username}/${messageId}`;

    let date = null;
    const timeMatch = block.match(/datetime="([^"]+)"/);
    if (timeMatch) date = timeMatch[1];

    let text = "";
    const textMatch = block.match(
      /tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i
    );
    if (textMatch) {
      text = textMatch[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
    }

    posts.push({ messageId, link, views: null, date, text });
    if (posts.length >= limit) break;
  }

  if (!posts.length) {
    const re = new RegExp(
      `data-post="${username}/(\\d+)"[\\s\\S]{0,500}?datetime="([^"]+)"`,
      "gi"
    );
    let m;
    const seen = new Set();
    while ((m = re.exec(html)) !== null) {
      const messageId = Number(m[1]);
      if (seen.has(messageId)) continue;
      seen.add(messageId);
      posts.push({
        messageId,
        link: `https://t.me/${username}/${messageId}`,
        views: null,
        date: m[2],
        text: "",
      });
      if (posts.length >= limit) break;
    }
    posts.sort((a, b) => b.messageId - a.messageId);
  }

  return posts;
}

function extractMessageId(block, username) {
  // Prefer authoritative data-post only — translate rewrites hrefs and can invent noise.
  const data = block.match(
    new RegExp(`data-post=["']${username}/(\\d+)["']`, "i")
  );
  if (data) {
    const id = Number(data[1]);
    if (Number.isFinite(id) && id > 0) return id;
  }
  const patterns = [
    new RegExp(
      `href="https?://(?:t\\.me|telegram\\.me|t-me\\.translate\\.goog)/${username}/(\\d+)`,
      "i"
    ),
  ];
  for (const re of patterns) {
    const m = block.match(re);
    if (m) {
      const id = Number(m[1]);
      if (Number.isFinite(id) && id > 0) return id;
    }
  }
  return null;
}

function parsePostsLoose(text, username, limit) {
  const re = new RegExp(
    `(?:https?://(?:t|telegram)\\.me|t-me\\.translate\\.goog)/${username}/(\\d+)`,
    "gi"
  );
  const seen = new Set();
  const posts = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const messageId = Number(m[1]);
    if (!Number.isFinite(messageId) || seen.has(messageId)) continue;
    seen.add(messageId);

    const start = Math.max(0, m.index - 220);
    const slice = text.slice(start, m.index + 220);
    let date = null;
    const iso = slice.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    if (iso) date = iso[0] + (iso[0].endsWith("Z") ? "" : "Z");
    else date = new Date().toISOString();

    posts.push({
      messageId,
      link: `https://t.me/${username}/${messageId}`,
      views: null,
      date,
      text: "",
    });
  }

  posts.sort((a, b) => b.messageId - a.messageId);
  return posts.slice(0, limit);
}

function parseViewCount(raw) {
  const s = String(raw).trim().toUpperCase().replace(/,/g, "");
  if (s.endsWith("K")) return Math.round(parseFloat(s) * 1000);
  if (s.endsWith("M")) return Math.round(parseFloat(s) * 1_000_000);
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  fetchChannelPosts,
  probeNewPosts,
  fetchOnePost,
  invalidateListCache,
  parseViewCount,
};
