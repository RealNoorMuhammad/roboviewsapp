/**
 * Drip flow schedules (per post).
 *
 * Flow 1: +56 instant → 17×+20 → 396 over 24h (18 orders)
 * Flow 2: +40 instant → 13×+20 → 300 over 24h (14 orders)
 * Flow 3: +66 instant → 34×+20 → 746 over 24h (35 orders)
 * Flow 4: +56 instant → 24×+20 → 536 over 24h — @bansyndicate
 * Flow 5: +36 instant → 21×+20 → 456 — manual / other channels
 * Flow Robo: +20 instant → 20×+20 → 420 over 24h — @robogems
 */

const ORDER_QTY = 20;
const DRIP_VIEWS = 20;
const DAILY_VIEWS = 0;
const DAILY_DAYS = 0;

/** Default / legacy Flow 1 constants (kept for older imports) */
const INSTANT_VIEWS = 56;

/** "0h 00m" → minutes from post start */
function parseMark(text) {
  const m = String(text).trim().match(/^(\d+)\s*h\s*(\d+)\s*m$/i);
  if (!m) throw new Error(`Bad timestamp: ${text}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Flow 1 — dense first 30m, then progressive slowdown through 24h.
 * Cumulative: 56 → 76 → … → 396
 */
const DAY1_MARKS = [
  "0h 00m",
  "0h 02m",
  "0h 05m",
  "0h 09m",
  "0h 14m",
  "0h 18m",
  "0h 24m",
  "0h 30m",
  "0h 42m",
  "0h 57m",
  "1h 15m",
  "1h 36m",
  "2h 27m",
  "3h 32m",
  "5h 32m",
  "8h 54m",
  "14h 18m",
  "24h 00m",
];

/**
 * Flow 2 — lighter open (+40), fewer mid stamps, same late tail.
 * Cumulative: 40 → 60 → … → 300
 */
const FLOW2_MARKS = [
  "0h 00m",
  "0h 02m",
  "0h 09m",
  "0h 18m",
  "0h 30m",
  "0h 57m",
  "1h 15m",
  "1h 36m",
  "2h 27m",
  "3h 32m",
  "5h 32m",
  "8h 54m",
  "14h 18m",
  "24h 00m",
];

/**
 * Flow 3 — denser 24h curve for @robogems.
 * Cumulative: 66 → 86 → … → 746
 */
const FLOW3_MARKS = [
  "0h 00m",
  "0h 02m",
  "0h 05m",
  "0h 09m",
  "0h 14m",
  "0h 18m",
  "0h 24m",
  "0h 30m",
  "0h 42m",
  "0h 57m",
  "1h 15m",
  "1h 36m",
  "2h 00m",
  "2h 27m",
  "2h 58m",
  "3h 32m",
  "4h 09m",
  "4h 49m",
  "5h 32m",
  "6h 18m",
  "7h 07m",
  "7h 59m",
  "8h 54m",
  "9h 52m",
  "10h 54m",
  "11h 59m",
  "13h 07m",
  "14h 18m",
  "15h 32m",
  "16h 49m",
  "18h 09m",
  "19h 32m",
  "20h 58m",
  "22h 27m",
  "24h 00m",
];

/**
 * Flow 4 — @bansyndicate.
 * +56 instant → 24× +20 through 24h → 536 total (25 orders).
 */
const FLOW4_STEPS = [
  { mark: "0h 00m", qty: 56 },
  { mark: "0h 03m", qty: 20 },
  { mark: "0h 07m", qty: 20 },
  { mark: "0h 13m", qty: 20 },
  { mark: "0h 20m", qty: 20 },
  { mark: "0h 32m", qty: 20 },
  { mark: "0h 45m", qty: 20 },
  { mark: "1h 15m", qty: 20 },
  { mark: "1h 50m", qty: 20 },
  { mark: "2h 30m", qty: 20 },
  { mark: "3h 15m", qty: 20 },
  { mark: "4h 05m", qty: 20 },
  { mark: "5h 00m", qty: 20 },
  { mark: "6h 00m", qty: 20 },
  { mark: "7h 05m", qty: 20 },
  { mark: "8h 15m", qty: 20 },
  { mark: "9h 30m", qty: 20 },
  { mark: "10h 50m", qty: 20 },
  { mark: "12h 15m", qty: 20 },
  { mark: "13h 45m", qty: 20 },
  { mark: "15h 20m", qty: 20 },
  { mark: "17h 00m", qty: 20 },
  { mark: "18h 45m", qty: 20 },
  { mark: "21h 00m", qty: 20 },
  { mark: "24h 00m", qty: 20 },
];

const FLOW4_MARKS = FLOW4_STEPS.map((s) => s.mark);

/**
 * Flow 5 — manual / other channels.
 * +36 instant → 21× +20 through 24h → 456 total (22 orders).
 */
const FLOW5_STEPS = [
  { mark: "0h 00m", qty: 36 },
  { mark: "0h 05m", qty: 20 },
  { mark: "0h 14m", qty: 20 },
  { mark: "0h 24m", qty: 20 },
  { mark: "0h 42m", qty: 20 },
  { mark: "1h 15m", qty: 20 },
  { mark: "2h 00m", qty: 20 },
  { mark: "2h 58m", qty: 20 },
  { mark: "4h 09m", qty: 20 },
  { mark: "5h 32m", qty: 20 },
  { mark: "7h 07m", qty: 20 },
  { mark: "8h 54m", qty: 20 },
  { mark: "10h 54m", qty: 20 },
  { mark: "13h 07m", qty: 20 },
  { mark: "14h 18m", qty: 20 },
  { mark: "15h 32m", qty: 20 },
  { mark: "16h 49m", qty: 20 },
  { mark: "18h 09m", qty: 20 },
  { mark: "19h 32m", qty: 20 },
  { mark: "20h 58m", qty: 20 },
  { mark: "22h 27m", qty: 20 },
  { mark: "24h 00m", qty: 20 },
];

const FLOW5_MARKS = FLOW5_STEPS.map((s) => s.mark);

/**
 * Flow Robo — @robogems.
 * +20 instant → 20× +20 through 24h → 420 total (21 orders).
 */
const FLOW_ROBO_STEPS = [
  { mark: "0h 00m", qty: 20 },
  { mark: "0h 03m", qty: 20 },
  { mark: "0h 07m", qty: 20 },
  { mark: "0h 15m", qty: 20 },
  { mark: "0h 35m", qty: 20 },
  { mark: "1h 15m", qty: 20 },
  { mark: "1h 50m", qty: 20 },
  { mark: "2h 30m", qty: 20 },
  { mark: "3h 15m", qty: 20 },
  { mark: "4h 30m", qty: 20 },
  { mark: "5h 50m", qty: 20 },
  { mark: "7h 20m", qty: 20 },
  { mark: "9h 00m", qty: 20 },
  { mark: "10h 50m", qty: 20 },
  { mark: "12h 45m", qty: 20 },
  { mark: "14h 45m", qty: 20 },
  { mark: "16h 45m", qty: 20 },
  { mark: "18h 40m", qty: 20 },
  { mark: "20h 30m", qty: 20 },
  { mark: "22h 15m", qty: 20 },
  { mark: "24h 00m", qty: 20 },
];

const FLOW_ROBO_MARKS = FLOW_ROBO_STEPS.map((s) => s.mark);

function normalizeSteps({ marks, steps, instantViews, dripViews = DRIP_VIEWS }) {
  if (Array.isArray(steps) && steps.length) {
    return steps.map((s, i) => {
      const mark = typeof s === "string" ? s : s.mark;
      const qty =
        typeof s === "object" && s != null && s.qty != null
          ? Number(s.qty)
          : i === 0
            ? instantViews
            : dripViews;
      return { mark, qty };
    });
  }
  return (marks || []).map((mark, i) => ({
    mark,
    qty: i === 0 ? instantViews : dripViews,
  }));
}

function buildFlowPlan({
  marks,
  steps,
  instantViews,
  dripViews = DRIP_VIEWS,
}) {
  const plan = [];
  const normalized = normalizeSteps({ marks, steps, instantViews, dripViews });

  for (let i = 0; i < normalized.length; i++) {
    const { mark, qty } = normalized[i];
    const tMin = parseMark(mark);
    plan.push({
      tMin,
      qty,
      phaseId: i === 0 ? "instant" : "day1",
      label: mark,
    });
  }

  for (let d = 1; d <= DAILY_DAYS; d++) {
    const tMin = 24 * 60 + d * 24 * 60;
    const h = Math.floor(tMin / 60);
    plan.push({
      tMin,
      qty: DAILY_VIEWS,
      phaseId: "longtail",
      label: `${h}h 00m · day+${d}`,
    });
  }

  return plan;
}

function makeFlowDef({
  id,
  name,
  marks,
  steps,
  instantViews,
  dripViews = DRIP_VIEWS,
  formula: formulaOverride,
}) {
  const normalized = normalizeSteps({ marks, steps, instantViews, dripViews });
  const plan = buildFlowPlan({
    marks,
    steps: normalized,
    instantViews,
    dripViews,
  });
  const resolvedMarks = normalized.map((s) => s.mark);
  const resolvedInstant = normalized[0]?.qty ?? instantViews;
  const dripCount = Math.max(0, normalized.length - 1);
  const dripViewsTotal = normalized.slice(1).reduce((s, x) => s + x.qty, 0);
  const longtailViews = DAILY_DAYS * DAILY_VIEWS;
  const totalViews = resolvedInstant + dripViewsTotal + longtailViews;
  const uniformDrip =
    dripCount > 0 &&
    normalized.slice(1).every((x) => x.qty === (normalized[1]?.qty ?? dripViews));
  const dripLabel = uniformDrip
    ? `${dripCount}× +${normalized[1]?.qty ?? dripViews}`
    : `${dripCount} drips (+${dripViewsTotal})`;
  return {
    id: String(id),
    name,
    marks: resolvedMarks,
    instantViews: resolvedInstant,
    dripViews,
    dripCount,
    longtailViews,
    totalViews,
    totalOrders: plan.length,
    plan,
    formula:
      formulaOverride ||
      `+${resolvedInstant} instant → ${dripLabel} through 24h → ${totalViews} total`,
  };
}

const FLOW_DEFS = {
  "1": makeFlowDef({
    id: "1",
    name: "Flow 1 · 396",
    marks: DAY1_MARKS,
    instantViews: 56,
  }),
  "2": makeFlowDef({
    id: "2",
    name: "Flow 2 · 300",
    marks: FLOW2_MARKS,
    instantViews: 40,
  }),
  "3": makeFlowDef({
    id: "3",
    name: "Flow 3 · 746",
    marks: FLOW3_MARKS,
    instantViews: 66,
  }),
  "4": makeFlowDef({
    id: "4",
    name: "Flow 4 · 536",
    steps: FLOW4_STEPS,
    instantViews: 56,
    formula: "+56 instant → 24× +20 through 24h → 536 total",
  }),
  "5": makeFlowDef({
    id: "5",
    name: "Flow 5 · 456",
    steps: FLOW5_STEPS,
    instantViews: 36,
    formula: "+36 instant → 21× +20 through 24h → 456 total",
  }),
  "6": makeFlowDef({
    id: "6",
    name: "Flow Robo · 420",
    steps: FLOW_ROBO_STEPS,
    instantViews: 20,
    formula: "+20 instant → 20× +20 through 24h → 420 total",
  }),
};

const DEFAULT_FLOW_ID = "1";

/** Channel → forced flow (auto + manual + sniffer). */
const CHANNEL_FLOW_MAP = {
  robogems: "6",
  bansyndicate: "4",
};

function normalizeChannelKey(raw) {
  return String(raw || "")
    .replace(/^@/, "")
    .replace(/^https?:\/\/t\.me\//i, "")
    .split(/[/?#]/)[0]
    .trim()
    .toLowerCase();
}

function channelFromLink(link) {
  const m = String(link || "").match(/t\.me\/([^/?#]+)/i);
  return m ? normalizeChannelKey(m[1]) : "";
}

function normalizeFlowId(raw) {
  const id = String(raw == null ? DEFAULT_FLOW_ID : raw).trim();
  return FLOW_DEFS[id] ? id : DEFAULT_FLOW_ID;
}

/**
 * Resolve flow for a channel. Mapped channels always win
 * (robogems→Flow Robo, bansyndicate→4). Others fall back to provided flow / default.
 */
function flowIdForChannel(username, fallback = DEFAULT_FLOW_ID) {
  const key = normalizeChannelKey(username);
  if (CHANNEL_FLOW_MAP[key]) return CHANNEL_FLOW_MAP[key];
  return normalizeFlowId(fallback);
}

function flowIdForLink(link, fallback = DEFAULT_FLOW_ID) {
  return flowIdForChannel(channelFromLink(link), fallback);
}

function getFlow(flowId) {
  return FLOW_DEFS[normalizeFlowId(flowId)];
}

function listFlows() {
  return Object.values(FLOW_DEFS).map((f) => ({
    id: f.id,
    name: f.name,
    instantViews: f.instantViews,
    dripViews: f.dripViews,
    dripCount: f.dripCount,
    totalViews: f.totalViews,
    totalOrders: f.totalOrders,
    formula: f.formula,
    marks: f.marks,
  }));
}

/** Legacy aliases — Flow 1 */
const FLOW = FLOW_DEFS["1"].plan;
const DRIP_COUNT = FLOW_DEFS["1"].dripCount;
const LONGTAIL_VIEWS = FLOW_DEFS["1"].longtailViews;
const TOTAL_VIEWS = FLOW_DEFS["1"].totalViews;
const TOTAL_ORDERS = FLOW_DEFS["1"].totalOrders;

const PHASES = [
  {
    id: "instant",
    durationSec: 1,
    views: INSTANT_VIEWS,
    maxGapSec: 0,
  },
  {
    id: "day1",
    durationSec: 24 * 3600,
    views: DRIP_COUNT * DRIP_VIEWS,
    maxGapSec: null,
  },
];

const CURVE = FLOW.map((p) => ({
  tMin: p.tMin,
  cumulative: null,
  id: p.phaseId,
  qty: p.qty,
  label: p.label,
}));

function buildSchedule(startMs, opts = {}) {
  const plan =
    opts.flow ||
    (opts.flowId != null ? getFlow(opts.flowId).plan : FLOW);
  let seq = 0;
  const drops = [];

  for (const step of plan) {
    seq += 1;
    drops.push({
      at: startMs + step.tMin * 60 * 1000,
      qty: step.qty,
      stageIndex:
        step.phaseId === "instant" ? 0 : step.phaseId === "day1" ? 1 : 2,
      stageLabel: step.label,
      phaseId: step.phaseId,
      seq,
      plannedRaw: step.qty,
      plannedRounded: step.qty,
      intervalSec: null,
      tMin: step.tMin,
      mark: step.label,
    });
  }

  return drops;
}

function fmtDur(min) {
  const m = Math.round(min);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

function humanInterval(sec) {
  if (sec == null || sec <= 0) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function describeCurve(opts = {}) {
  const flow = getFlow(opts.flowId);
  const drops = buildSchedule(0, { flow: flow.plan });
  const day1 = drops.filter(
    (d) => d.phaseId === "day1" || d.phaseId === "instant"
  );
  const tail = drops.filter((d) => d.phaseId === "longtail");
  const totalViews = drops.reduce((s, d) => s + d.qty, 0);
  const day1Views = day1.reduce((s, d) => s + d.qty, 0);
  const last = drops[drops.length - 1];

  const stages = [
    {
      label: `0h 00m · instant`,
      phaseId: "instant",
      rawNeeded: flow.instantViews,
      stageViews: flow.instantViews,
      orders: 1,
      intervalHuman: "same second",
    },
    {
      label: `+${flow.dripViews} each (front-loaded)`,
      phaseId: "day1",
      rawNeeded: flow.dripCount * flow.dripViews,
      stageViews: flow.dripCount * flow.dripViews,
      orders: flow.dripCount,
      intervalHuman: "dense early, then slower",
    },
  ];

  if (DAILY_DAYS > 0) {
    stages.push({
      label: `day+1 → day+${DAILY_DAYS} · +${DAILY_VIEWS}/day`,
      phaseId: "longtail",
      rawNeeded: flow.longtailViews,
      stageViews: flow.longtailViews,
      orders: DAILY_DAYS,
      intervalHuman: "every 24h",
    });
  }

  return {
    flowId: flow.id,
    flowName: flow.name,
    orderQty: flow.dripViews,
    instantViews: flow.instantViews,
    dripViews: flow.dripViews,
    dailyViews: DAILY_VIEWS,
    dailyDays: DAILY_DAYS,
    formula: flow.formula,
    totalOrders: drops.length,
    totalViews,
    day1Views,
    longtailViews: tail.reduce((s, d) => s + d.qty, 0),
    durationMin: last ? last.tMin : 0,
    durationHuman: last ? fmtDur(last.tMin) : "—",
    stages,
    flow: flow.plan.map((p) => ({
      mark: p.label,
      tMin: p.tMin,
      qty: p.qty,
      phase: p.phaseId,
    })),
    milestones: [
      { min: 0, paid: flow.instantViews },
      {
        min: 30,
        paid: drops
          .filter((d) => d.tMin <= 30)
          .reduce((s, d) => s + d.qty, 0),
      },
      {
        min: 60,
        paid: drops
          .filter((d) => d.tMin <= 60)
          .reduce((s, d) => s + d.qty, 0),
      },
      {
        min: 240,
        paid: drops
          .filter((d) => d.tMin <= 240)
          .reduce((s, d) => s + d.qty, 0),
      },
      { min: 1440, paid: day1Views },
    ],
  };
}

function describeInstantPack(opts = {}) {
  const flow = getFlow(opts.flowId);
  return {
    need: flow.instantViews,
    orders: 1,
    views: flow.instantViews,
    gapSec: 0,
    times: [{ time: "0:00", sec: 0, views: flow.instantViews }],
    note: `Instant +${flow.instantViews} fires on the next microtask when post is tracked (no worker delay)`,
  };
}

function describeEarlyTicker(seconds = 600, opts = {}) {
  const flow = getFlow(opts.flowId);
  const drops = buildSchedule(0, { flow: flow.plan }).filter(
    (d) => d.at <= seconds * 1000
  );
  return {
    windowSec: seconds,
    drops: drops.length,
    views: drops.reduce((s, d) => s + d.qty, 0),
    maxGapSec: null,
    sample: drops.slice(0, 80).map((d) => ({
      t: d.mark || fmtClock(d.at / 1000),
      qty: d.qty,
      phase: d.phaseId,
    })),
  };
}

function fmtClock(sec) {
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function intervalAt() {
  return null;
}

function intervalForGap() {
  return null;
}

module.exports = {
  ORDER_QTY,
  INSTANT_VIEWS,
  DRIP_VIEWS,
  DAILY_VIEWS,
  DAILY_DAYS,
  DAY1_MARKS,
  FLOW2_MARKS,
  FLOW3_MARKS,
  FLOW4_MARKS,
  FLOW4_STEPS,
  FLOW5_MARKS,
  FLOW5_STEPS,
  FLOW_ROBO_MARKS,
  FLOW_ROBO_STEPS,
  FLOW,
  FLOW_DEFS,
  CHANNEL_FLOW_MAP,
  DEFAULT_FLOW_ID,
  PHASES,
  CURVE,
  DRIP_COUNT,
  LONGTAIL_VIEWS,
  TOTAL_VIEWS,
  TOTAL_ORDERS,
  TARGET_VIEWS: TOTAL_VIEWS,
  TOTAL_DURATION_SEC: 24 * 3600,
  normalizeFlowId,
  flowIdForChannel,
  flowIdForLink,
  channelFromLink,
  getFlow,
  listFlows,
  buildSchedule,
  describeCurve,
  describeInstantPack,
  describeEarlyTicker,
  intervalAt,
  intervalForGap,
  fmtDur,
  humanInterval,
};
