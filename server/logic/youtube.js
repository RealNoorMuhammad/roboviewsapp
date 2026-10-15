/**
 * YouTube tasks via JustAnotherPanel — views, likes, subs, comments, shares.
 * Separate from Telegram view drips / X / IG.
 */

const MAX_ORDERS = 500;

/** Task lanes the YouTube desk exposes. */
const TASK_TYPES = [
  {
    id: "views",
    label: "Views",
    short: "Views",
    blurb: "Push watch count on a video",
    linkKind: "video",
    unit: "views",
    icon: "V",
    keywords: ["views", "view"],
    exclude: ["live stream", "livestream", "shorts views", "hour", "watch time"],
    envKey: "JAP_YOUTUBE_VIEWS_SERVICE_ID",
    defaultServiceId: 3072,
    fallbackRate: "0.85",
    fallbackMin: 100,
    fallbackMax: 10000000,
    packQtys: [500, 1000, 2500, 5000, 10000, 25000, 50000, 100000],
  },
  {
    id: "likes",
    label: "Likes",
    short: "Likes",
    blurb: "Add likes on a video",
    linkKind: "video",
    unit: "likes",
    icon: "L",
    keywords: ["likes", "like"],
    exclude: ["dislike"],
    envKey: "JAP_YOUTUBE_LIKES_SERVICE_ID",
    defaultServiceId: 3073,
    fallbackRate: "1.20",
    fallbackMin: 50,
    fallbackMax: 500000,
    packQtys: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
  },
  {
    id: "subscribers",
    label: "Subscribers",
    short: "Subs",
    blurb: "Grow channel subscribers",
    linkKind: "channel",
    unit: "subs",
    icon: "S",
    keywords: ["subscribers", "subscriber", "subs"],
    exclude: ["views", "likes", "comment"],
    envKey: "JAP_YOUTUBE_SUBS_SERVICE_ID",
    defaultServiceId: 3074,
    fallbackRate: "3.50",
    fallbackMin: 10,
    fallbackMax: 100000,
    packQtys: [10, 25, 50, 100, 250, 500, 1000, 2500],
  },
  {
    id: "comments",
    label: "Comments",
    short: "Comments",
    blurb: "Custom or random comments",
    linkKind: "video",
    unit: "comments",
    icon: "C",
    keywords: ["comments", "comment"],
    exclude: ["likes", "views", "subscriber"],
    envKey: "JAP_YOUTUBE_COMMENTS_SERVICE_ID",
    defaultServiceId: 3075,
    fallbackRate: "4.00",
    fallbackMin: 5,
    fallbackMax: 10000,
    packQtys: [5, 10, 25, 50, 100, 250, 500, 1000],
  },
  {
    id: "shares",
    label: "Shares",
    short: "Shares",
    blurb: "Share / social push signals",
    linkKind: "video",
    unit: "shares",
    icon: "Sh",
    keywords: ["shares", "share"],
    exclude: ["views", "likes", "subscriber", "comment"],
    envKey: "JAP_YOUTUBE_SHARES_SERVICE_ID",
    defaultServiceId: 3076,
    fallbackRate: "1.80",
    fallbackMin: 50,
    fallbackMax: 100000,
    packQtys: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
  },
];

const DEFAULT_TASK = "subscribers";

/** Locked solid channel — always the home target on /youtube */
const SOLID_ACCOUNT = {
  handle: "ognoormuhammad8951",
  displayName: "Og Noor Muhammad",
  profileUrl: "https://www.youtube.com/@ognoormuhammad8951",
  initials: "ON",
  locked: true,
  blurb: "Solid lane · views · likes · subs · comments · shares",
};

function taskDef(taskId) {
  return (
    TASK_TYPES.find((t) => t.id === String(taskId || "").toLowerCase()) ||
    TASK_TYPES.find((t) => t.id === DEFAULT_TASK)
  );
}

function defaultServiceId(taskId) {
  const t = taskDef(taskId);
  const fromEnv = Number(process.env[t.envKey] || 0);
  if (fromEnv > 0) return fromEnv;
  return t.defaultServiceId;
}

function buildFallback(task) {
  return {
    service: task.defaultServiceId,
    name: `YouTube ${task.label} [Fallback] [Start: 0-1 Hr]`,
    category: `YouTube ${task.label}`,
    rate: String(task.fallbackRate),
    min: task.fallbackMin,
    max: task.fallbackMax,
    type: "Default",
    task: task.id,
    estimate: true,
  };
}

const FALLBACK_SERVICES = TASK_TYPES.map(buildFallback);

function fallbackService(serviceId, taskId) {
  const id = Number(serviceId);
  const byId = FALLBACK_SERVICES.find((s) => s.service === id);
  if (byId) return { ...byId };
  const t = taskDef(taskId);
  return {
    ...buildFallback(t),
    service: id > 0 ? id : t.defaultServiceId,
    name: `YouTube ${t.label} (service #${id > 0 ? id : t.defaultServiceId})`,
  };
}

function defaultLinkUrl() {
  const raw = String(
    process.env.YOUTUBE_DEFAULT_URL || SOLID_ACCOUNT.profileUrl
  ).trim();
  return normalizeYoutubeUrl(raw) || SOLID_ACCOUNT.profileUrl;
}

function defaultChannelUrl() {
  return SOLID_ACCOUNT.profileUrl;
}

/**
 * Accept watch URLs, youtu.be, shorts, channel / @handle /c/ /user/
 * → canonical https://www.youtube.com/...
 */
function normalizeYoutubeUrl(input, preferredKind) {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;

  if (s.startsWith("@") && !/^https?:\/\//i.test(s)) {
    s = "https://www.youtube.com/" + s;
  }
  if (!/^https?:\/\//i.test(s)) {
    if (/^(www\.)?youtube\.com\//i.test(s) || /^youtu\.be\//i.test(s)) {
      s = "https://" + s.replace(/^\/\//, "");
    } else if (/^[A-Za-z0-9_-]{11}$/.test(s)) {
      s = "https://www.youtube.com/watch?v=" + s;
    } else if (/^[A-Za-z0-9._-]{3,}$/.test(s)) {
      s = "https://www.youtube.com/@" + s.replace(/^@/, "");
    } else {
      return null;
    }
  }

  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  if (host !== "youtube.com" && host !== "youtu.be" && host !== "m.youtube.com") {
    return null;
  }

  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0];
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    return `https://www.youtube.com/watch?v=${id}`;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const v = url.searchParams.get("v");
  if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) {
    return `https://www.youtube.com/watch?v=${v}`;
  }
  if (parts[0] === "watch" && v && /^[A-Za-z0-9_-]{11}$/.test(v)) {
    return `https://www.youtube.com/watch?v=${v}`;
  }
  if (parts[0] === "shorts" && parts[1] && /^[A-Za-z0-9_-]{11}$/.test(parts[1])) {
    return `https://www.youtube.com/watch?v=${parts[1]}`;
  }
  if (parts[0] === "embed" && parts[1] && /^[A-Za-z0-9_-]{11}$/.test(parts[1])) {
    return `https://www.youtube.com/watch?v=${parts[1]}`;
  }
  if (parts[0] && parts[0].startsWith("@")) {
    return `https://www.youtube.com/${parts[0]}`;
  }
  if (parts[0] === "channel" && parts[1]) {
    return `https://www.youtube.com/channel/${parts[1]}`;
  }
  if ((parts[0] === "c" || parts[0] === "user") && parts[1]) {
    return `https://www.youtube.com/${parts[0]}/${parts[1]}`;
  }

  // If caller prefers channel and we only got a video, still return video
  // (UI will prompt). Prefer returning whatever valid YT URL we parsed.
  if (preferredKind === "channel" && parts.length) {
    return `https://www.youtube.com/${parts.join("/")}`;
  }

  return null;
}

function linkKindOf(url) {
  const u = String(url || "");
  if (/\/watch\?v=|youtu\.be\/|\/shorts\//i.test(u)) return "video";
  if (/\/@|\/channel\/|\/c\/|\/user\//i.test(u)) return "channel";
  return "unknown";
}

function mapService(s, taskId) {
  if (!s) return null;
  return {
    service: Number(s.service),
    name: s.name,
    category: s.category,
    rate: s.rate,
    min: Number(s.min) || 1,
    max: Number(s.max) || 0,
    type: s.type,
    task: taskId || s.task || null,
    estimate: !!s.estimate,
  };
}

function textHay(svc) {
  return `${svc.category || ""} ${svc.name || ""}`.toLowerCase();
}

function isYoutubeService(svc) {
  if (!svc) return false;
  const hay = textHay(svc);
  return hay.includes("youtube") || hay.includes("yt ");
}

function matchesTask(svc, task) {
  if (!svc || !task) return false;
  if (!isYoutubeService(svc)) return false;
  const hay = textHay(svc);
  if ((task.exclude || []).some((ex) => hay.includes(ex))) return false;
  return (task.keywords || []).some((kw) => {
    const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    return re.test(hay);
  });
}

function filterServicesForTask(list, taskId) {
  const task = taskDef(taskId);
  const rows = Array.isArray(list) ? list : [];
  const matched = rows
    .filter((s) => matchesTask(s, task))
    .map((s) => mapService(s, task.id))
    .filter(Boolean)
    .sort((a, b) => Number(a.rate) - Number(b.rate));

  if (matched.length) return matched;
  return [mapService(buildFallback(task), task.id)];
}

function pickCheapest(items) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return null;
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
    /start\s*time:\s*0\s*-\s*1/.test(n)
  );
}

function pickInstantCheap(items) {
  const rows = (Array.isArray(items) ? items : []).filter(isInstantService);
  if (!rows.length) return pickCheapest(items);
  return pickCheapest(rows);
}

function estCost(svc, qty) {
  if (!svc || !qty) return null;
  const rate = Number(svc.rate);
  if (!Number.isFinite(rate)) return null;
  return (rate * qty) / 1000;
}

/**
 * Build the desk menu: one card per task with cheapest rate + pack quotes.
 */
function buildTaskMenu(catalog) {
  const list = Array.isArray(catalog) ? catalog : [];
  return TASK_TYPES.map((task) => {
    const items = filterServicesForTask(list, task.id);
    const cheapest = pickCheapest(items) || mapService(buildFallback(task), task.id);
    const instant = pickInstantCheap(items) || cheapest;
    const packs = (task.packQtys || [])
      .filter((q) => {
        const min = Number(cheapest.min) || 1;
        const max = Number(cheapest.max) || Infinity;
        return q >= min && q <= max;
      })
      .map((qty) => ({
        qty,
        cost: estCost(cheapest, qty),
      }));

    return {
      id: task.id,
      label: task.label,
      short: task.short,
      blurb: task.blurb,
      linkKind: task.linkKind,
      unit: task.unit,
      icon: task.icon,
      serviceCount: items.filter((s) => !s.estimate).length || items.length,
      cheapest,
      instant,
      packs,
      ratePer1k: cheapest ? Number(cheapest.rate) : null,
      defaultServiceId: defaultServiceId(task.id),
    };
  });
}

function ensureYoutubeStore(dbx) {
  if (!Array.isArray(dbx.youtubeOrders)) dbx.youtubeOrders = [];
  if (!dbx.settings) dbx.settings = {};
  if (dbx.settings.youtubeTask == null) {
    dbx.settings.youtubeTask = DEFAULT_TASK;
  }
  if (dbx.settings.youtubeServiceId == null) {
    dbx.settings.youtubeServiceId = defaultServiceId(
      dbx.settings.youtubeTask || DEFAULT_TASK
    );
  }
  // Always keep the solid channel as the locked home target
  dbx.settings.youtubeChannelUrl = SOLID_ACCOUNT.profileUrl;
  if (
    dbx.settings.youtubeLinkUrl == null ||
    /dQw4w9WgXcQ/i.test(String(dbx.settings.youtubeLinkUrl))
  ) {
    dbx.settings.youtubeLinkUrl = SOLID_ACCOUNT.profileUrl;
  }
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

function listYoutubeOrders(dbData, query = {}) {
  ensureYoutubeStore(dbData);
  const limit = Math.min(
    MAX_ORDERS,
    Math.max(1, Number(query.limit) || MAX_ORDERS)
  );
  let items = [...dbData.youtubeOrders];
  const mode = query.mode ? String(query.mode).toLowerCase() : null;
  const status = query.status ? String(query.status).toLowerCase() : null;
  const task = query.task ? String(query.task).toLowerCase() : null;
  const search = query.q ? String(query.q).trim().toLowerCase() : null;

  if (mode) items = items.filter((o) => (o.mode || "").toLowerCase() === mode);
  if (status)
    items = items.filter((o) => (o.status || "").toLowerCase() === status);
  if (task) items = items.filter((o) => (o.task || "").toLowerCase() === task);
  if (search) {
    items = items.filter((o) => {
      const hay = [o.link, o.japOrderId, o.id, o.status, o.mode, o.serviceId, o.task]
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
    estCost: estCost(
      { rate: o.rate },
      o.quantity
    ),
  }));

  const units = page.reduce((n, o) => n + (Number(o.quantity) || 0), 0);
  const spend = page.reduce((n, o) => {
    const c = Number(o.charge);
    if (Number.isFinite(c)) return n + c;
    const est = estCost({ rate: o.rate }, o.quantity);
    return n + (est || 0);
  }, 0);
  const live = page.filter((o) => o.mode === "live").length;
  const dry = page.filter((o) => o.mode !== "live").length;
  const active = page.filter(
    (o) =>
      o.mode === "live" &&
      o.progress &&
      (o.progress.phase === "pending" || o.progress.phase === "filling")
  ).length;

  const byTask = {};
  for (const t of TASK_TYPES) {
    const rows = page.filter((o) => o.task === t.id);
    byTask[t.id] = {
      orders: rows.length,
      units: rows.reduce((n, o) => n + (Number(o.quantity) || 0), 0),
    };
  }

  return {
    items: page,
    total,
    summary: {
      orders: total,
      units,
      spend,
      live,
      dry,
      active,
      byTask,
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
  TASK_TYPES,
  DEFAULT_TASK,
  SOLID_ACCOUNT,
  FALLBACK_SERVICES,
  taskDef,
  defaultServiceId,
  fallbackService,
  defaultLinkUrl,
  defaultChannelUrl,
  normalizeYoutubeUrl,
  linkKindOf,
  mapService,
  filterServicesForTask,
  pickCheapest,
  isInstantService,
  pickInstantCheap,
  estCost,
  buildTaskMenu,
  ensureYoutubeStore,
  orderProgress,
  listYoutubeOrders,
  applyJapStatus,
};
