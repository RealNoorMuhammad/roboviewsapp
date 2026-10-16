/**
 * Pull pending Telegram post links from Supabase and start the local drip.
 * Phone page writes rows; this PC is the only process that talks to JAP.
 */

const db = require("./db");
const worker = require("./worker");
const { normalizeFlowId } = require("./logic/curve");

const POLL_MS = Math.max(400, Number(process.env.SUPABASE_INGEST_MS || 800));

const state = {
  enabled: false,
  lastOkAt: null,
  lastError: null,
  lastImportedAt: null,
  lastLink: null,
  lastStatus: null,
  importedCount: 0,
  missingTableUntil: 0,
  recent: [],
};

let running = false;
let loopStarted = false;
let skipLogged = false;

function supabaseUrl() {
  return String(process.env.SUPABASE_URL || "")
    .trim()
    .replace(/\/$/, "");
}

function supabaseKey() {
  return String(process.env.SUPABASE_ANON_KEY || "").trim();
}

function configured() {
  return Boolean(supabaseUrl() && supabaseKey());
}

function headers() {
  const key = supabaseKey();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal",
  };
}

async function rest(path, opts = {}) {
  const base = supabaseUrl();
  const res = await fetch(`${base}/rest/v1/${path}`, {
    ...opts,
    headers: { ...headers(), ...(opts.headers || {}) },
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const msg =
      (data && (data.message || data.error_description || data.hint)) ||
      (typeof data === "string" ? data.slice(0, 200) : res.statusText);
    const err = new Error(`Supabase ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function fetchPending() {
  const q =
    "telegram_posts?status=eq.pending&order=created_at.asc&select=id,link,title,flow_id,source,created_at";
  const rows = await rest(q, { method: "GET" });
  return Array.isArray(rows) ? rows : [];
}

/** Phone rows from the last day, so the desk can show them and catch ones it missed. */
async function fetchRecentMobile() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const q =
    "telegram_posts?source=eq.mobile&created_at=gte." +
    encodeURIComponent(since) +
    "&order=created_at.desc&select=id,link,title,flow_id,source,status,created_at,imported_at&limit=20";
  const rows = await rest(q, { method: "GET" });
  return Array.isArray(rows) ? rows : [];
}

function alreadyTracked(link) {
  let normalized;
  try {
    normalized = worker.normalizeLink(link);
  } catch {
    return true;
  }
  const data = db.read();
  if ((data.phoneDismissed || []).includes(normalized)) return true;
  const m = normalized.match(/t\.me\/([^/]+)\/(\d+)/i);
  return (data.posts || []).some((p) => {
    if (p.link === normalized) return true;
    if (!m) return false;
    const pm = String(p.link || "").match(/t\.me\/([^/]+)\/(\d+)/i);
    return (
      pm &&
      pm[1].toLowerCase() === m[1].toLowerCase() &&
      Number(pm[2]) === Number(m[2])
    );
  });
}

async function patchRow(id, patch) {
  await rest(`telegram_posts?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/**
 * Push a desktop hit (sniffer / auto-discover) so the phone queue shows
 * "added by auto". Fire-and-forget from worker — never blocks drips.
 */
async function reportDesktopHit({
  link,
  title,
  flowId,
  source = "auto",
} = {}) {
  if (!configured()) return null;
  let normalized;
  try {
    normalized = worker.normalizeLink(link);
  } catch {
    return null;
  }
  const src = String(source || "auto").toLowerCase();
  const label = src === "sniffer" ? "sniffer" : "auto";
  const body = {
    link: normalized,
    title: title || normalized,
    flow_id: flowId ? String(flowId) : null,
    source: label,
    status: "imported",
    error: null,
    imported_at: new Date().toISOString(),
  };
  try {
    // Do not overwrite a row the phone already queued — that was hiding "mobile".
    await rest("telegram_posts?on_conflict=link", {
      method: "POST",
      headers: {
        Prefer: "resolution=ignore-duplicates,return=minimal",
      },
      body: JSON.stringify(body),
    });
    return { ok: true, link: normalized, source: label };
  } catch (e) {
    console.error("[phone-ingest] reportDesktopHit", e.message || e);
    return null;
  }
}

function looksLikeTelegramPost(link) {
  return /t\.me\/[^/\s]+\/\d+/i.test(String(link || ""));
}

async function ingestRow(row) {
  const raw = String(row.link || "").trim();
  if (!raw) {
    await patchRow(row.id, {
      status: "error",
      error: "empty link",
      imported_at: new Date().toISOString(),
    });
    return { status: "error", link: raw };
  }
  if (!looksLikeTelegramPost(raw) && !/^@?[a-zA-Z0-9_]+\/\d+$/.test(raw)) {
    await patchRow(row.id, {
      status: "error",
      error: "need a Telegram post link like https://t.me/channel/123",
      imported_at: new Date().toISOString(),
    });
    return { status: "error", link: raw };
  }

  let normalized;
  try {
    normalized = worker.normalizeLink(raw);
  } catch (e) {
    await patchRow(row.id, {
      status: "error",
      error: e.message || "bad link",
      imported_at: new Date().toISOString(),
    });
    return { status: "error", link: raw };
  }

  const idsBefore = new Set((db.read().posts || []).map((p) => p.id));
  const flowId = row.flow_id ? normalizeFlowId(row.flow_id) : undefined;
  const post = worker.addPost({
    link: normalized,
    title: row.title || undefined,
    source: "mobile",
    flowId: flowId || undefined,
  });

  const wasDup = idsBefore.has(post.id);
  const status = wasDup ? "duplicate" : "imported";
  await patchRow(row.id, {
    status,
    source: "mobile",
    error: wasDup ? "already tracking on desktop" : null,
    imported_at: new Date().toISOString(),
  });

  if (!wasDup) state.importedCount += 1;
  state.lastImportedAt = new Date().toISOString();
  state.lastLink = normalized;
  state.lastStatus = status;

  return { status, link: normalized, postId: post.id };
}

async function tick() {
  if (!configured()) return;
  if (running) return;
  if (Date.now() < state.missingTableUntil) return;
  running = true;
  try {
    const rows = await fetchPending();
    state.lastOkAt = new Date().toISOString();
    state.lastError = null;
    state.missingTableUntil = 0;
    let recent = [];
    try {
      recent = await fetchRecentMobile();
      state.recent = recent.map((r) => ({
        link: r.link,
        status: r.status || "pending",
        source: r.source || "mobile",
        createdAt: r.created_at || null,
      }));
    } catch (e) {
      state.lastError = e.message || "phone list failed";
    }
    const pendingIds = new Set(rows.map((r) => r.id));
    const missed = recent.filter(
      (r) => r && r.id && !pendingIds.has(r.id) && !alreadyTracked(r.link)
    );
    for (const row of rows.concat(missed)) {
      try {
        if (missed.includes(row)) {
          console.log("[phone-ingest] desktop missed phone post, adding", row.link);
        }
        await ingestRow(row);
      } catch (e) {
        const msg = e.message || "ingest failed";
        try {
          await patchRow(row.id, {
            status: "error",
            error: msg.slice(0, 400),
            imported_at: new Date().toISOString(),
          });
        } catch (_) {}
        state.lastError = msg;
        console.error("[phone-ingest] row", row.id, msg);
      }
    }
  } catch (e) {
    state.lastError = e.message || "supabase poll failed";
    const missing =
      /PGRST205|Could not find the table|schema cache/i.test(state.lastError) ||
      e.status === 404;
    if (missing) {
      // Table not created yet — retry quietly every 30s instead of every poll
      state.missingTableUntil = Date.now() + 30_000;
      console.error(
        "[phone-ingest] table public.telegram_posts missing — run supabase/telegram_posts.sql in the SQL Editor, then wait ~30s"
      );
    } else {
      console.error("[phone-ingest]", state.lastError);
    }
  } finally {
    running = false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function loop() {
  for (;;) {
    try {
      await tick();
    } catch (_) {}
    await sleep(POLL_MS);
  }
}

function start() {
  state.enabled = configured();
  if (!state.enabled) {
    if (!skipLogged) {
      skipLogged = true;
      console.log(
        "[phone-ingest] off — set SUPABASE_URL and SUPABASE_ANON_KEY to pull phone posts"
      );
    }
    return;
  }
  if (loopStarted) return;
  loopStarted = true;
  console.log(`[phone-ingest] watching Supabase every ${POLL_MS}ms`);
  loop().catch((e) => console.error("[phone-ingest] fatal", e.message || e));
}

function getStatus() {
  return {
    enabled: configured(),
    pollMs: POLL_MS,
    lastOkAt: state.lastOkAt,
    lastError: state.lastError,
    lastImportedAt: state.lastImportedAt,
    lastLink: state.lastLink,
    lastStatus: state.lastStatus,
    importedCount: state.importedCount,
    mobilePath: "/m",
    recent: state.recent || [],
  };
}

module.exports = {
  start,
  tick,
  getStatus,
  configured,
  reportDesktopHit,
};
