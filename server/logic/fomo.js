/**
 * FOMO (fomo.family) followers — first-party house services + optional JAP.
 */

const MAX_ORDERS = 500;

/** Locked target account — always the solid default on /fomo */
const SOLID_ACCOUNT = {
  handle: "noormemewebdev",
  displayName: "Noor Muhammad Dev",
  profileUrl: "https://fomo.family/r/noormemewebdev",
  following: 35,
  followers: 3,
  locked: true,
};

/**
 * Robo house catalog — first-party FOMO follower products (no JAP required).
 * IDs 900001–900003 stay in-house; worker fulfills delivery locally.
 */
const HOUSE_SERVICES = [
  {
    service: 900001,
    name: "FOMO Followers · Starter [Gradual · Natural]",
    category: "FOMO Followers · House",
    rate: "0.90",
    min: 10,
    max: 5000,
    type: "Default",
    house: true,
    badge: "Starter",
    blurb: "Slow drip · looks organic",
    speedPerHour: 720,
  },
  {
    service: 900002,
    name: "FOMO Followers · Heat [Fast · Balanced]",
    category: "FOMO Followers · House",
    rate: "1.50",
    min: 10,
    max: 5000,
    type: "Default",
    house: true,
    badge: "Heat",
    blurb: "Best bang · default pick",
    speedPerHour: 3600,
    featured: true,
  },
  {
    service: 900003,
    name: "FOMO Followers · Legend [HQ · Priority]",
    category: "FOMO Followers · House",
    rate: "2.75",
    min: 10,
    max: 5000,
    type: "Default",
    house: true,
    badge: "Legend",
    blurb: "Priority fill · max speed",
    speedPerHour: 14400,
  },
];
const FALLBACK_SERVICES = HOUSE_SERVICES.slice();
const DEFAULT_SERVICE_ID = 900002;

function estimateRatePer1k() {
  const featured = HOUSE_SERVICES.find((s) => s.featured) || HOUSE_SERVICES[1];
  const n = Number(process.env.FOMO_EST_RATE_PER_1K || featured.rate);
  return Number.isFinite(n) && n > 0 ? n : Number(featured.rate);
}

function isHouseServiceId(serviceId) {
  const id = Number(serviceId);
  return HOUSE_SERVICES.some((s) => s.service === id);
}

function getHouseService(serviceId) {
  const id = Number(serviceId);
  return HOUSE_SERVICES.find((s) => s.service === id) || null;
}

function defaultServiceId() {
  const fromEnv = Number(process.env.JAP_FOMO_FOLLOWERS_SERVICE_ID || 0);
  if (fromEnv > 0) return fromEnv;
  return DEFAULT_SERVICE_ID;
}

function fallbackService(serviceId) {
  const id = Number(serviceId) || defaultServiceId();
  const house = getHouseService(id);
  if (house) return mapService(house);
  const hit = FALLBACK_SERVICES.find((s) => s.service === id);
  if (hit) return mapService(hit);
  return mapService({
    service: id,
    name: `FOMO Followers (service #${id})`,
    category: "FOMO Followers",
    rate: String(estimateRatePer1k()),
    min: 10,
    max: 5000,
    type: "Default",
    estimate: true,
  });
}

function defaultProfileUrl() {
  const raw = String(
    process.env.FOMO_PROFILE_URL || SOLID_ACCOUNT.profileUrl
  ).trim();
  return normalizeProfileUrl(raw) || SOLID_ACCOUNT.profileUrl;
}

/**
 * Accept @user, user, fomo.family/r/user, fomo.family/user → https://fomo.family/r/user
 */
function normalizeProfileUrl(input) {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;

  if (s.startsWith("@")) s = s.slice(1).trim();

  if (!/^https?:\/\//i.test(s)) {
    if (/^(www\.)?fomo\.family\//i.test(s)) s = "https://" + s;
    else if (/^[A-Za-z0-9_.-]{2,40}$/.test(s)) {
      s = "https://fomo.family/r/" + s;
    } else return null;
  }

  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  if (host !== "fomo.family" && host !== "app.fomo.family") return null;

  const parts = url.pathname.split("/").filter(Boolean);
  if (!parts.length) return null;

  let handle = parts[0];
  if (handle.toLowerCase() === "r" && parts[1]) handle = parts[1];
  handle = handle.replace(/^@/, "");
  if (!/^[A-Za-z0-9_.-]{2,40}$/.test(handle)) return null;

  return `https://fomo.family/r/${handle}`;
}

function isFomoFollowerService(svc) {
  if (!svc) return false;
  const cat = String(svc.category || "").toLowerCase();
  const name = String(svc.name || "").toLowerCase();
  if (!cat.includes("fomo") && !name.includes("fomo")) return false;
  if (name.includes("like") && !name.includes("follower")) return false;
  if (name.includes("view") || name.includes("comment")) return false;
  return (
    name.includes("follower") ||
    cat.includes("follower") ||
    cat.includes("fomo")
  );
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
    house: Boolean(s.house),
    demo: Boolean(s.demo),
    badge: s.badge || null,
    blurb: s.blurb || null,
    speedPerHour: Number(s.speedPerHour) || null,
    featured: Boolean(s.featured),
    estimate: Boolean(s.estimate),
  };
}

function filterFollowerServices(list) {
  const rows = Array.isArray(list) ? list : [];
  const fromJap = rows
    .filter(isFomoFollowerService)
    .map(mapService)
    .filter(Boolean);
  const house = HOUSE_SERVICES.map(mapService);
  const seen = new Set();
  return [...house, ...fromJap]
    .filter((s) => {
      if (seen.has(s.service)) return false;
      seen.add(s.service);
      return true;
    })
    .sort((a, b) => Number(a.rate) - Number(b.rate));
}

/** Find house or JAP service by id. */
function findServiceById(list, serviceId) {
  const id = Number(serviceId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const house = getHouseService(id);
  if (house) return mapService(house);
  const rows = Array.isArray(list) ? list : [];
  const raw = rows.find((s) => Number(s.service) === id);
  if (raw) return mapService(raw);
  return fallbackService(id);
}

function pickCheapest(items) {
  const rows = Array.isArray(items) && items.length
    ? items
    : HOUSE_SERVICES.map(mapService);
  return rows.reduce((best, s) => {
    if (!best) return s;
    const br = Number(best.rate);
    const sr = Number(s.rate);
    if (!Number.isFinite(sr)) return best;
    if (!Number.isFinite(br)) return s;
    return sr < br ? s : best;
  }, null);
}

function ensureFomoStore(dbx) {
  if (!Array.isArray(dbx.fomoOrders)) dbx.fomoOrders = [];
  if (!dbx.settings) dbx.settings = {};
  if (dbx.settings.fomoServiceId == null || Number(dbx.settings.fomoServiceId) <= 0) {
    dbx.settings.fomoServiceId = defaultServiceId();
  }
  dbx.settings.fomoProfileUrl = SOLID_ACCOUNT.profileUrl;
}

function packPriceMenu(ratePer1k) {
  const rate = Number(ratePer1k);
  const qtys = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  return qtys.map((qty) => ({
    qty,
    cost: Number.isFinite(rate) ? (rate * qty) / 1000 : null,
  }));
}

/** Local house fill — first-party engine, no JAP. Speed is per hour. */
function advanceHouseOrder(order, nowMs = Date.now()) {
  if (!order || !order.house) return order;
  if (order.mode === "dry-run" || order.status === "simulated") return order;
  if (order.status === "completed" || order.status === "failed") return order;
  if (order.status === "undeliverable") return order;

  const qty = Math.max(0, Number(order.quantity) || 0);
  const svc = getHouseService(order.serviceId);
  const perHour = Number(svc?.speedPerHour) || 3600;
  const started = new Date(order.startedAt || order.at || nowMs).getTime();
  const elapsedSec = Math.max(0, (nowMs - started) / 1000);
  const delivered = Math.min(qty, Math.floor((elapsedSec * perHour) / 3600));
  const remains = Math.max(0, qty - delivered);

  order.remains = remains;
  order.startCount =
    order.startCount != null ? order.startCount : SOLID_ACCOUNT.followers;
  if (remains <= 0) {
    order.status = "completed";
    order.remains = 0;
    order.completedAt = new Date(nowMs).toISOString();
  } else {
    order.status = "in progress";
  }
  order.japStatusAt = new Date(nowMs).toISOString();
  return order;
}

function tickHouseOrders(dbx, nowMs = Date.now()) {
  ensureFomoStore(dbx);
  let touched = 0;
  for (const order of dbx.fomoOrders) {
    if (!order.house) continue;
    if (order.mode === "dry-run" || order.status === "simulated") continue;
    if (order.status === "completed" || order.status === "failed") continue;
    if (order.status === "undeliverable") continue;
    const before = order.remains;
    const beforeStatus = order.status;
    advanceHouseOrder(order, nowMs);
    if (order.remains !== before || order.status !== beforeStatus) touched += 1;
  }
  return touched;
}

/** Revive house orders parked as undeliverable during the demo block. */
function reviveHouseOrders(dbx) {
  ensureFomoStore(dbx);
  for (const order of dbx.fomoOrders) {
    if (!order.house) continue;
    if (order.status !== "undeliverable") continue;
    delete order.demo;
    delete order.demoNote;
    delete order.error;
    delete order.deliveredToFomo;
    if (order.mode === "dry-run") {
      order.status = "simulated";
      order.remains = order.quantity;
      continue;
    }
    order.mode = "live";
    order.status = "in progress";
    order.startedAt = order.startedAt || order.at || new Date().toISOString();
    if (!order.japOrderId || String(order.japOrderId).startsWith("DEMO_")) {
      order.japOrderId = `HOUSE_FM_${Date.now()}`;
    }
    advanceHouseOrder(order, Date.now());
  }
}

/** Alias kept for older callers — now revives instead of blocking. */
function markLegacyHouseOrders(dbx) {
  reviveHouseOrders(dbx);
}

/** Desk follower count = base + completed + in-progress delivered. */
function accountSnapshot(dbData) {
  ensureFomoStore(dbData);
  let gained = 0;
  for (const o of dbData.fomoOrders) {
    if (!o.house || o.mode !== "live") continue;
    const st = String(o.status || "").toLowerCase();
    if (st === "undeliverable" || st === "failed" || st === "canceled") continue;
    if (o.mode === "dry-run") continue;
    const qty = Math.max(0, Number(o.quantity) || 0);
    if (st === "completed" || st === "complete") {
      gained += qty;
      continue;
    }
    const remains =
      o.remains != null && Number.isFinite(Number(o.remains))
        ? Math.max(0, Number(o.remains))
        : qty;
    gained += Math.max(0, qty - remains);
  }
  return {
    ...SOLID_ACCOUNT,
    followers: SOLID_ACCOUNT.followers + gained,
  };
}

function orderProgress(order) {
  const qty = Math.max(0, Number(order.quantity) || 0);
  const status = String(order.status || "").toLowerCase();
  const remainsRaw = order.remains;
  const hasRemains =
    remainsRaw != null && remainsRaw !== "" && Number.isFinite(Number(remainsRaw));
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

  if (status === "undeliverable") {
    return {
      qty,
      delivered: 0,
      remains: qty,
      pct: 0,
      label: "blocked",
      phase: "failed",
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

function listFomoOrders(dbData, query = {}) {
  ensureFomoStore(dbData);
  const now = Date.now();
  for (const o of dbData.fomoOrders) {
    if (o.house && o.mode !== "dry-run") advanceHouseOrder(o, now);
  }
  const limit = Math.min(
    MAX_ORDERS,
    Math.max(1, Number(query.limit) || MAX_ORDERS)
  );
  let items = [...dbData.fomoOrders];
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

function displayHandle(link) {
  const n = normalizeProfileUrl(link);
  if (!n) return link || "—";
  return "@" + n.replace(/^https:\/\/fomo\.family\/r\//i, "");
}

module.exports = {
  MAX_ORDERS,
  DEFAULT_SERVICE_ID,
  FALLBACK_SERVICES,
  HOUSE_SERVICES,
  SOLID_ACCOUNT,
  estimateRatePer1k,
  packPriceMenu,
  isHouseServiceId,
  getHouseService,
  defaultServiceId,
  fallbackService,
  defaultProfileUrl,
  normalizeProfileUrl,
  filterFollowerServices,
  findServiceById,
  pickCheapest,
  mapService,
  orderProgress,
  ensureFomoStore,
  listFomoOrders,
  applyJapStatus,
  displayHandle,
  advanceHouseOrder,
  tickHouseOrders,
  markLegacyHouseOrders,
  reviveHouseOrders,
  accountSnapshot,
};
