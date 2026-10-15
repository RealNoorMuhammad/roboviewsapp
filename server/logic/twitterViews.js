/**
 * X / Twitter post views — one-shot orders via JustAnotherPanel.
 * Separate from X followers and X post likes/comments.
 */

const twitterPosts = require("./twitterPosts");

const MAX_ORDERS = 500;
/** Real JAP Tweet Views (public view count on /status/ posts). */
const DEFAULT_SERVICE_ID = 8413;

/** IDs we once invented as "views" — they are likes / retweets / missing. Never order these. */
const UNSAFE_SERVICE_IDS = new Set([1924, 8859, 8860]);

const FALLBACK_SERVICES = [
  {
    service: 8413,
    name: "Twitter Tweet Views [Refill: No Drop] [Max: 50M] [Start Time: 0 - 1 Hours] [Speed: 1M/Day]",
    category: "X - Twitter Views / Live / Comments",
    rate: "0.0038",
    min: 100,
    max: 50000000,
    type: "Default",
  },
  {
    service: 2098,
    name: "Twitter Tweet Views [Refill: No Drop] [Max: 100M] [Start Time: 0 - 1 Hours] [Speed: 5M/Day]",
    category: "X - Twitter Views / Live / Comments",
    rate: "0.005",
    min: 100,
    max: 100000000,
    type: "Default",
  },
  {
    service: 7727,
    name: "Twitter Impression [Refill: No] [Max: 100M] [Start Time: 0-1 Hr] [Speed: 10M/D]",
    category: "X - Twitter Impressions / Bookmarks",
    rate: "0.004",
    min: 50,
    max: 100000000,
    type: "Default",
  },
];

const INSTANT_FALLBACK_SERVICE = FALLBACK_SERVICES[0];

function defaultServiceId() {
  return Number(process.env.JAP_TWITTER_VIEWS_SERVICE_ID || DEFAULT_SERVICE_ID);
}

function fallbackService(serviceId) {
  const id = Number(serviceId) || defaultServiceId();
  return (
    FALLBACK_SERVICES.find((s) => s.service === id) || {
      ...FALLBACK_SERVICES[0],
      service: id,
      name: `X Post Views (service #${id})`,
    }
  );
}

function defaultPostUrl() {
  const raw = String(
    process.env.TWITTER_VIEWS_POST_URL || process.env.TWITTER_POST_URL || ""
  ).trim();
  return twitterPosts.normalizePostUrl(raw) || "";
}

function normalizePostUrl(input) {
  return twitterPosts.normalizePostUrl(input);
}

function textHay(svc) {
  return `${svc.category || ""} ${svc.name || ""}`.toLowerCase();
}

function isTwitterService(svc) {
  if (!svc) return false;
  const hay = textHay(svc);
  return (
    hay.includes("twitter") ||
    hay.includes("x.com") ||
    /\bx\s*-\s*twitter\b/.test(hay)
  );
}

function viewKind(svc) {
  const name = String(svc?.name || "").toLowerCase();
  if (/impression/.test(name) && !/tweet views|video views/.test(name)) {
    return "impressions";
  }
  if (/video views|media views/.test(name) && !/tweet/.test(name)) {
    return "video_views";
  }
  return "tweet_views";
}

/**
 * JAP groups tweet views in "X - Twitter Views / Live / Comments".
 * Never scan the category for "comment" / "like" — that hid every real views service.
 */
function isTwitterViewService(svc) {
  if (!svc || !isTwitterService(svc)) return false;
  if (UNSAFE_SERVICE_IDS.has(Number(svc.service))) return false;
  const name = String(svc.name || "").toLowerCase();
  if (
    /comments?|likes?|followers?|retweets?|reposts?|bookmarks?|poll votes?|space listeners?|profile click|hashtag click|link click|details click/.test(
      name
    )
  ) {
    return false;
  }
  if (/live views/.test(name) || /livestream/.test(name)) return false;
  return (
    /tweet views/.test(name) ||
    /twitter views/.test(name) ||
    /video views/.test(name) ||
    /media views/.test(name) ||
    /impression/.test(name)
  );
}

function orderIsActualViews(order) {
  if (!order) return false;
  if (UNSAFE_SERVICE_IDS.has(Number(order.serviceId))) return false;
  return isTwitterViewService({
    service: order.serviceId,
    name: order.serviceName || "",
    category: order.serviceCategory || "",
  });
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
    estimate: !!s.estimate,
    viewKind: viewKind(s),
  };
}

function filterViewServices(list) {
  const rows = Array.isArray(list) ? list : [];
  const matched = rows
    .filter(isTwitterViewService)
    .map(mapService)
    .filter(Boolean)
    .sort((a, b) => Number(a.rate) - Number(b.rate));
  if (matched.length) return matched;
  // Catalog present but no views rows — do not substitute likes/retweet IDs.
  if (rows.length) return [];
  return FALLBACK_SERVICES.map(mapService).filter(Boolean);
}

function pickCheapest(items, preferKind = "tweet_views") {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return fallbackService(defaultServiceId());
  const pool = preferKind
    ? rows.filter((s) => viewKind(s) === preferKind)
    : rows;
  const use = pool.length ? pool : rows;
  return use.reduce((best, s) => {
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

function pickInstantCheap(items, preferKind = "tweet_views") {
  const all = Array.isArray(items) ? items : [];
  const instant = all.filter(isInstantService);
  const preferred = instant.filter((s) => viewKind(s) === preferKind);
  const rows = preferred.length ? preferred : instant.length ? instant : all;
  if (!rows.length) return fallbackService(defaultServiceId());
  return pickCheapest(rows, null);
}

function ensureTwitterViewsStore(dbx) {
  if (!Array.isArray(dbx.twitterViewOrders)) dbx.twitterViewOrders = [];
  if (!dbx.settings) dbx.settings = {};
  const sid = Number(dbx.settings.twitterViewsServiceId);
  if (!sid || UNSAFE_SERVICE_IDS.has(sid)) {
    dbx.settings.twitterViewsServiceId = defaultServiceId();
  }
  if (dbx.settings.twitterViewsPostUrl == null) {
    dbx.settings.twitterViewsPostUrl = defaultPostUrl();
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

function listTwitterViewOrders(dbData, query = {}) {
  ensureTwitterViewsStore(dbData);
  const limit = Math.min(
    MAX_ORDERS,
    Math.max(1, Number(query.limit) || MAX_ORDERS)
  );
  let items = [...dbData.twitterViewOrders];
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
  const page = items.slice(0, limit).map((o) => {
    const ok = orderIsActualViews(o);
    return {
      ...o,
      progress: orderProgress(o),
      mismatch: !ok,
      mismatchReason: ok
        ? null
        : "This JAP service is not tweet views (likes/retweets were billed). Public view count on X does not move.",
    };
  });
  const views = page.reduce((n, o) => n + (Number(o.quantity) || 0), 0);
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
      views,
      live,
      dry,
      active,
      mismatched: page.filter((o) => o.mismatch).length,
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
  UNSAFE_SERVICE_IDS,
  defaultServiceId,
  fallbackService,
  defaultPostUrl,
  normalizePostUrl,
  isTwitterViewService,
  orderIsActualViews,
  viewKind,
  filterViewServices,
  pickCheapest,
  isInstantService,
  pickInstantCheap,
  mapService,
  orderProgress,
  ensureTwitterViewsStore,
  listTwitterViewOrders,
  applyJapStatus,
};
