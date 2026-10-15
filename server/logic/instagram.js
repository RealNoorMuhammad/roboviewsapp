/**
 * Instagram followers — slow organic drip via JustAnotherPanel.
 * Small staggered batches so growth looks natural (harder to flag).
 */

const MAX_ORDERS = 500;
const MAX_DRIPS = 100;
/** Low min so +5 batches are allowed. Guaranteed + 30D refill. */
const DEFAULT_SERVICE_ID = 352;

/**
 * Safe organic drip → 100 followers over ~6 hours.
 * Pattern: small first (+5 / 10m), then +20 / 20m window, then larger spaced batches.
 */
const ORGANIC_100_STEPS = [
  { afterMin: 10, qty: 5, label: "+5 · first 10 min" },
  { afterMin: 30, qty: 20, label: "+20 · next 20 min" },
  { afterMin: 90, qty: 25, label: "+25 · ~1.5 h" },
  { afterMin: 180, qty: 25, label: "+25 · ~3 h" },
  { afterMin: 360, qty: 25, label: "+25 · ~6 h" },
];

const FALLBACK_SERVICES = [
  {
    service: 352,
    name: "Instagram Followers [Refill: 30D] [Max: 1M] — drip-friendly (min 1)",
    category: "Instagram Followers [Guaranteed]",
    rate: "0.625",
    min: 1,
    max: 10000000,
    type: "Default",
  },
  {
    service: 3374,
    name: "Instagram Followers [SPAM ON] [Refill: 60D] — drip-friendly (min 1)",
    category: "Instagram Followers [Guaranteed]",
    rate: "0.5198",
    min: 1,
    max: 1000000,
    type: "Default",
  },
  {
    service: 720,
    name: "Instagram Followers [Refill: No] [Max: 250K]",
    category: "Instagram Followers [Not Guaranteed]",
    rate: "0.2125",
    min: 10,
    max: 250000,
    type: "Default",
  },
];

function defaultServiceId() {
  return Number(
    process.env.JAP_INSTAGRAM_FOLLOWERS_SERVICE_ID || DEFAULT_SERVICE_ID
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
    process.env.INSTAGRAM_PROFILE_URL || "https://www.instagram.com/Bancrypto__/"
  ).trim();
  return normalizeProfileUrl(raw) || "https://www.instagram.com/Bancrypto__/";
}

/**
 * Accept @user, user, instagram.com/user → https://www.instagram.com/user/
 */
function normalizeProfileUrl(input) {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;

  if (s.startsWith("@")) s = s.slice(1).trim();

  if (!/^https?:\/\//i.test(s)) {
    if (/^(www\.)?instagram\.com\//i.test(s)) s = "https://" + s;
    else if (/^[A-Za-z0-9._]{1,30}$/.test(s)) {
      s = "https://www.instagram.com/" + s + "/";
    } else return null;
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
  if (!parts.length) return null;
  const handle = parts[0].replace(/^@/, "");
  if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) return null;
  const reserved = new Set([
    "p",
    "reel",
    "reels",
    "stories",
    "explore",
    "accounts",
    "direct",
    "tv",
  ]);
  if (reserved.has(handle.toLowerCase())) return null;

  return `https://www.instagram.com/${handle}/`;
}

function isInstagramFollowerService(svc) {
  if (!svc) return false;
  const cat = String(svc.category || "").toLowerCase();
  const name = String(svc.name || "").toLowerCase();

  if (
    name.includes("like") ||
    name.includes("comment") ||
    name.includes("view") ||
    name.includes("story") ||
    name.includes("reel") ||
    name.includes("mention") ||
    name.includes("thread") ||
    name.includes("ai growth") ||
    name.includes("package") ||
    cat.includes("thread") ||
    cat.includes("mention") ||
    cat.includes("engagement")
  ) {
    return false;
  }

  const followerCat =
    cat.includes("instagram followers") ||
    (cat.includes("instagram") && cat.includes("follower"));
  const followerName =
    name.includes("instagram followers") ||
    (name.includes("followers") && cat.includes("instagram"));

  return followerCat || followerName;
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

function filterFollowerServices(list) {
  const rows = Array.isArray(list) ? list : [];
  return rows
    .filter(isInstagramFollowerService)
    .map(mapService)
    .filter(Boolean)
    .sort((a, b) => Number(a.rate) - Number(b.rate));
}

/** Scale ORGANIC_100 steps to any total (default 100). */
function buildOrganicPlan(total = 100) {
  const target = Math.max(5, Math.floor(Number(total) || 100));
  const baseTotal = ORGANIC_100_STEPS.reduce((s, x) => s + x.qty, 0);
  const raw = ORGANIC_100_STEPS.map((step) => ({
    afterMin: step.afterMin,
    qty: Math.max(1, Math.round((step.qty / baseTotal) * target)),
    label: step.label,
  }));

  // Fix rounding so sum === target
  let sum = raw.reduce((s, x) => s + x.qty, 0);
  let i = raw.length - 1;
  while (sum !== target && i >= 0) {
    if (sum > target && raw[i].qty > 1) {
      raw[i].qty -= 1;
      sum -= 1;
    } else if (sum < target) {
      raw[i].qty += 1;
      sum += 1;
    } else {
      i -= 1;
    }
  }

  return raw.map((step, idx) => ({
    ...step,
    label:
      idx === 0
        ? `+${step.qty} · first ${step.afterMin} min`
        : `+${step.qty} · at ${fmtDuration(step.afterMin)}`,
  }));
}

function fmtDuration(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function describeOrganicPlan(total = 100) {
  const steps = buildOrganicPlan(total);
  const last = steps[steps.length - 1];
  return {
    id: "organic_100",
    name: `Organic drip → ${steps.reduce((s, x) => s + x.qty, 0)}`,
    total: steps.reduce((s, x) => s + x.qty, 0),
    durationMin: last?.afterMin || 0,
    durationLabel: fmtDuration(last?.afterMin || 0),
    steps,
    note: "Slow staggered batches — looks more natural than dumping all at once",
  };
}

function buildDripSchedule(startMs, total = 100) {
  const steps = buildOrganicPlan(total);
  return steps.map((step, i) => {
    const atMs = startMs + step.afterMin * 60_000;
    return {
      seq: i + 1,
      phaseId: `ig_drip_${i + 1}`,
      qty: step.qty,
      label: step.label,
      afterMin: step.afterMin,
      atMs,
      at: new Date(atMs).toISOString(),
    };
  });
}

function ensureInstagramStore(dbx) {
  if (!Array.isArray(dbx.instagramOrders)) dbx.instagramOrders = [];
  if (!Array.isArray(dbx.instagramDrips)) dbx.instagramDrips = [];
  if (!dbx.settings) dbx.settings = {};
  if (dbx.settings.instagramServiceId == null) {
    dbx.settings.instagramServiceId = defaultServiceId();
  }
  if (dbx.settings.instagramProfileUrl == null) {
    dbx.settings.instagramProfileUrl = defaultProfileUrl();
  }
}

function createDripCampaign({
  link,
  serviceId,
  total = 100,
  note,
  serviceName,
  rate,
  startAt,
  uid,
} = {}) {
  const startMs = startAt ? new Date(startAt).getTime() : Date.now();
  if (!Number.isFinite(startMs)) throw new Error("Invalid startAt");

  const schedule = buildDripSchedule(startMs, total);
  const drops = schedule.map((d) => ({
    id: uid ? uid("igd") : `igd_${Date.now()}_${d.seq}`,
    seq: d.seq,
    phaseId: d.phaseId,
    qty: d.qty,
    label: d.label,
    afterMin: d.afterMin,
    at: d.at,
    atMs: d.atMs,
    status: "pending",
    japOrderId: null,
    orderId: null,
    error: null,
    sentAt: null,
  }));

  return {
    id: uid ? uid("igc") : `igc_${Date.now()}`,
    kind: "instagram_organic_drip",
    link,
    serviceId: Number(serviceId),
    serviceName: serviceName || null,
    rate: rate || null,
    totalPlanned: drops.reduce((s, d) => s + d.qty, 0),
    totalOrdered: 0,
    note: note ? String(note).slice(0, 120) : null,
    status: "active",
    startAt: new Date(startMs).toISOString(),
    createdAt: new Date().toISOString(),
    drops,
  };
}

function listInstagramDrips(dbData, query = {}) {
  ensureInstagramStore(dbData);
  let items = [...(dbData.instagramDrips || [])];
  const status = query.status ? String(query.status).toLowerCase() : null;
  if (status) {
    items = items.filter((d) => (d.status || "").toLowerCase() === status);
  }
  items.sort(
    (a, b) =>
      new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
  );
  const active = items.filter((d) => d.status === "active").length;
  const planned = items.reduce((n, d) => n + (Number(d.totalPlanned) || 0), 0);
  const ordered = items.reduce((n, d) => n + (Number(d.totalOrdered) || 0), 0);
  const pendingDrops = items.reduce(
    (n, d) =>
      n +
      (d.drops || []).filter(
        (x) => x.status === "pending" || x.status === "sending"
      ).length,
    0
  );
  return {
    items,
    summary: {
      campaigns: items.length,
      active,
      planned,
      ordered,
      pendingDrops,
    },
    plan: describeOrganicPlan(100),
  };
}

function listInstagramOrders(dbData, query = {}) {
  ensureInstagramStore(dbData);
  const limit = Math.min(
    MAX_ORDERS,
    Math.max(1, Number(query.limit) || MAX_ORDERS)
  );
  let items = [...dbData.instagramOrders];
  const mode = query.mode ? String(query.mode).toLowerCase() : null;
  const status = query.status ? String(query.status).toLowerCase() : null;
  const search = query.q ? String(query.q).trim().toLowerCase() : null;

  if (mode) items = items.filter((o) => (o.mode || "").toLowerCase() === mode);
  if (status)
    items = items.filter((o) => (o.status || "").toLowerCase() === status);
  if (search) {
    items = items.filter((o) => {
      const hay = [
        o.link,
        o.japOrderId,
        o.id,
        o.status,
        o.mode,
        o.serviceId,
        o.dripId,
        o.phaseId,
      ]
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
  const page = items.slice(0, limit);
  const followers = page.reduce((n, o) => n + (Number(o.quantity) || 0), 0);
  const live = page.filter((o) => o.mode === "live").length;
  const dry = page.filter((o) => o.mode !== "live").length;

  return {
    items: page,
    total,
    summary: {
      orders: total,
      followers,
      live,
      dry,
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

function validateDripAgainstService(svcMeta, plan) {
  if (!svcMeta || !plan?.steps?.length) return null;
  const min = Number(svcMeta.min) || 1;
  const max = Number(svcMeta.max) || Infinity;
  const bad = plan.steps.find((s) => s.qty < min || s.qty > max);
  if (!bad) return null;
  return `Service #${svcMeta.service} min ${min} / max ${max} — batch +${bad.qty} won't work. Pick a drip-friendly service (min ≤ ${Math.min(...plan.steps.map((s) => s.qty))}).`;
}

module.exports = {
  MAX_ORDERS,
  MAX_DRIPS,
  DEFAULT_SERVICE_ID,
  FALLBACK_SERVICES,
  ORGANIC_100_STEPS,
  defaultServiceId,
  fallbackService,
  defaultProfileUrl,
  normalizeProfileUrl,
  filterFollowerServices,
  mapService,
  ensureInstagramStore,
  listInstagramOrders,
  listInstagramDrips,
  createDripCampaign,
  buildOrganicPlan,
  buildDripSchedule,
  describeOrganicPlan,
  validateDripAgainstService,
  applyJapStatus,
  fmtDuration,
};
