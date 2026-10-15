/**
 * LinkedIn followers — slow organic drip via JustAnotherPanel.
 * Pulse pattern: +10 every 5 min, then +5 every 3 min, repeat → up to 500.
 * Separate flows: 100 · 200 · 300 · 400 · 500
 */

const MAX_ORDERS = 500;
const MAX_DRIPS = 100;
/** Drip-friendly default — override with JAP_LINKEDIN_FOLLOWERS_SERVICE_ID */
const DEFAULT_SERVICE_ID = 4223;

/** Pack / flow totals shown on the desk */
const FLOW_TOTALS = [100, 200, 300, 400, 500];

/**
 * Pulse lanes:
 *   +10 after a 5-minute wait
 *   +5  after a 3-minute wait
 * Repeat until target is filled.
 */
const PULSE_A = { gapMin: 5, qty: 10 };
const PULSE_B = { gapMin: 3, qty: 5 };

const FALLBACK_SERVICES = [
  {
    service: 4223,
    name: "LinkedIn Followers [Refill: 30D] — drip-friendly (min 1)",
    category: "LinkedIn Followers",
    rate: "2.50",
    min: 1,
    max: 100000,
    type: "Default",
  },
  {
    service: 4224,
    name: "LinkedIn Followers [Refill: No] [Max: 50K]",
    category: "LinkedIn Followers",
    rate: "1.85",
    min: 10,
    max: 50000,
    type: "Default",
  },
  {
    service: 8462,
    name: "LinkedIn Followers [HQ] [Refill: 30D]",
    category: "LinkedIn Followers",
    rate: "3.40",
    min: 5,
    max: 25000,
    type: "Default",
  },
];

function defaultServiceId() {
  return Number(
    process.env.JAP_LINKEDIN_FOLLOWERS_SERVICE_ID || DEFAULT_SERVICE_ID
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
    process.env.LINKEDIN_PROFILE_URL ||
      "https://www.linkedin.com/in/example/"
  ).trim();
  return normalizeProfileUrl(raw) || "https://www.linkedin.com/in/example/";
}

/**
 * Accept linkedin.com/in/slug, /company/slug, full URL → canonical URL
 */
function normalizeProfileUrl(input) {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;

  if (!/^https?:\/\//i.test(s)) {
    if (/^(www\.)?linkedin\.com\//i.test(s)) s = "https://" + s;
    else if (/^[A-Za-z0-9\-_%]{2,100}$/.test(s)) {
      s = "https://www.linkedin.com/in/" + s + "/";
    } else return null;
  }

  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  if (host !== "linkedin.com") return null;

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;

  const kind = parts[0].toLowerCase();
  if (kind !== "in" && kind !== "company" && kind !== "school") return null;

  const slug = decodeURIComponent(parts[1]).replace(/\/+$/, "");
  if (!slug || slug.length < 2) return null;

  return `https://www.linkedin.com/${kind}/${encodeURIComponent(slug)}/`;
}

function isLinkedInFollowerService(svc) {
  if (!svc) return false;
  const cat = String(svc.category || "").toLowerCase();
  const name = String(svc.name || "").toLowerCase();

  if (
    name.includes("like") ||
    name.includes("comment") ||
    name.includes("view") ||
    name.includes("connection") ||
    name.includes("endorse") ||
    name.includes("reaction") ||
    name.includes("share") ||
    name.includes("post") ||
    name.includes("invite")
  ) {
    return false;
  }

  const followerCat =
    cat.includes("linkedin followers") ||
    (cat.includes("linkedin") && cat.includes("follower"));
  const followerName =
    name.includes("linkedin followers") ||
    (name.includes("followers") && cat.includes("linkedin"));

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
    .filter(isLinkedInFollowerService)
    .map(mapService)
    .filter(Boolean)
    .sort((a, b) => Number(a.rate) - Number(b.rate));
}

function fmtDuration(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Build +10/5m · +5/3m pulse steps until `total` followers.
 */
function buildPulseSteps(total = 100) {
  const target = Math.max(5, Math.floor(Number(total) || 100));
  const steps = [];
  let t = 0;
  let remaining = target;
  let useA = true;

  while (remaining > 0) {
    const lane = useA ? PULSE_A : PULSE_B;
    t += lane.gapMin;
    const qty = Math.min(lane.qty, remaining);
    steps.push({
      afterMin: t,
      qty,
      gapMin: lane.gapMin,
      laneQty: lane.qty,
      label: `+${qty} in ${lane.gapMin} min`,
    });
    remaining -= qty;
    useA = !useA;
  }

  return steps;
}

function describeFlow(total = 100) {
  const steps = buildPulseSteps(total);
  const sum = steps.reduce((s, x) => s + x.qty, 0);
  const last = steps[steps.length - 1];
  const id = String(sum);
  return {
    id,
    name: `Flow · ${sum}`,
    total: sum,
    durationMin: last?.afterMin || 0,
    durationLabel: fmtDuration(last?.afterMin || 0),
    steps,
    formula: `+10 in 5 min → +5 in 3 min → repeat → ${sum}`,
    note: "Slow LinkedIn pulse — looks more natural than dumping all at once",
  };
}

function listFlows() {
  return FLOW_TOTALS.map((t) => describeFlow(t));
}

function normalizeFlowTotal(raw) {
  const n = Math.floor(Number(raw));
  if (FLOW_TOTALS.includes(n)) return n;
  if (Number.isFinite(n) && n >= 5 && n <= 500) return n;
  return 100;
}

function packPriceMenu(ratePer1k) {
  const rate = Number(ratePer1k);
  return FLOW_TOTALS.map((qty) => ({
    qty,
    flowId: String(qty),
    name: `Flow · ${qty}`,
    cost:
      Number.isFinite(rate) && rate > 0
        ? Number(((rate * qty) / 1000).toFixed(4))
        : null,
    formula: `+10 / 5m · +5 / 3m → ${qty}`,
  }));
}

function buildDripSchedule(startMs, total = 100) {
  const steps = buildPulseSteps(total);
  return steps.map((step, i) => {
    const atMs = startMs + step.afterMin * 60_000;
    return {
      seq: i + 1,
      phaseId: `li_drip_${i + 1}`,
      qty: step.qty,
      label: step.label,
      afterMin: step.afterMin,
      gapMin: step.gapMin,
      atMs,
      at: new Date(atMs).toISOString(),
    };
  });
}

function ensureLinkedInStore(dbx) {
  if (!Array.isArray(dbx.linkedinOrders)) dbx.linkedinOrders = [];
  if (!Array.isArray(dbx.linkedinDrips)) dbx.linkedinDrips = [];
  if (!dbx.settings) dbx.settings = {};
  if (dbx.settings.linkedinServiceId == null) {
    dbx.settings.linkedinServiceId = defaultServiceId();
  }
  if (dbx.settings.linkedinProfileUrl == null) {
    dbx.settings.linkedinProfileUrl = defaultProfileUrl();
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

  const plan = describeFlow(total);
  const schedule = buildDripSchedule(startMs, plan.total);
  const drops = schedule.map((d) => ({
    id: uid ? uid("lid") : `lid_${Date.now()}_${d.seq}`,
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
    id: uid ? uid("lic") : `lic_${Date.now()}`,
    kind: "linkedin_organic_drip",
    flowId: plan.id,
    flowName: plan.name,
    formula: plan.formula,
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

function listLinkedInDrips(dbData, query = {}) {
  ensureLinkedInStore(dbData);
  let items = [...(dbData.linkedinDrips || [])];
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
    flows: listFlows(),
  };
}

function listLinkedInOrders(dbData, query = {}) {
  ensureLinkedInStore(dbData);
  const limit = Math.min(
    MAX_ORDERS,
    Math.max(1, Number(query.limit) || MAX_ORDERS)
  );
  let items = [...dbData.linkedinOrders];
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
  FLOW_TOTALS,
  FALLBACK_SERVICES,
  PULSE_A,
  PULSE_B,
  defaultServiceId,
  fallbackService,
  defaultProfileUrl,
  normalizeProfileUrl,
  filterFollowerServices,
  mapService,
  ensureLinkedInStore,
  listLinkedInOrders,
  listLinkedInDrips,
  createDripCampaign,
  buildPulseSteps,
  buildDripSchedule,
  describeFlow,
  listFlows,
  normalizeFlowTotal,
  packPriceMenu,
  validateDripAgainstService,
  applyJapStatus,
  fmtDuration,
};
