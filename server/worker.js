const db = require("./db");
const jap = require("./jap");
const {
  buildSchedule,
  getFlow,
  normalizeFlowId,
  flowIdForLink,
  DEFAULT_FLOW_ID,
} = require("./logic/curve");
const { buildOrderRecord, capOrders } = require("./logic/orders");
const instagram = require("./logic/instagram");
const linkedin = require("./logic/linkedin");
const live = require("./live");

/** Slow path for scheduled +20 stamps. Instant pack never waits for this. */
const TICK_MS = 100;
const MAX_DROPS_PER_POST_TICK = 8;
/** Stagger late-track catch-up drops (was skipping them → missing views). */
const CATCHUP_GAP_MS = Math.max(
  15_000,
  Number(process.env.CATCHUP_GAP_MS || 75_000)
);
const MAX_IG_DROPS_PER_TICK = 2;
const MAX_LI_DROPS_PER_TICK = 2;

let timer = null;
let ticking = false;
/** Round-robin start index so multi-post stays fair */
let rrIndex = 0;

function isLive() {
  // Hard gate: .env LIVE_MODE=true AND UI Live toggle — both required to spend
  const envLive =
    String(process.env.LIVE_MODE || "false").toLowerCase() === "true";
  if (!envLive) return false;
  const data = db.read();
  if (typeof data.settings?.liveMode === "boolean") return data.settings.liveMode;
  return false;
}

function orderQty() {
  return Number(process.env.ORDER_QTY || db.read().settings.orderQty || 20);
}

function serviceId() {
  return Number(process.env.JAP_SERVICE_ID || db.read().settings.serviceId || 7394);
}

/** Fast 1-post Telegram views lane (0–1h start, min 10). Drip stays on JAP_SERVICE_ID. */
const DEFAULT_MANUAL_BOOST_SERVICE = 7381;

function manualBoostServiceId() {
  const fromEnv = Number(process.env.JAP_MANUAL_BOOST_SERVICE_ID || 0);
  if (fromEnv > 0) return fromEnv;
  return DEFAULT_MANUAL_BOOST_SERVICE;
}

/** Views already sent on the drip schedule (excludes manual boosts). */
function dripOrderedViews(post) {
  return (post?.drops || [])
    .filter((d) => d.status === "sent")
    .reduce((s, d) => s + (Number(d.qty) || 0), 0);
}

function postIdentity(link) {
  const normalized = normalizeLink(link);
  const m = normalized.match(/t\.me\/([^/]+)\/(\d+)/i);
  const channel = m ? m[1].toLowerCase() : null;
  const messageId = m ? Number(m[2]) : null;
  return {
    normalized,
    channel,
    messageId: Number.isFinite(messageId) ? messageId : null,
  };
}

function findExistingPost(posts, { normalized, channel, messageId }) {
  const list = posts || [];
  const byLink = list.find((p) => p.link === normalized);
  if (byLink) return byLink;
  if (!channel || messageId == null) return null;
  return (
    list.find((p) => {
      if (Number(p.messageId) === messageId) {
        const ch = String(p.link || "").match(/t\.me\/([^/]+)/i);
        return ch && ch[1].toLowerCase() === channel;
      }
      const m = String(p.link || "").match(/t\.me\/([^/]+)\/(\d+)/i);
      return (
        m && m[1].toLowerCase() === channel && Number(m[2]) === messageId
      );
    }) || null
  );
}

/**
 * Register a post and generate its full drip schedule.
 * Instant pack is forced to "due now" and fired on the next microtask — zero tick wait.
 *
 * Options:
 *  - flowId: "1" | "2" | "3" | "4" | "5" | "6" (6 = Flow Robo)
 *  - forceFlow: true → use flowId even for mapped channels (@robogems/@bansyndicate)
 *  - skipOrders: true → record link only (no drip). Used to skip already-posted messages.
 */
function addPost({
  link,
  title,
  startAt,
  source = "manual",
  skipOrders = false,
  flowId = DEFAULT_FLOW_ID,
  forceFlow = false,
} = {}) {
  const startMs = startAt ? new Date(startAt).getTime() : Date.now();
  if (!Number.isFinite(startMs)) throw new Error("Invalid startAt");

  const identity = postIdentity(link);
  const { normalized, messageId } = identity;

  // Mapped channels win unless forceFlow (other-channel / explicit override)
  const resolvedFlowId = forceFlow
    ? normalizeFlowId(flowId)
    : flowIdForLink(normalized, flowId);
  const flow = getFlow(resolvedFlowId);
  const schedule = buildSchedule(startMs, { flow: flow.plan });
  const now = Date.now();
  let catchUpIdx = 0;

  const drops = schedule.map((d) => {
    const isInstant = d.phaseId === "instant";
    let atMs = isInstant ? now : d.at;

    if (skipOrders) {
      return {
        id: db.uid("drop"),
        at: new Date(atMs).toISOString(),
        atMs,
        qty: d.qty,
        stageLabel: d.stageLabel,
        phaseId: d.phaseId,
        seq: d.seq,
        status: "skipped",
        japOrderId: null,
        error: "user skip — no drip on this post",
        sentAt: null,
      };
    }

    if (isInstant) {
      atMs = now;
    } else if (atMs < now - 45_000) {
      // Late discover / paste — still deliver full plan, stagger from now
      atMs = now + catchUpIdx * CATCHUP_GAP_MS;
      catchUpIdx += 1;
    }

    return {
      id: db.uid("drop"),
      at: new Date(atMs).toISOString(),
      atMs,
      qty: d.qty,
      stageLabel: d.stageLabel,
      phaseId: d.phaseId,
      seq: d.seq,
      status: "pending",
      japOrderId: null,
      error: null,
      sentAt: null,
    };
  });

  const draft = {
    id: db.uid("post"),
    link: normalized,
    messageId,
    title: title || normalized,
    source: skipOrders ? "skipped" : source,
    flowId: flow.id,
    flowName: flow.name,
    startAt: new Date(startMs).toISOString(),
    status: skipOrders ? "skipped" : "active",
    createdAt: new Date().toISOString(),
    totalPlanned: schedule.reduce((s, d) => s + d.qty, 0),
    totalOrdered: 0,
    drops,
    skipOrders: !!skipOrders,
  };

  // Atomic dedupe: phone + auto + sniffer can race; one post per link/message
  let post = null;
  let created = false;
  db.update((dbx) => {
    const existing = findExistingPost(dbx.posts, identity);
    if (existing) {
      post = existing;
      return;
    }
    dbx.posts.unshift(draft);
    post = draft;
    created = true;
  });

  if (!created) return post;

  db.logEvent(
    skipOrders ? "post_skipped" : "post_added",
    skipOrders
      ? `Skipped (no drip) ${normalized}`
      : `Tracking ${normalized} · ${flow.name}`,
    {
      postId: post.id,
      flowId: flow.id,
      drops: post.drops.filter((d) => d.status === "pending").length,
      planned: post.totalPlanned,
    }
  );

  if (skipOrders) {
    live.broadcast("sync", {
      postId: post.id,
      link: post.link,
      message: `Skipped · no drip on ${normalized}`,
    });
    return post;
  }

  live.broadcast("post_hit", {
    postId: post.id,
    link: post.link,
    title: post.title,
    source: post.source,
    planned: post.totalPlanned,
    message:
      post.source === "auto"
        ? `HIT from channel · ${normalized}`
        : post.source === "sniffer"
          ? `HIT from sniffer · ${normalized}`
          : `HIT · tracked ${normalized}`,
  });

  if (post.source === "auto" || post.source === "sniffer") {
    queueMicrotask(() => {
      try {
        const ingest = require("./supabaseIngest");
        ingest
          .reportDesktopHit({
            link: post.link,
            title: post.title,
            flowId: post.flowId,
            source: post.source,
          })
          .catch(() => {});
      } catch (_) {}
    });
  }

  queueMicrotask(() => {
    fireInstantForPost(post.id).catch((e) =>
      console.error("instant fire error", e.message || e)
    );
  });

  return post;
}

/**
 * Add many posts at once (one link per line / array).
 * Each link gets its own independent schedule matched to startAt (default now).
 */
function addPosts({
  links,
  startAt,
  source = "manual",
  flowId = DEFAULT_FLOW_ID,
  forceFlow = false,
  skipOrders = false,
} = {}) {
  const list = Array.isArray(links)
    ? links
    : String(links || "")
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);

  const added = [];
  const skipped = [];
  const errors = [];

  for (const raw of list) {
    try {
      const before = db.read().posts.find((p) => p.link === normalizeLink(raw));
      const post = addPost({
        link: raw,
        startAt,
        source,
        flowId,
        forceFlow,
        skipOrders,
      });
      if (before && before.id === post.id) skipped.push(post.link);
      else added.push(summarize(post));
    } catch (e) {
      errors.push({ link: raw, error: e.message });
    }
  }

  return { added, skipped, errors, total: list.length };
}

function summarize(p) {
  const pending = p.drops.filter((d) => d.status === "pending").length;
  const sent = p.drops.filter((d) => d.status === "sent").length;
  return {
    id: p.id,
    link: p.link,
    title: p.title,
    status: p.status,
    flowId: p.flowId || DEFAULT_FLOW_ID,
    flowName: p.flowName || getFlow(p.flowId).name,
    totalPlanned: p.totalPlanned,
    totalOrdered: p.totalOrdered,
    pending,
    sent,
    startAt: p.startAt,
  };
}

function normalizeLink(link) {
  let u = String(link || "").trim();
  if (!u) throw new Error("Link required");
  u = u.split("?")[0].split("#")[0];
  u = u.replace(/^https?:\/\/(www\.)?(telegram\.me|t\.me)\//i, "https://t.me/");
  if (!/^https?:\/\//i.test(u)) {
    if (u.startsWith("@")) u = u.slice(1);
    if (u.startsWith("t.me/")) u = "https://" + u;
    else u = "https://t.me/" + u.replace(/^\//, "");
  }
  // t.me/s/channel/123 (embed) → t.me/channel/123
  u = u.replace(/^(https:\/\/t\.me)\/s\//i, "$1/");
  u = u.replace(/\/$/, "");
  u = u.replace(
    /^(https:\/\/t\.me\/)([^/]+)(\/\d+)?$/i,
    (_, host, ch, rest) =>
      host +
      (String(ch).toLowerCase() === "c" ? "c" : String(ch).toLowerCase()) +
      (rest || "")
  );
  return u;
}

function pausePost(postId) {
  return setPostStatus(postId, "paused");
}

function resumePost(postId) {
  return setPostStatus(postId, "active");
}

function setPostStatus(postId, status) {
  let ok = false;
  db.update((dbx) => {
    const p = dbx.posts.find((x) => x.id === postId);
    if (!p) return;
    p.status = status;
    ok = true;
  });
  if (!ok) throw new Error("Post not found");
  return { id: postId, status };
}

function removePost(postId) {
  let link = null;
  db.update((dbx) => {
    const found = dbx.posts.find((p) => p.id === postId);
    link = found ? found.link : null;
    dbx.posts = dbx.posts.filter((p) => p.id !== postId);
    dbx.orders = dbx.orders.filter((o) => o.postId !== postId);
    if (link) {
      dbx.phoneDismissed = dbx.phoneDismissed || [];
      if (!dbx.phoneDismissed.includes(link)) dbx.phoneDismissed.unshift(link);
      dbx.phoneDismissed = dbx.phoneDismissed.slice(0, 200);
    }
  });
  db.logEvent("post_removed", `Removed post ${postId}`, { postId, link });
}

/**
 * Atomically claim a pending drop so tick + instant fire never double-order.
 * Returns snapshot or null if already claimed/sent.
 */
function claimDrop(postId, dropId) {
  let claimed = null;
  db.update((dbx) => {
    const p = dbx.posts.find((x) => x.id === postId);
    if (!p || p.status !== "active") return;
    const planned = Number(p.totalPlanned) || 0;
    const ordered = dripOrderedViews(p);
    if (planned > 0 && ordered >= planned) {
      const d = p.drops.find((x) => x.id === dropId);
      if (d && d.status === "pending") {
        d.status = "skipped";
        d.error = "planned views already reached — dup guard";
      }
      return;
    }
    const d = p.drops.find((x) => x.id === dropId);
    if (!d || d.status !== "pending") return;
    d.status = "sending";
    claimed = {
      postId: p.id,
      link: p.link,
      dropId: d.id,
      qty: d.qty,
      phaseId: d.phaseId,
      seq: d.seq,
      stageLabel: d.stageLabel,
    };
  });
  return claimed;
}

function markDropSent(claimed, japOrderId, mode, service) {
  const qty = Number(claimed.qty) || orderQty();
  db.update((dbx) => {
    const p = dbx.posts.find((x) => x.id === claimed.postId);
    if (!p) return;
    const d = p.drops.find((x) => x.id === claimed.dropId);
    if (!d) return;
    d.status = "sent";
    d.japOrderId = japOrderId;
    d.sentAt = new Date().toISOString();
    d.mode = mode;
    d.error = null;
    p.totalOrdered = (p.totalOrdered || 0) + qty;

    dbx.orders.unshift(
      buildOrderRecord({
        uid: db.uid("ord"),
        postId: claimed.postId,
        dropId: claimed.dropId,
        link: claimed.link,
        qty,
        japOrderId,
        mode,
        serviceId: service,
        phaseId: claimed.phaseId,
        seq: claimed.seq,
        stageLabel: claimed.stageLabel,
      })
    );
    dbx.orders = capOrders(dbx.orders);
  });
  db.logEvent(
    "order",
    `${mode === "live" ? "LIVE" : "DRY"} +${qty} → ${claimed.link}`,
    {
      postId: claimed.postId,
      japOrderId,
      qty,
      mode,
      phaseId: claimed.phaseId,
    }
  );
  live.broadcast("order", {
    postId: claimed.postId,
    link: claimed.link,
    qty,
    mode,
    phaseId: claimed.phaseId,
    japOrderId,
    message: `${mode === "live" ? "LIVE" : "DRY"} +${qty} ${claimed.phaseId || ""} · ${claimed.link}`,
  });
}

function markDropFailed(claimed, err) {
  db.update((dbx) => {
    const p = dbx.posts.find((x) => x.id === claimed.postId);
    if (!p) return;
    const d = p.drops.find((x) => x.id === claimed.dropId);
    if (!d) return;
    d.attempts = (d.attempts || 0) + 1;
    d.error = err?.message || String(err);
    if (d.attempts >= 3) {
      d.status = "failed";
      d.sentAt = new Date().toISOString();
    } else {
      // Instant retries ASAP (250ms); other drops wait ~5s
      const delay = d.phaseId === "instant" ? 250 : 5_000;
      d.status = "pending";
      d.atMs = Date.now() + delay;
      d.at = new Date(d.atMs).toISOString();
    }
  });
  db.logEvent("order_error", err?.message || String(err), {
    postId: claimed.postId,
    dropId: claimed.dropId,
    phaseId: claimed.phaseId,
  });
}

/**
 * Place one claimed drop with JAP (or dry-run).
 */
async function executeDrop(claimed) {
  const live = isLive();
  const service = serviceId();
  const qty = Number(claimed.qty) || orderQty();
  const mode = live ? "live" : "dry-run";

  let japOrderId = null;
  let placed = false;
  try {
    if (live) {
      const res = await jap.addOrder({
        service,
        link: claimed.link,
        quantity: qty,
        allowLiveSpend: true,
      });
      japOrderId = res.order ?? res.order_id ?? null;
      placed = true;
    } else {
      japOrderId = `DRY_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      placed = true;
    }
    markDropSent(claimed, japOrderId, mode, service);
    return { ok: true, japOrderId, mode, qty };
  } catch (err) {
    // If JAP already accepted the order, never retry — that doubles views
    if (placed) {
      try {
        markDropSent(
          claimed,
          japOrderId || `UNCONFIRMED_${Date.now()}`,
          mode,
          service
        );
      } catch (_) {
        db.update((dbx) => {
          const p = dbx.posts.find((x) => x.id === claimed.postId);
          const d = p?.drops.find((x) => x.id === claimed.dropId);
          if (d && (d.status === "sending" || d.status === "pending")) {
            d.status = "failed";
            d.error =
              "order may have been placed — not retried (dup guard): " +
              (err?.message || String(err));
            d.sentAt = new Date().toISOString();
          }
        });
      }
      return { ok: true, japOrderId, mode, qty, uncertain: true };
    }
    markDropFailed(claimed, err);
    return { ok: false, error: err };
  }
}

/**
 * Instant pack — no worker tick wait, no pacing delay.
 */
async function fireInstantForPost(postId) {
  const data = db.read();
  const post = data.posts.find((p) => p.id === postId);
  if (!post || post.status !== "active") return;

  const instants = post.drops.filter(
    (d) => d.phaseId === "instant" && d.status === "pending"
  );
  for (const drop of instants) {
    // Force due-now right before claim
    db.update((dbx) => {
      const p = dbx.posts.find((x) => x.id === postId);
      const d = p?.drops.find((x) => x.id === drop.id);
      if (d && d.status === "pending") {
        d.atMs = Date.now();
        d.at = new Date(d.atMs).toISOString();
      }
    });

    const claimed = claimDrop(postId, drop.id);
    if (!claimed) continue;
    await executeDrop(claimed);
  }
}

/**
 * Worker: fire due non-instant (and any leftover instant) drops.
 * Also fires due Instagram organic follower drip batches.
 */
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    const data = db.read();

    const active = data.posts.filter((p) => p.status === "active");
    if (active.length) {
      const n = active.length;
      rrIndex = rrIndex % n;
      const ordered = [...active.slice(rrIndex), ...active.slice(0, rrIndex)];
      rrIndex = (rrIndex + 1) % n;

      for (const post of ordered) {
        const due = post.drops
          .filter((d) => d.status === "pending" && d.atMs <= now)
          .sort((a, b) => {
            if (a.phaseId === "instant" && b.phaseId !== "instant") return -1;
            if (b.phaseId === "instant" && a.phaseId !== "instant") return 1;
            return a.atMs - b.atMs;
          })
          .slice(0, MAX_DROPS_PER_POST_TICK);

        if (!due.length) {
          markCompletedIfDone(post.id);
          continue;
        }

        for (const drop of due) {
          const claimed = claimDrop(post.id, drop.id);
          if (!claimed) continue;
          await executeDrop(claimed);
          if (isLive() && claimed.phaseId !== "instant") await sleep(80);
        }

        markCompletedIfDone(post.id);
      }
    }

    await tickInstagramDrips(now);
    await tickLinkedInDrips(now);
    tickFomoHouse(now);
  } finally {
    ticking = false;
  }
}

function tickFomoHouse(now = Date.now()) {
  try {
    const fomo = require("./logic/fomo");
    const data = db.read();
    fomo.ensureFomoStore(data);
    const touched = fomo.tickHouseOrders(data, now);
    if (touched) db.write(data);
  } catch (e) {
    console.error("[fomo-house]", e.message || e);
  }
}

function claimIgDrop(dripId, dropId) {
  let claimed = null;
  db.update((dbx) => {
    instagram.ensureInstagramStore(dbx);
    const drip = (dbx.instagramDrips || []).find((d) => d.id === dripId);
    if (!drip || drip.status !== "active") return;
    const drop = (drip.drops || []).find((d) => d.id === dropId);
    if (!drop || drop.status !== "pending") return;
    drop.status = "sending";
    claimed = {
      dripId: drip.id,
      dropId: drop.id,
      link: drip.link,
      serviceId: drip.serviceId,
      serviceName: drip.serviceName,
      rate: drip.rate,
      qty: drop.qty,
      phaseId: drop.phaseId,
      seq: drop.seq,
      label: drop.label,
      note: drip.note,
    };
  });
  return claimed;
}

async function executeIgDrop(claimed) {
  const liveMode = isLive();
  const mode = liveMode ? "live" : "dry-run";
  const orderId = db.uid("ig");
  const record = {
    id: orderId,
    kind: "instagram_followers",
    dripId: claimed.dripId,
    dropId: claimed.dropId,
    phaseId: claimed.phaseId,
    seq: claimed.seq,
    link: claimed.link,
    serviceId: claimed.serviceId,
    quantity: claimed.qty,
    mode,
    status: liveMode ? "submitted" : "simulated",
    japOrderId: null,
    charge: null,
    serviceName: claimed.serviceName || null,
    rate: claimed.rate || null,
    note: claimed.note || null,
    label: claimed.label || null,
    at: new Date().toISOString(),
    error: null,
  };

  try {
    if (liveMode) {
      const japRes = await jap.addOrder({
        service: claimed.serviceId,
        link: claimed.link,
        quantity: claimed.qty,
        allowLiveSpend: true,
      });
      record.japOrderId =
        japRes?.order != null ? String(japRes.order) : null;
      record.status = "submitted";
    } else {
      record.japOrderId = `DRY_IG_${Date.now()}`;
      record.status = "simulated";
    }

    db.update((dbx) => {
      instagram.ensureInstagramStore(dbx);
      const drip = dbx.instagramDrips.find((d) => d.id === claimed.dripId);
      const drop = drip?.drops?.find((d) => d.id === claimed.dropId);
      if (drop) {
        drop.status = "sent";
        drop.japOrderId = record.japOrderId;
        drop.orderId = orderId;
        drop.sentAt = record.at;
        drop.error = null;
      }
      if (drip) {
        drip.totalOrdered = (drip.drops || [])
          .filter((d) => d.status === "sent")
          .reduce((s, d) => s + (Number(d.qty) || 0), 0);
      }
      dbx.instagramOrders.unshift(record);
      dbx.instagramOrders = dbx.instagramOrders.slice(0, instagram.MAX_ORDERS);
    });

    db.logEvent(
      "instagram_drip_drop",
      `${mode === "live" ? "LIVE" : "DRY"} IG drip +${claimed.qty} · ${claimed.label || claimed.phaseId} → ${claimed.link}`,
      {
        dripId: claimed.dripId,
        orderId,
        japOrderId: record.japOrderId,
      }
    );

    live.broadcast("instagram_drip", {
      dripId: claimed.dripId,
      quantity: claimed.qty,
      link: claimed.link,
      mode,
      label: claimed.label,
    });

    markIgDripCompletedIfDone(claimed.dripId);
  } catch (e) {
    db.update((dbx) => {
      instagram.ensureInstagramStore(dbx);
      const drip = dbx.instagramDrips.find((d) => d.id === claimed.dripId);
      const drop = drip?.drops?.find((d) => d.id === claimed.dropId);
      if (drop) {
        drop.status = "failed";
        drop.error = e.message || "order failed";
      }
      record.status = "failed";
      record.error = e.message || "order failed";
      dbx.instagramOrders.unshift(record);
      dbx.instagramOrders = dbx.instagramOrders.slice(0, instagram.MAX_ORDERS);
    });
    db.logEvent("instagram_drip_error", e.message || "IG drip failed", {
      dripId: claimed.dripId,
      dropId: claimed.dropId,
    });
  }
}

async function tickInstagramDrips(now = Date.now()) {
  const data = db.read();
  instagram.ensureInstagramStore(data);
  const active = (data.instagramDrips || []).filter((d) => d.status === "active");
  if (!active.length) return;

  let fired = 0;
  for (const drip of active) {
    if (fired >= MAX_IG_DROPS_PER_TICK) break;
    const due = (drip.drops || [])
      .filter((d) => d.status === "pending" && Number(d.atMs) <= now)
      .sort((a, b) => a.atMs - b.atMs);

    for (const drop of due) {
      if (fired >= MAX_IG_DROPS_PER_TICK) break;
      const claimed = claimIgDrop(drip.id, drop.id);
      if (!claimed) continue;
      await executeIgDrop(claimed);
      fired += 1;
      if (isLive()) await sleep(120);
    }

    markIgDripCompletedIfDone(drip.id);
  }
}

function markIgDripCompletedIfDone(dripId) {
  db.update((dbx) => {
    instagram.ensureInstagramStore(dbx);
    const drip = (dbx.instagramDrips || []).find((d) => d.id === dripId);
    if (!drip || drip.status !== "active") return;
    const pending = (drip.drops || []).some(
      (d) => d.status === "pending" || d.status === "sending"
    );
    if (!pending) {
      drip.status = (drip.drops || []).some((d) => d.status === "failed")
        ? "partial"
        : "completed";
      drip.completedAt = new Date().toISOString();
    }
  });
}

/**
 * Start a slow organic Instagram follower drip (default 100).
 */
function startInstagramDrip({
  link,
  serviceId,
  total = 100,
  note,
  serviceName,
  rate,
  startAt,
} = {}) {
  const normalized = instagram.normalizeProfileUrl(link);
  if (!normalized) {
    throw new Error(
      "Invalid Instagram profile. Use @handle or https://www.instagram.com/handle/"
    );
  }
  const svc = Number(serviceId) || instagram.defaultServiceId();
  const plan = instagram.describeOrganicPlan(total);
  const campaign = instagram.createDripCampaign({
    link: normalized,
    serviceId: svc,
    total: plan.total,
    note,
    serviceName,
    rate,
    startAt,
    uid: db.uid,
  });

  db.update((dbx) => {
    instagram.ensureInstagramStore(dbx);
    dbx.settings.instagramProfileUrl = normalized;
    dbx.settings.instagramServiceId = svc;
    dbx.instagramDrips.unshift(campaign);
    dbx.instagramDrips = dbx.instagramDrips.slice(0, instagram.MAX_DRIPS);
  });

  db.logEvent(
    "instagram_drip_start",
    `Started organic IG drip +${campaign.totalPlanned} → ${normalized} (${campaign.drops.length} batches)`,
    { dripId: campaign.id, serviceId: svc }
  );

  return campaign;
}

function pauseInstagramDrip(dripId) {
  let ok = false;
  db.update((dbx) => {
    instagram.ensureInstagramStore(dbx);
    const drip = dbx.instagramDrips.find((d) => d.id === dripId);
    if (drip && drip.status === "active") {
      drip.status = "paused";
      ok = true;
    }
  });
  return ok;
}

function resumeInstagramDrip(dripId) {
  let ok = false;
  db.update((dbx) => {
    instagram.ensureInstagramStore(dbx);
    const drip = dbx.instagramDrips.find((d) => d.id === dripId);
    if (drip && drip.status === "paused") {
      drip.status = "active";
      ok = true;
    }
  });
  return ok;
}

function cancelInstagramDrip(dripId) {
  let ok = false;
  db.update((dbx) => {
    instagram.ensureInstagramStore(dbx);
    const drip = dbx.instagramDrips.find((d) => d.id === dripId);
    if (!drip) return;
    if (drip.status === "active" || drip.status === "paused") {
      drip.status = "cancelled";
      for (const drop of drip.drops || []) {
        if (drop.status === "pending" || drop.status === "sending") {
          drop.status = "skipped";
          drop.error = "cancelled";
        }
      }
      ok = true;
    }
  });
  return ok;
}

function claimLiDrop(dripId, dropId) {
  let claimed = null;
  db.update((dbx) => {
    linkedin.ensureLinkedInStore(dbx);
    const drip = (dbx.linkedinDrips || []).find((d) => d.id === dripId);
    if (!drip || drip.status !== "active") return;
    const drop = (drip.drops || []).find((d) => d.id === dropId);
    if (!drop || drop.status !== "pending") return;
    drop.status = "sending";
    claimed = {
      dripId: drip.id,
      dropId: drop.id,
      link: drip.link,
      serviceId: drip.serviceId,
      serviceName: drip.serviceName,
      rate: drip.rate,
      qty: drop.qty,
      phaseId: drop.phaseId,
      seq: drop.seq,
      label: drop.label,
      note: drip.note,
    };
  });
  return claimed;
}

async function executeLiDrop(claimed) {
  const liveMode = isLive();
  const mode = liveMode ? "live" : "dry-run";
  const orderId = db.uid("li");
  const record = {
    id: orderId,
    kind: "linkedin_followers",
    dripId: claimed.dripId,
    dropId: claimed.dropId,
    phaseId: claimed.phaseId,
    seq: claimed.seq,
    link: claimed.link,
    serviceId: claimed.serviceId,
    quantity: claimed.qty,
    mode,
    status: liveMode ? "submitted" : "simulated",
    japOrderId: null,
    charge: null,
    serviceName: claimed.serviceName || null,
    rate: claimed.rate || null,
    note: claimed.note || null,
    label: claimed.label || null,
    at: new Date().toISOString(),
    error: null,
  };

  try {
    if (liveMode) {
      const japRes = await jap.addOrder({
        service: claimed.serviceId,
        link: claimed.link,
        quantity: claimed.qty,
        allowLiveSpend: true,
      });
      record.japOrderId =
        japRes?.order != null ? String(japRes.order) : null;
      record.status = "submitted";
    } else {
      record.japOrderId = `DRY_LI_${Date.now()}`;
      record.status = "simulated";
    }

    db.update((dbx) => {
      linkedin.ensureLinkedInStore(dbx);
      const drip = dbx.linkedinDrips.find((d) => d.id === claimed.dripId);
      const drop = drip?.drops?.find((d) => d.id === claimed.dropId);
      if (drop) {
        drop.status = "sent";
        drop.japOrderId = record.japOrderId;
        drop.orderId = orderId;
        drop.sentAt = record.at;
        drop.error = null;
      }
      if (drip) {
        drip.totalOrdered = (drip.drops || [])
          .filter((d) => d.status === "sent")
          .reduce((s, d) => s + (Number(d.qty) || 0), 0);
      }
      dbx.linkedinOrders.unshift(record);
      dbx.linkedinOrders = dbx.linkedinOrders.slice(0, linkedin.MAX_ORDERS);
    });

    db.logEvent(
      "linkedin_drip_drop",
      `${mode === "live" ? "LIVE" : "DRY"} LI drip +${claimed.qty} · ${claimed.label || claimed.phaseId} → ${claimed.link}`,
      {
        dripId: claimed.dripId,
        orderId,
        japOrderId: record.japOrderId,
      }
    );

    live.broadcast("linkedin_drip", {
      dripId: claimed.dripId,
      quantity: claimed.qty,
      link: claimed.link,
      mode,
      label: claimed.label,
    });

    markLiDripCompletedIfDone(claimed.dripId);
  } catch (e) {
    db.update((dbx) => {
      linkedin.ensureLinkedInStore(dbx);
      const drip = dbx.linkedinDrips.find((d) => d.id === claimed.dripId);
      const drop = drip?.drops?.find((d) => d.id === claimed.dropId);
      if (drop) {
        drop.status = "failed";
        drop.error = e.message || "order failed";
      }
      record.status = "failed";
      record.error = e.message || "order failed";
      dbx.linkedinOrders.unshift(record);
      dbx.linkedinOrders = dbx.linkedinOrders.slice(0, linkedin.MAX_ORDERS);
    });
    db.logEvent("linkedin_drip_error", e.message || "LI drip failed", {
      dripId: claimed.dripId,
      dropId: claimed.dropId,
    });
  }
}

async function tickLinkedInDrips(now = Date.now()) {
  const data = db.read();
  linkedin.ensureLinkedInStore(data);
  const active = (data.linkedinDrips || []).filter((d) => d.status === "active");
  if (!active.length) return;

  let fired = 0;
  for (const drip of active) {
    if (fired >= MAX_LI_DROPS_PER_TICK) break;
    const due = (drip.drops || [])
      .filter((d) => d.status === "pending" && Number(d.atMs) <= now)
      .sort((a, b) => a.atMs - b.atMs);

    for (const drop of due) {
      if (fired >= MAX_LI_DROPS_PER_TICK) break;
      const claimed = claimLiDrop(drip.id, drop.id);
      if (!claimed) continue;
      await executeLiDrop(claimed);
      fired += 1;
      if (isLive()) await sleep(120);
    }

    markLiDripCompletedIfDone(drip.id);
  }
}

function markLiDripCompletedIfDone(dripId) {
  db.update((dbx) => {
    linkedin.ensureLinkedInStore(dbx);
    const drip = (dbx.linkedinDrips || []).find((d) => d.id === dripId);
    if (!drip || drip.status !== "active") return;
    const pending = (drip.drops || []).some(
      (d) => d.status === "pending" || d.status === "sending"
    );
    if (!pending) {
      drip.status = (drip.drops || []).some((d) => d.status === "failed")
        ? "partial"
        : "completed";
      drip.completedAt = new Date().toISOString();
    }
  });
}

/**
 * Start a LinkedIn organic follower drip (flows 100 → 500).
 */
function startLinkedInDrip({
  link,
  serviceId,
  total = 100,
  note,
  serviceName,
  rate,
  startAt,
} = {}) {
  const normalized = linkedin.normalizeProfileUrl(link);
  if (!normalized) {
    throw new Error(
      "Invalid LinkedIn profile. Use a /in/ or /company/ URL (or the slug)."
    );
  }
  const svc = Number(serviceId) || linkedin.defaultServiceId();
  const plan = linkedin.describeFlow(total);
  const campaign = linkedin.createDripCampaign({
    link: normalized,
    serviceId: svc,
    total: plan.total,
    note,
    serviceName,
    rate,
    startAt,
    uid: db.uid,
  });

  db.update((dbx) => {
    linkedin.ensureLinkedInStore(dbx);
    dbx.settings.linkedinProfileUrl = normalized;
    dbx.settings.linkedinServiceId = svc;
    dbx.linkedinDrips.unshift(campaign);
    dbx.linkedinDrips = dbx.linkedinDrips.slice(0, linkedin.MAX_DRIPS);
  });

  db.logEvent(
    "linkedin_drip_start",
    `Started organic LI drip +${campaign.totalPlanned} → ${normalized} (${campaign.drops.length} batches · ${campaign.flowName})`,
    { dripId: campaign.id, serviceId: svc, flowId: campaign.flowId }
  );

  return campaign;
}

function pauseLinkedInDrip(dripId) {
  let ok = false;
  db.update((dbx) => {
    linkedin.ensureLinkedInStore(dbx);
    const drip = dbx.linkedinDrips.find((d) => d.id === dripId);
    if (drip && drip.status === "active") {
      drip.status = "paused";
      ok = true;
    }
  });
  return ok;
}

function resumeLinkedInDrip(dripId) {
  let ok = false;
  db.update((dbx) => {
    linkedin.ensureLinkedInStore(dbx);
    const drip = dbx.linkedinDrips.find((d) => d.id === dripId);
    if (drip && drip.status === "paused") {
      drip.status = "active";
      ok = true;
    }
  });
  return ok;
}

function cancelLinkedInDrip(dripId) {
  let ok = false;
  db.update((dbx) => {
    linkedin.ensureLinkedInStore(dbx);
    const drip = dbx.linkedinDrips.find((d) => d.id === dripId);
    if (!drip) return;
    if (drip.status === "active" || drip.status === "paused") {
      drip.status = "cancelled";
      for (const drop of drip.drops || []) {
        if (drop.status === "pending" || drop.status === "sending") {
          drop.status = "skipped";
          drop.error = "cancelled";
        }
      }
      ok = true;
    }
  });
  return ok;
}

function markCompletedIfDone(postId) {
  db.update((dbx) => {
    const p = dbx.posts.find((x) => x.id === postId);
    if (!p || p.status !== "active") return;
    const pending = p.drops.some(
      (d) => d.status === "pending" || d.status === "sending"
    );
    if (!pending) p.status = "completed";
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Align each post to its own flow plan (default Flow 1).
 * Keeps history for allowed marks that already fired.
 */
function tightenAllSchedules() {
  let touched = 0;
  db.update((dbx) => {
    for (const post of dbx.posts) {
      const flow = getFlow(post.flowId || DEFAULT_FLOW_ID);
      const allowed = new Set(flow.marks);
      const before = post.drops.length;
      const kept = post.drops.filter((d) => {
        const mark = String(d.stageLabel || "").split(" · ")[0].trim();
        return allowed.has(mark);
      });
      const alreadyOk =
        kept.length === before &&
        post.totalPlanned === flow.totalViews &&
        normalizeFlowId(post.flowId) === flow.id &&
        post.flowName === flow.name;
      if (alreadyOk) continue;

      const startMs = new Date(post.startAt).getTime();
      const plan = buildSchedule(startMs, { flow: flow.plan });
      const byMark = new Map(
        kept.map((d) => [String(d.stageLabel || "").split(" · ")[0].trim(), d])
      );
      const now = Date.now();
      let catchUpIdx = 0;

      post.flowId = flow.id;
      post.flowName = flow.name;
      post.drops = plan.map((step) => {
        const mark = step.stageLabel;
        const existing = byMark.get(mark);
        if (existing) {
          return {
            ...existing,
            qty: step.qty,
            stageLabel: mark,
            phaseId: step.phaseId,
            seq: step.seq,
          };
        }
        let atMs = step.phaseId === "instant" ? now : step.at;
        if (step.phaseId === "instant") {
          atMs = now;
        } else if (atMs < now - 45_000) {
          atMs = now + catchUpIdx * CATCHUP_GAP_MS;
          catchUpIdx += 1;
        }
        return {
          id: db.uid("drop"),
          at: new Date(atMs).toISOString(),
          atMs,
          qty: step.qty,
          stageLabel: mark,
          phaseId: step.phaseId,
          seq: step.seq,
          status: "pending",
          japOrderId: null,
          error: null,
          sentAt: null,
        };
      });

      post.totalPlanned = flow.totalViews;
      post.totalOrdered = post.drops
        .filter((d) => d.status === "sent")
        .reduce((s, d) => s + (d.qty || 0), 0);
      touched += 1;
    }
  });
  if (touched) {
    console.log(`[worker] tightened ${touched} post schedule(s) (flow-aware)`);
  }
}

function recoverStuckSendingDrops() {
  let n = 0;
  db.update((dbx) => {
    for (const post of dbx.posts || []) {
      for (const d of post.drops || []) {
        if (d.status === "sending") {
          d.status = "failed";
          d.error =
            d.error ||
            "interrupted while sending — not retried (dup guard)";
          d.sentAt = d.sentAt || new Date().toISOString();
          n += 1;
        }
      }
    }
  });
  if (n) console.log(`[worker] recovered ${n} stuck sending drop(s) as failed`);
}

/** Re-queue drops that were skipped as "missed window" — full plan must still run. */
function recoverMissedWindowDrops() {
  let n = 0;
  db.update((dbx) => {
    const now = Date.now();
    for (const post of dbx.posts || []) {
      if (post.status !== "active") continue;
      let catchUpIdx = 0;
      for (const d of post.drops || []) {
        if (
          d.status !== "skipped" ||
          d.error !== "missed window (late track)"
        ) {
          continue;
        }
        d.status = "pending";
        d.error = null;
        d.japOrderId = null;
        d.sentAt = null;
        d.atMs = now + catchUpIdx * CATCHUP_GAP_MS;
        d.at = new Date(d.atMs).toISOString();
        catchUpIdx += 1;
        n += 1;
      }
    }
  });
  if (n) console.log(`[worker] re-queued ${n} missed-window drop(s) for catch-up`);
}

function startWorker() {
  if (timer) return;
  recoverStuckSendingDrops();
  recoverMissedWindowDrops();
  tightenAllSchedules();
  timer = setInterval(() => {
    tick().catch((e) => console.error("tick error", e));
  }, TICK_MS);
  tick().catch((e) => console.error("tick error", e));
  console.log(`[worker] started (every ${TICK_MS}ms) · instant fires on microtask`);
}

function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

const MANUAL_BOOST_QTYS = [20, 30, 40, 50, 60, 70, 80, 90, 100];

/** Known limits — avoids fetching the full JAP catalog on every click. */
const MANUAL_BOOST_LIMITS = {
  7381: { min: 10, max: 500_000 },
  7394: { min: 20, max: 1_000_000 },
};

function isManualBoostQty(qty) {
  return MANUAL_BOOST_QTYS.includes(Number(qty));
}

function resolveManualBoostLimits(service) {
  const id = Number(service);
  const cached = jap.peekServices()?.find((s) => Number(s.service) === id);
  if (cached) {
    return {
      min: Number(cached.min) || 1,
      max: Number(cached.max) || Infinity,
      name: cached.name,
    };
  }
  const known = MANUAL_BOOST_LIMITS[id];
  if (known) return { ...known, name: null };
  return null;
}

function assertManualBoostQty(q, service) {
  const lim = resolveManualBoostLimits(service);
  if (!lim) return null;
  if (q < lim.min) {
    throw new Error(
      `JAP service #${service} minimum is ${lim.min} views (you picked +${q})`
    );
  }
  if (q > lim.max) {
    throw new Error(
      `JAP service #${service} maximum is ${lim.max} views (you picked +${q})`
    );
  }
  return lim;
}

/**
 * One-off manual view order (not part of drip schedule).
 * Fires JAP immediately on click — separate fast service from drip.
 */
async function manualBoost({ link, qty, postId } = {}) {
  const t0 = Date.now();
  const q = Number(qty);
  if (!isManualBoostQty(q)) {
    throw new Error(`Quantity must be one of: ${MANUAL_BOOST_QTYS.join(", ")}`);
  }

  let normalized;
  let resolvedPostId = postId || null;

  if (postId) {
    const data = db.read();
    const post = data.posts.find((p) => p.id === postId);
    if (!post) throw new Error("Post not found");
    normalized = post.link;
    resolvedPostId = post.id;
  } else if (link) {
    normalized = normalizeLink(link);
    const existing = findExistingPost(db.read().posts, postIdentity(normalized));
    if (existing) resolvedPostId = existing.id;
  } else {
    throw new Error("Post link required");
  }

  const liveMode = isLive();
  const service = manualBoostServiceId();
  const mode = liveMode ? "live" : "dry-run";
  const lim = assertManualBoostQty(q, service);

  let japOrderId = null;
  if (liveMode) {
    const res = await jap.addOrder({
      service,
      link: normalized,
      quantity: q,
      allowLiveSpend: true,
    });
    japOrderId = res.order ?? res.order_id ?? null;
    if (!japOrderId) {
      throw new Error("JAP accepted the order but returned no order id");
    }
  } else {
    japOrderId = `DRY_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  }

  const elapsedMs = Date.now() - t0;

  const orderId = db.uid("ord");
  db.update((dbx) => {
    if (resolvedPostId) {
      const p = dbx.posts.find((x) => x.id === resolvedPostId);
      if (p) {
        // Manual boosts are separate from drip plan — never inflate drip cap
        p.manualOrdered = (Number(p.manualOrdered) || 0) + q;
      }
    }

    dbx.orders.unshift(
      buildOrderRecord({
        uid: orderId,
        postId: resolvedPostId,
        dropId: null,
        link: normalized,
        qty: q,
        japOrderId,
        mode,
        serviceId: service,
        phaseId: "manual",
        seq: null,
        stageLabel: `Manual +${q}`,
      })
    );
    dbx.orders = capOrders(dbx.orders);
  });

  db.logEvent(
    "order",
    `${mode === "live" ? "LIVE" : "DRY"} manual +${q} → ${normalized}`,
    { postId: resolvedPostId, japOrderId, qty: q, mode, phaseId: "manual" }
  );

  live.broadcast("order", {
    postId: resolvedPostId,
    link: normalized,
    qty: q,
    mode,
    phaseId: "manual",
    japOrderId,
    message: `${mode === "live" ? "LIVE" : "DRY"} manual +${q} · ${normalized}`,
  });

  return {
    ok: true,
    japOrderId,
    mode,
    qty: q,
    link: normalized,
    postId: resolvedPostId,
    orderId,
    serviceId: service,
    serviceName: lim?.name ? String(lim.name).slice(0, 120) : null,
    instant: true,
    elapsedMs,
  };
}

function getStatus() {
  const data = db.read();
  const posts = data.posts;
  const active = posts.filter((p) => p.status === "active").length;
  const pendingDrops = posts.reduce(
    (s, p) =>
      s + p.drops.filter((d) => d.status === "pending" || d.status === "sending")
        .length,
    0
  );
  const sentDrops = posts.reduce(
    (s, p) => s + p.drops.filter((d) => d.status === "sent").length,
    0
  );
  return {
    liveMode: isLive(),
    serviceId: serviceId(),
    orderQty: orderQty(),
    posts: posts.length,
    active,
    pendingDrops,
    sentDrops,
    ordersLogged: data.orders.length,
    multiPost: true,
    target: "F4:536 · F5:456 · F3:746 · F1:396 · F2:300 (channel map / manual picker)",
    instantMode: "microtask (no tick wait)",
  };
}

module.exports = {
  startWorker,
  stopWorker,
  tick,
  addPost,
  addPosts,
  pausePost,
  resumePost,
  removePost,
  fireInstantForPost,
  manualBoost,
  MANUAL_BOOST_QTYS,
  DEFAULT_MANUAL_BOOST_SERVICE,
  manualBoostServiceId,
  dripOrderedViews,
  isManualBoostQty,
  isLive,
  getStatus,
  normalizeLink,
  tightenAllSchedules,
  startInstagramDrip,
  pauseInstagramDrip,
  resumeInstagramDrip,
  cancelInstagramDrip,
  tickInstagramDrips,
  startLinkedInDrip,
  pauseLinkedInDrip,
  resumeLinkedInDrip,
  cancelLinkedInDrip,
  tickLinkedInDrips,
};
