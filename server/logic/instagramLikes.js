/**
 * Instagram post likes — one-shot orders via JustAnotherPanel.
 * Accepts /p/ and /reel/ URLs (not profile followers).
 */

const MAX_ORDERS = 500;
const DEFAULT_SERVICE_ID = 8216;

const FALLBACK_SERVICES = [
  {
    service: 8216,
    name: "Instagram Likes [Refill: NO REFILL] [Max: 100K] [Start Time: 0-1 Hour] [Speed: 300K/Day]",
    category: "Instagram Likes",
    rate: "0.0125",
    min: 10,
    max: 100000,
    type: "Default",
  },
  {
    service: 8464,
    name: "Instagram Likes [LQ] [Refill: No] [Max: 100K] [Start Time: 0-6 Hours] [Speed: 10K/Day]",
    category: "Instagram Likes",
    rate: "0.0125",
    min: 10,
    max: 200000,
    type: "Default",
  },
  {
    service: 1837,
    name: "Instagram Likes [Refill: No] [Max: 1M] [Start Time: 0-1 Hr] [Speed: Up to 300K/D]",
    category: "Instagram Likes",
    rate: "0.0413",
    min: 10,
    max: 10000000,
    type: "Default",
  },
  {
    service: 4289,
    name: "Instagram Likes [HQ] [FEW DROPS] [Refill: 30D] [Max: 100K] [Speed: 10K/D]",
    category: "Instagram Likes",
    rate: "0.0397",
    min: 10,
    max: 5000000,
    type: "Default",
  },
];

const INSTANT_FALLBACK_SERVICE = FALLBACK_SERVICES[0];

function defaultServiceId() {
  return Number(
    process.env.JAP_INSTAGRAM_LIKES_SERVICE_ID || DEFAULT_SERVICE_ID
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

function defaultPostUrl() {
  const raw = String(process.env.INSTAGRAM_LIKES_POST_URL || "").trim();
  return normalizePostUrl(raw) || "";
}

/**
 * Accept instagram.com/p/CODE, /reel/CODE, /reels/CODE, /tv/CODE
 */
function normalizePostUrl(input) {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;

  if (!/^https?:\/\//i.test(s)) {
    if (/^(www\.)?instagram\.com\//i.test(s)) s = "https://" + s;
    else return null;
  }

  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  if (host !== "instagram.com") return null;

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;

  const kind = parts[0].toLowerCase();
  const code = parts[1];
  const allowed = new Set(["p", "reel", "reels", "tv"]);
  if (!allowed.has(kind)) return null;
  if (!/^[A-Za-z0-9_-]{5,40}$/.test(code)) return null;

  const pathKind = kind === "reels" ? "reel" : kind;
  return `https://www.instagram.com/${pathKind}/${code}/`;
}

function isInstagramLikeService(svc) {
  if (!svc) return false;
  const cat = String(svc.category || "").toLowerCase();
  const name = String(svc.name || "").toLowerCase();

  if (
    name.includes("follower") ||
    name.includes("comment") ||
    name.includes("view") ||
    name.includes("share") ||
    name.includes("save") ||
    name.includes("impression") ||
    name.includes("reach") ||
    name.includes("story") ||
    name.includes("auto like") ||
    name.includes("auto-like") ||
    name.includes("mention") ||
    cat.includes("follower") ||
    cat.includes("comment") ||
    cat.includes("view")
  ) {
    return false;
  }

  const likeCat =
    cat.includes("instagram likes") ||
    (cat.includes("instagram") && cat.includes("like"));
  const likeName =
    name.includes("instagram likes") ||
    (name.includes("instagram") && name.includes("like"));

  return likeCat || likeName;
}

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

function filterLikeServices(list) {
  const rows = Array.isArray(list) ? list : [];
  return rows
    .filter(isInstagramLikeService)
    .map(mapService)
    .filter(Boolean)
    .sort((a, b) => Number(a.rate) - Number(b.rate));
}

function pickCheapest(items) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return fallbackService(defaultServiceId());
  return rows.reduce((best, s) => {
    if (!best) return s;
    return Number(s.rate) < Number(best.rate) ? s : best;
  }, null);
}

function isInstantService(svc) {
  if (!svc) return false;
  const n = String(svc.name || "").toLowerCase();
  return (
    /instant/.test(n) ||
    /start time:\s*0\s*-\s*1\s*h/.test(n) ||
    /start time:\s*0-1\s*h/.test(n) ||
    /start time:\s*0\s*-\s*1\s*hr/.test(n)
  );
}

function speedPerDayK(svc) {
  const n = String(svc?.name || "");
  const m =
    n.match(/speed:\s*up to\s*([\d.]+)\s*k/i) ||
    n.match(/speed:\s*([\d.]+)\s*k/i);
  return m ? Number(m[1]) : 0;
}

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

function ensureInstagramLikesStore(dbx) {
  if (!Array.isArray(dbx.instagramLikeOrders)) dbx.instagramLikeOrders = [];
  if (!dbx.settings) dbx.settings = {};
  if (dbx.settings.instagramLikesServiceId == null) {
    dbx.settings.instagramLikesServiceId = defaultServiceId();
  }
  if (dbx.settings.instagramLikesPostUrl == null) {
    dbx.settings.instagramLikesPostUrl = defaultPostUrl();
  }
}

function orderProgress(order) {
  const qty = Math.max(0, Number(order.quantity) || 0);
  const status = String(order.status || "").toLowerCase();
  const remainsRaw = order.remains;
  const hasRemains =
    remainsRaw != null &&
    remainsRaw !== "" &&
    Number.isFinite(Number(remainsRaw));
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
  } else if (
    status === "canceled" ||
    status === "cancelled" ||
    status === "failed" ||
    status === "error"
  ) {
    delivered = hasRemains ? Math.max(0, qty - remains) : 0;
    pct = qty > 0 ? Math.min(100, Math.round((delivered / qty) * 100)) : 0;
    label = status;
    phase = "failed";
  } else if (hasRemains) {
    const notStarted =
      remains === 0 &&
      (status === "pending" ||
        status === "submitted" ||
        status === "awaiting");
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

function listInstagramLikeOrders(dbData, query = {}) {
  ensureInstagramLikesStore(dbData);
  const limit = Math.min(
    MAX_ORDERS,
    Math.max(1, Number(query.limit) || MAX_ORDERS)
  );
  let items = [...dbData.instagramLikeOrders];
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
  const likes = page.reduce((n, o) => n + (Number(o.quantity) || 0), 0);
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
      likes,
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
  defaultPostUrl,
  normalizePostUrl,
  filterLikeServices,
  pickCheapest,
  isInstantService,
  pickInstantCheap,
  mapService,
  orderProgress,
  ensureInstagramLikesStore,
  listInstagramLikeOrders,
  applyJapStatus,
};
