/**
 * X / Twitter post engagement — likes and comments via JustAnotherPanel.
 * Separate from X follower orders and Telegram view drips.
 */

const MAX_ORDERS = 500;

const TASK_TYPES = [
  {
    id: "likes",
    label: "Likes",
    short: "Likes",
    blurb: "Boost likes on a tweet / post",
    unit: "likes",
    icon: "♥",
    keywords: ["likes", "like", "favorites", "favourite"],
    exclude: [
      "comment",
      "follower",
      "retweet",
      "repost",
      "view",
      "impression",
      "bookmark",
      "poll",
      "space",
    ],
    envKey: "JAP_TWITTER_LIKES_SERVICE_ID",
    defaultServiceId: 8847,
    fallbackRate: "0.35",
    fallbackMin: 50,
    fallbackMax: 50000,
    packQtys: [50, 100, 250, 500, 1000, 2500, 5000],
  },
  {
    id: "comments",
    label: "Comments",
    short: "Comments",
    blurb: "Custom lines (our type) or random replies",
    unit: "comments",
    icon: "💬",
    keywords: ["comments", "comment", "reply", "replies"],
    exclude: [
      "like",
      "follower",
      "retweet",
      "repost",
      "tweet views",
      "video views",
      "impression",
      "bookmark",
      "poll",
      "space",
      "package",
    ],
    envKey: "JAP_TWITTER_COMMENTS_SERVICE_ID",
    defaultServiceId: 341,
    fallbackRate: "25.00",
    fallbackMin: 3,
    fallbackMax: 1000,
    packQtys: [3, 5, 10, 25, 50, 100],
  },
];

const DEFAULT_TASK = "likes";

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
    name: `X ${task.label} [Fallback] [Start: 0-1 Hr]`,
    category: `X - Twitter ${task.label}`,
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
    name: `X ${t.label} (service #${id > 0 ? id : t.defaultServiceId})`,
  };
}

function defaultPostUrl() {
  const raw = String(process.env.TWITTER_POST_URL || "").trim();
  return normalizePostUrl(raw) || "";
}

/**
 * Accept x.com/user/status/ID or twitter.com/user/status/ID
 */
function normalizePostUrl(input) {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;

  if (!/^https?:\/\//i.test(s)) {
    if (/^(x|twitter)\.com\//i.test(s)) s = "https://" + s;
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
  const statusIdx = parts.findIndex((p) => p.toLowerCase() === "status");
  if (statusIdx < 0 || !parts[statusIdx + 1]) return null;

  const handle = parts[statusIdx - 1] || parts[0];
  const statusId = parts[statusIdx + 1].replace(/\D/g, "");
  if (!handle || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;
  if (!statusId || !/^\d{5,25}$/.test(statusId)) return null;

  return `https://x.com/${handle}/status/${statusId}`;
}

function mapService(s, taskId) {
  if (!s) return null;
  const mapped = {
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
  if ((taskId || s.task) === "comments") {
    mapped.commentKind = commentKind(mapped);
  }
  return mapped;
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
    /\bx\s*-\s*twitter\b/.test(hay) ||
    (hay.includes(" x ") && hay.includes("twitter"))
  );
}

function matchesTask(svc, task) {
  if (!svc || !task) return false;
  if (!isTwitterService(svc)) return false;
  // Match / exclude on the service NAME only. JAP dumps tweet views in
  // "X - Twitter Views / Live / Comments", which would hide every comment lane.
  const name = String(svc.name || "").toLowerCase();
  if ((task.exclude || []).some((ex) => name.includes(ex))) return false;
  return (task.keywords || []).some((kw) => {
    const re = new RegExp(
      `\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "i"
    );
    return re.test(name);
  });
}

function isCustomCommentService(svc) {
  if (!svc) return false;
  const type = String(svc.type || "").toLowerCase();
  const name = String(svc.name || "").toLowerCase();
  if (type.includes("package") || name.includes("package")) return false;
  if (type.includes("custom comment")) return true;
  return /\[custom\]/.test(name) || /custom comments/.test(name);
}

function isRandomCommentService(svc) {
  if (!svc || isCustomCommentService(svc)) return false;
  const name = String(svc.name || "").toLowerCase();
  return /\[random\]/.test(name) || /\brandom\b/.test(name);
}

function commentKind(svc) {
  if (isCustomCommentService(svc)) return "custom";
  if (isRandomCommentService(svc)) return "random";
  return "other";
}

function parseCommentLines(input) {
  if (input == null) return [];
  return String(input)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function commentsParam(lines) {
  const rows = Array.isArray(lines) ? lines : parseCommentLines(lines);
  return rows.join("\n");
}

/** Repeat unique lines until quantity is met (JAP custom comments). */
function expandCommentLines(lines, quantity) {
  const src = Array.isArray(lines)
    ? lines.map((l) => String(l).trim()).filter(Boolean)
    : parseCommentLines(lines);
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  if (!src.length || !qty) return src;
  if (src.length >= qty) return src.slice(0, qty);
  const out = [];
  for (let i = 0; i < qty; i++) out.push(src[i % src.length]);
  return out;
}

function pickOurTypeComments(items) {
  const rows = Array.isArray(items) ? items : [];
  const custom = rows.filter(isCustomCommentService);
  const crypto = custom.filter((s) => /crypto/i.test(String(s.name || "")));
  return pickCheapest(crypto) || pickCheapest(custom) || pickCheapest(rows);
}

function filterServicesForTask(list, taskId, opts = {}) {
  const task = taskDef(taskId);
  const rows = Array.isArray(list) ? list : [];
  let matched = rows
    .filter((s) => matchesTask(s, task))
    .map((s) => mapService(s, task.id))
    .filter(Boolean)
    .sort((a, b) => Number(a.rate) - Number(b.rate));

  if (task.id === "comments") {
    const style = String(opts.commentStyle || "").toLowerCase();
    if (style === "custom") {
      const custom = matched.filter(isCustomCommentService);
      if (custom.length) matched = custom;
    } else if (style === "random") {
      const random = matched.filter(isRandomCommentService);
      if (random.length) matched = random;
    }
  }

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

function buildTaskMenu(catalog) {
  const list = Array.isArray(catalog) ? catalog : [];
  return TASK_TYPES.map((task) => {
    const items = filterServicesForTask(list, task.id, {
      commentStyle: task.id === "comments" ? "custom" : null,
    });
    const cheapest =
      (task.id === "comments"
        ? pickOurTypeComments(items) || pickCheapest(items)
        : pickCheapest(items)) || mapService(buildFallback(task), task.id);
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
      unit: task.unit,
      icon: task.icon,
      serviceCount: items.filter((s) => !s.estimate).length || items.length,
      cheapest,
      instant,
      packs,
      ratePer1k: cheapest ? Number(cheapest.rate) : null,
      defaultServiceId: defaultServiceId(task.id),
      commentStyle: task.id === "comments" ? "custom" : null,
    };
  });
}

function ensureTwitterPostsStore(dbx) {
  if (!Array.isArray(dbx.twitterPostOrders)) dbx.twitterPostOrders = [];
  if (!dbx.settings) dbx.settings = {};
  if (dbx.settings.twitterPostTask == null) {
    dbx.settings.twitterPostTask = DEFAULT_TASK;
  }
  if (dbx.settings.twitterPostServiceId == null) {
    dbx.settings.twitterPostServiceId = defaultServiceId(
      dbx.settings.twitterPostTask || DEFAULT_TASK
    );
  }
  if (dbx.settings.twitterPostUrl == null) {
    dbx.settings.twitterPostUrl = defaultPostUrl();
  }
  if (dbx.settings.twitterPostCommentStyle == null) {
    dbx.settings.twitterPostCommentStyle = "custom";
  }
  if (dbx.settings.twitterPostComments == null) {
    dbx.settings.twitterPostComments = "";
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

function listTwitterPostOrders(dbData, query = {}) {
  ensureTwitterPostsStore(dbData);
  const limit = Math.min(
    MAX_ORDERS,
    Math.max(1, Number(query.limit) || MAX_ORDERS)
  );
  let items = [...dbData.twitterPostOrders];
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
      const hay = [
        o.link,
        o.japOrderId,
        o.id,
        o.status,
        o.mode,
        o.serviceId,
        o.task,
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
  const page = items.slice(0, limit).map((o) => ({
    ...o,
    progress: orderProgress(o),
  }));

  const units = page.reduce((n, o) => n + (Number(o.quantity) || 0), 0);
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
  FALLBACK_SERVICES,
  taskDef,
  defaultServiceId,
  fallbackService,
  defaultPostUrl,
  normalizePostUrl,
  mapService,
  filterServicesForTask,
  isCustomCommentService,
  isRandomCommentService,
  commentKind,
  parseCommentLines,
  commentsParam,
  expandCommentLines,
  pickOurTypeComments,
  pickCheapest,
  isInstantService,
  pickInstantCheap,
  estCost,
  buildTaskMenu,
  ensureTwitterPostsStore,
  orderProgress,
  listTwitterPostOrders,
  applyJapStatus,
};
