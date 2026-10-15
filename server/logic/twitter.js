/**
 * Twitter / X followers orders via JustAnotherPanel.
 * Separate from Telegram view drips.
 */

const MAX_ORDERS = 500;
const DEFAULT_SERVICE_ID = 9011;

/** Used so the cost table can render before the slow JAP catalog finishes. */
const FALLBACK_SERVICES = [
  {
    service: 8854,
    name: "Twitter USA Followers [Refill: No] [Max: 1M] [Start Time: 0 - 1 Hr] [Speed: 200K/Day]",
    category: "X - Twitter Followers",
    rate: "0.725",
    min: 100,
    max: 1000000,
    type: "Default",
  },
  {
    service: 10176,
    name: "Twitter Followers [Refill: No] [Max: 20K] [Start Time: 0-1 Hrs] [Speed: Up to 20K/D]",
    category: "X - Twitter Followers",
    rate: "0.7313",
    min: 100,
    max: 20000,
    type: "Default",
  },
  {
    service: 9011,
    name: "Twitter Followers [Refill: 7D] [Max: 2.5K]",
    category: "X - Twitter Followers",
    rate: "0.375",
    min: 10,
    max: 2500,
    type: "Default",
  },
  {
    service: 8695,
    name: "Twitter Followers [Refill: No] [Max: 10K]",
    category: "X - Twitter Followers",
    rate: "0.50",
    min: 10,
    max: 10000,
    type: "Default",
  },
];

/** Instant+cheap fallback when catalog is cold. */
const INSTANT_FALLBACK_SERVICE = FALLBACK_SERVICES[0];

function defaultServiceId() {
  return Number(
    process.env.JAP_TWITTER_FOLLOWERS_SERVICE_ID || DEFAULT_SERVICE_ID
  );
}

function fallbackService(serviceId) {
  const id = Number(serviceId) || defaultServiceId();
  return (
    FALLBACK_SERVICES.find((s) => s.service === id) ||
    FALLBACK_SERVICES[0] ||
    null
  );
}

function defaultProfileUrl() {
  const raw = String(
    process.env.TWITTER_PROFILE_URL || "https://x.com/wangchaionbnb"
  ).trim();
  return normalizeProfileUrl(raw) || "https://x.com/wangchaionbnb";
}

/**
 * Accept @user, user, x.com/user, twitter.com/user → https://x.com/user
 */
function normalizeProfileUrl(input) {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;

  if (s.startsWith("@")) s = s.slice(1).trim();

  if (!/^https?:\/\//i.test(s)) {
    if (/^(x|twitter)\.com\//i.test(s)) s = "https://" + s;
    else if (/^[A-Za-z0-9_]{1,15}$/.test(s)) s = "https://x.com/" + s;
    else return null;
  }

  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  if (host !== "x.com" && host !== "twitter.com") return null;

  const parts = url.pathname.split("/").filter(Boolean);
  if (!parts.length) return null;
  const handle = parts[0].replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;

  return `https://x.com/${handle}`;
}

function isTwitterFollowerService(svc) {
  if (!svc) return false;
  const cat = String(svc.category || "").toLowerCase();
  const name = String(svc.name || "").toLowerCase();
  if (name.includes("impression") || name.includes("bookmark")) return false;
  const followerCat =
    cat.includes("twitter followers") ||
    cat === "x - twitter followers" ||
    cat.includes("x - twitter followers");
  const followerName =
    name.includes("twitter followers") ||
    (name.includes("followers") && cat.includes("twitter"));
  return followerCat || followerName;
}

/** Normalize a raw JAP service row for the UI. */
function mapService(s) {
  if (!s) return null;
  return {
    service: Number(s.service),
    name: s.name,
    category: s.category,
    rate: s.rate,
    min: Number(s.min) || 1,
    max: Number(s.max) || 0,
    type: s.type,
  };
}

function filterFollowerServices(list) {
  const rows = Array.isArray(list) ? list : [];
  return rows
    .filter(isTwitterFollowerService)
    .map(mapService)
    .filter(Boolean)
    .sort((a, b) => Number(a.rate) - Number(b.rate));
}

/** Lowest $/1k follower service from a filtered list. */
function pickCheapest(items) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return fallbackService(defaultServiceId());
  return rows.reduce((best, s) => {
    if (!best) return s;
    return Number(s.rate) < Number(best.rate) ? s : best;
  }, null);
}

/** Start within ~1 hour (instant / near-instant on JAP labels). */
function isInstantService(svc) {
  if (!svc) return false;
  const n = String(svc.name || "").toLowerCase();
  return (
    /instant/.test(n) ||
    /start time:\s*0\s*-\s*1\s*h/.test(n) ||
    /start time:\s*0\s*-\s*1\s*hr/.test(n) ||
    /start\s*time:\s*0\s*-\s*1/.test(n)
  );
}

function speedPerDayK(svc) {
  const n = String(svc?.name || "");
  const m =
    n.match(/speed:\s*up to\s*([\d.]+)\s*k/i) ||
    n.match(/speed:\s*([\d.]+)\s*k/i);
  return m ? Number(m[1]) : 0;
}

/**
 * Cheapest among instant (0–1h start) services.
 * Tie-break: higher daily speed.
 */
function pickInstantCheap(items) {
  const rows = (Array.isArray(items) ? items : []).filter(isInstantService);
  if (!rows.length) return { ...INSTANT_FALLBACK_SERVICE };
  return rows.reduce((best, s) => {
    if (!best) return s;
    const rateDiff = Number(s.rate) - Number(best.rate);
    if (rateDiff < -0.0001) return s;
    if (Math.abs(rateDiff) <= 0.0001 && speedPerDayK(s) > speedPerDayK(best)) {
      return s;
    }
    return best;
  }, null);
}

function ensureTwitterStore(dbx) {
  if (!Array.isArray(dbx.twitterOrders)) dbx.twitterOrders = [];
  if (!dbx.settings) dbx.settings = {};
  if (dbx.settings.twitterServiceId == null) {
    dbx.settings.twitterServiceId = defaultServiceId();
  }
  if (dbx.settings.twitterProfileUrl == null) {
    dbx.settings.twitterProfileUrl = defaultProfileUrl();
  }
}

function orderProgress(order) {
  const qty = Math.max(0, Number(order.quantity) || 0);
  const status = String(order.status || "").toLowerCase();
  const remainsRaw = order.remains;
  const hasRemains = remainsRaw != null && remainsRaw !== "" && Number.isFinite(Number(remainsRaw));
  const remains = hasRemains ? Math.max(0, Number(remainsRaw)) : null;

  let delivered = null;
  let pct = 0;
  let label = "waiting";
  let phase = "pending";

  if (status === "simulated" || order.mode === "dry-run") {
    return {
      qty,
      delivered: 0,
      remains: qty,
      pct: 0,
      label: "dry-run",
      phase: "dry",
    };
  }

  if (status === "completed" || status === "complete") {
    delivered = qty;
    pct = 100;
    label = `${qty}/${qty}`;
    phase = "done";
  } else if (status === "canceled" || status === "cancelled" || status === "failed" || status === "error") {
    delivered = hasRemains ? Math.max(0, qty - remains) : 0;
    pct = qty > 0 ? Math.min(100, Math.round((delivered / qty) * 100)) : 0;
    label = status;
    phase = "failed";
  } else if (hasRemains) {
    // Pending/submitted with remains 0 usually means "not started" — not finished
    const notStarted =
      remains === 0 &&
      (status === "pending" || status === "submitted" || status === "awaiting");
    if (notStarted) {
      delivered = 0;
      pct = 0;
      label = "queued";
      phase = "pending";
    } else {
      delivered = Math.max(0, Math.min(qty, qty - remains));
      pct = qty > 0 ? Math.min(100, Math.round((delivered / qty) * 100)) : 0;
      label = `${delivered}/${qty}`;
      phase = pct >= 100 ? "done" : pct > 0 ? "filling" : "pending";
    }
  } else if (status === "partial") {
    label = "partial";
    phase = "filling";
    pct = 50;
  } else if (status.includes("progress") || status === "processing") {
    label = "starting…";
    phase = "filling";
    pct = 5;
  } else {
    label = status || "queued";
    phase = "pending";
    pct = 0;
  }

  return { qty, delivered, remains, pct, label, phase };
}

function listTwitterOrders(dbData, query = {}) {
  ensureTwitterStore(dbData);
  const limit = Math.min(
    MAX_ORDERS,
    Math.max(1, Number(query.limit) || MAX_ORDERS)
  );
  let items = [...dbData.twitterOrders];
  const mode = query.mode ? String(query.mode).toLowerCase() : null;
  const status = query.status ? String(query.status).toLowerCase() : null;
  const search = query.q ? String(query.q).trim().toLowerCase() : null;

  if (mode) items = items.filter((o) => (o.mode || "").toLowerCase() === mode);
  if (status)
    items = items.filter((o) => (o.status || "").toLowerCase() === status);
  if (search) {
    items = items.filter((o) => {
      const hay = [o.link, o.japOrderId, o.id, o.status, o.mode, o.serviceId]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(search);
    });
  }

  items.sort(
    (a, b) => new Date(b.at || 0).getTime() - new Date(a.at || 0).getTime()
  );

  const total = items.length;
  const page = items.slice(0, limit).map((o) => ({
    ...o,
    progress: orderProgress(o),
  }));
  const followers = page.reduce((n, o) => n + (Number(o.quantity) || 0), 0);
  const live = page.filter((o) => o.mode === "live").length;
  const dry = page.filter((o) => o.mode !== "live").length;
  const active = page.filter(
    (o) =>
      o.mode === "live" &&
      o.progress &&
      (o.progress.phase === "pending" || o.progress.phase === "filling")
  ).length;

  return {
    items: page,
    total,
    summary: {
      orders: total,
      followers,
      live,
      dry,
      active,
    },
  };
}

function applyJapStatus(row, st) {
  if (!row || !st) return row;
  if (st.status != null) row.status = String(st.status).toLowerCase();
  if (st.charge != null) row.charge = st.charge;
  if (st.start_count != null) row.startCount = st.start_count;
  if (st.remains != null) row.remains = st.remains;
  if (st.currency != null) row.currency = st.currency;
  row.japStatusAt = new Date().toISOString();
  return row;
}

module.exports = {
  MAX_ORDERS,
  DEFAULT_SERVICE_ID,
  FALLBACK_SERVICES,
  INSTANT_FALLBACK_SERVICE,
  defaultServiceId,
  fallbackService,
  defaultProfileUrl,
  normalizeProfileUrl,
  filterFollowerServices,
  pickCheapest,
  isInstantService,
  pickInstantCheap,
  mapService,
  orderProgress,
  ensureTwitterStore,
  listTwitterOrders,
  applyJapStatus,
};
