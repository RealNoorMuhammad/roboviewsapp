/**
 * Order list logic — query, enrich, summarize the +20 drip submissions.
 * Source of truth: db.orders (written by worker on each fire).
 */

const MAX_ORDERS = 2000;

/**
 * Normalize / validate list query from API.
 * limit=all | 0 | missing → return full filtered list (up to MAX_ORDERS).
 */
function parseListQuery(q = {}) {
  const rawLimit = q.limit;
  const wantsAll =
    rawLimit === undefined ||
    rawLimit === null ||
    rawLimit === "" ||
    String(rawLimit).toLowerCase() === "all" ||
    Number(rawLimit) === 0;
  const limit = wantsAll
    ? MAX_ORDERS
    : clampInt(rawLimit, 1, MAX_ORDERS, MAX_ORDERS);
  const offset = clampInt(q.offset, 0, 1_000_000, 0);
  const postId = q.postId ? String(q.postId) : null;
  const mode = q.mode ? String(q.mode).toLowerCase() : null; // live | dry-run
  const status = q.status ? String(q.status).toLowerCase() : null;
  const link = q.link ? String(q.link).trim() : null;
  const phaseId = q.phaseId ? String(q.phaseId) : null;
  const search = q.q ? String(q.q).trim().toLowerCase() : null;
  return { limit, offset, postId, mode, status, link, phaseId, search, wantsAll };
}

/**
 * Filter + page the order list.
 * @returns {{ items, total, limit, offset, hasMore, summary }}
 */
function listOrders(dbData, query = {}) {
  const opts = parseListQuery(query);
  const raw = Array.isArray(dbData.orders) ? dbData.orders : [];
  const postsById = indexPosts(dbData.posts);

  let items = raw.map((o) => enrichOrder(o, postsById));

  if (opts.postId) {
    items = items.filter((o) => o.postId === opts.postId);
  }
  if (opts.mode) {
    items = items.filter((o) => (o.mode || "").toLowerCase() === opts.mode);
  }
  if (opts.status) {
    items = items.filter((o) => (o.status || "").toLowerCase() === opts.status);
  }
  if (opts.link) {
    const needle = opts.link.toLowerCase();
    items = items.filter((o) => (o.link || "").toLowerCase().includes(needle));
  }
  if (opts.phaseId) {
    items = items.filter((o) => o.phaseId === opts.phaseId);
  }
  if (opts.search) {
    const s = opts.search;
    items = items.filter((o) => {
      const hay = [
        o.link,
        o.japOrderId,
        o.id,
        o.postId,
        o.phaseId,
        o.status,
        o.mode,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(s);
    });
  }

  // newest first (already stored unshift, but re-sort for safety)
  items.sort((a, b) => {
    const ta = new Date(a.at || 0).getTime();
    const tb = new Date(b.at || 0).getTime();
    return tb - ta;
  });

  const total = items.length;
  const page = items.slice(opts.offset, opts.offset + opts.limit);
  const summary = summarizeOrders(items);

  return {
    items: page,
    total,
    limit: opts.limit,
    offset: opts.offset,
    hasMore: opts.offset + opts.limit < total,
    summary,
  };
}

/**
 * Aggregate stats for a set of orders (usually filtered full set).
 */
function summarizeOrders(orders) {
  const list = Array.isArray(orders) ? orders : [];
  let live = 0;
  let dry = 0;
  let views = 0;
  let submitted = 0;
  let simulated = 0;
  let failed = 0;
  const byPost = new Map();
  const byPhase = new Map();
  const byStatus = new Map();

  for (const o of list) {
    const qty = Number(o.qty) || 0;
    views += qty;
    const mode = (o.mode || "").toLowerCase();
    if (mode === "live") live += 1;
    else dry += 1;

    const st = (o.status || "unknown").toLowerCase();
    if (st === "submitted") submitted += 1;
    else if (st === "simulated") simulated += 1;
    else if (st === "failed" || st === "error") failed += 1;
    byStatus.set(st, (byStatus.get(st) || 0) + 1);

    if (o.postId) {
      const prev = byPost.get(o.postId) || { count: 0, views: 0, link: o.link };
      prev.count += 1;
      prev.views += qty;
      byPost.set(o.postId, prev);
    }
    if (o.phaseId) {
      byPhase.set(o.phaseId, (byPhase.get(o.phaseId) || 0) + 1);
    }
  }

  return {
    total: list.length,
    views,
    live,
    dryRun: dry,
    submitted,
    simulated,
    failed,
    byStatus: Object.fromEntries(byStatus),
    byPhase: Object.fromEntries(byPhase),
    postsTouched: byPost.size,
    topPosts: [...byPost.entries()]
      .map(([postId, v]) => ({ postId, ...v }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 10),
  };
}

/**
 * Build a canonical order record for the worker to persist.
 */
function buildOrderRecord({
  uid,
  postId,
  dropId,
  link,
  qty,
  japOrderId,
  mode,
  serviceId,
  phaseId,
  seq,
  stageLabel,
  status,
}) {
  const live = mode === "live";
  return {
    id: uid,
    postId,
    dropId: dropId || null,
    link,
    qty: Number(qty) || 20,
    japOrderId: japOrderId ?? null,
    mode: live ? "live" : "dry-run",
    serviceId: serviceId != null ? Number(serviceId) : null,
    phaseId: phaseId || null,
    seq: seq != null ? Number(seq) : null,
    stageLabel: stageLabel || null,
    at: new Date().toISOString(),
    status: status || (live ? "submitted" : "simulated"),
    japStatus: null,
    japCharge: null,
    japRemains: null,
    checkedAt: null,
  };
}

/**
 * Keep orders array bounded (newest first).
 */
function capOrders(orders, max = MAX_ORDERS) {
  if (!Array.isArray(orders)) return [];
  return orders.slice(0, max);
}

/**
 * Enrich raw order with post title / drop phase if missing.
 */
function enrichOrder(order, postsById) {
  const o = { ...order };
  const post = o.postId ? postsById.get(o.postId) : null;
  if (post) {
    o.postTitle = post.title || null;
    o.postStatus = post.status || null;
    if ((!o.phaseId || !o.seq) && o.dropId && Array.isArray(post.drops)) {
      const drop = post.drops.find((d) => d.id === o.dropId);
      if (drop) {
        o.phaseId = o.phaseId || drop.phaseId || null;
        o.seq = o.seq ?? drop.seq ?? null;
        o.stageLabel = o.stageLabel || drop.stageLabel || null;
      }
    }
  }
  o.linkShort = shortLink(o.link);
  o.isLive = (o.mode || "").toLowerCase() === "live";
  return o;
}

function indexPosts(posts) {
  const map = new Map();
  for (const p of posts || []) map.set(p.id, p);
  return map;
}

function shortLink(link) {
  return String(link || "").replace(/^https?:\/\//i, "");
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Apply JAP status poll result onto an order object (mutates).
 */
function applyJapStatus(order, japData) {
  if (!order || !japData) return order;
  order.japStatus = japData.status || japData.order_status || null;
  order.japCharge = japData.charge != null ? String(japData.charge) : order.japCharge;
  order.japRemains =
    japData.remains != null ? String(japData.remains) : order.japRemains;
  if (japData.status) {
    const s = String(japData.status).toLowerCase();
    if (s.includes("complete") || s === "completed") order.status = "completed";
    else if (s.includes("cancel")) order.status = "canceled";
    else if (s.includes("partial")) order.status = "partial";
    else if (s.includes("progress") || s.includes("pending") || s.includes("processing"))
      order.status = "in_progress";
  }
  order.checkedAt = new Date().toISOString();
  return order;
}

/**
 * Full order list as CSV text (UTF-8, Excel-friendly BOM optional at call site).
 */
function ordersToCsv(orders) {
  const headers = [
    "time",
    "mode",
    "status",
    "qty",
    "seq",
    "phase",
    "stage",
    "jap_order_id",
    "jap_status",
    "jap_charge",
    "jap_remains",
    "link",
    "post_id",
    "drop_id",
    "order_id",
    "service_id",
    "checked_at",
  ];

  const rows = (orders || []).map((o) => [
    o.at || "",
    o.mode || "",
    o.japStatus || o.status || "",
    o.qty ?? "",
    o.seq ?? "",
    o.phaseId || "",
    o.stageLabel || "",
    o.japOrderId || "",
    o.japStatus || "",
    o.japCharge || "",
    o.japRemains || "",
    o.link || "",
    o.postId || "",
    o.dropId || "",
    o.id || "",
    o.serviceId ?? "",
    o.checkedAt || "",
  ]);

  return [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

module.exports = {
  MAX_ORDERS,
  parseListQuery,
  listOrders,
  summarizeOrders,
  buildOrderRecord,
  capOrders,
  enrichOrder,
  applyJapStatus,
  shortLink,
  ordersToCsv,
};
