require("dotenv").config();
const path = require("path");
const express = require("express");

const db = require("./db");
try {
  const lock = db.acquireInstanceLock();
  console.log(
    `[lock] desk pid ${lock.pid} · port ${lock.port} (single instance)`
  );
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
const jap = require("./jap");
const worker = require("./worker");
const telegram = require("./telegram");
const telegramBot = require("./telegramBot");
const live = require("./live");

/** Auto-discover poll gap (ms). Default 200ms between probe ticks. */
const AUTO_DISCOVER_MS = Math.max(
  100,
  Number(process.env.AUTO_DISCOVER_INTERVAL_MS || 200)
);
/** Only auto-track posts newer than this (default 1 hour). */
const AUTO_DISCOVER_MAX_AGE_MS = Math.max(
  60_000,
  Number(process.env.AUTO_DISCOVER_MAX_AGE_MS || 60 * 60 * 1000)
);
/** Fresh enough that drip starts at "now" (instant pack). */
const AUTO_DISCOVER_FRESH_MS = 3 * 60 * 1000;

const {
  describeCurve,
  describeInstantPack,
  describeEarlyTicker,
  buildSchedule,
  listFlows,
  getFlow,
  normalizeFlowId,
  flowIdForChannel,
  flowIdForLink,
  DEFAULT_FLOW_ID,
  ORDER_QTY,
} = require("./logic/curve");
const {
  listOrders,
  summarizeOrders,
  applyJapStatus,
  ordersToCsv,
} = require("./logic/orders");
const twitter = require("./logic/twitter");
const twitterPosts = require("./logic/twitterPosts");
const twitterViews = require("./logic/twitterViews");
const instagram = require("./logic/instagram");
const instagramLikes = require("./logic/instagramLikes");
const linkedin = require("./logic/linkedin");
const fomo = require("./logic/fomo");
const youtube = require("./logic/youtube");
const supabaseIngest = require("./supabaseIngest");

const app = express();
const PORT = Number(process.env.PORT || 3847);

app.use(express.json({ limit: "1mb" }));

app.get("/m/config.js", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.type("application/javascript");
  res.send(
    `window.ROBO_MOBILE=${JSON.stringify({
      supabaseUrl: String(process.env.SUPABASE_URL || "")
        .trim()
        .replace(/\/$/, ""),
      anonKey: String(process.env.SUPABASE_ANON_KEY || "").trim(),
    })};\n`
  );
});

app.get(["/m", "/m/"], (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "m", "index.html"));
});

app.use(express.static(path.join(__dirname, "..", "public")));

// ── API ──────────────────────────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/** Realtime stream — dashboard stays live when TG posts hit */
app.get("/api/live", (req, res) => {
  live.attach(req, res);
});

app.get("/api/status", (_req, res) => {
  const bot = telegramBot.botStatus();
  res.json({
    ...worker.getStatus(),
    liveClients: live.clientCount(),
    telegramOk: !lastTelegramError && Date.now() >= telegramBlockedUntil,
    telegramError: lastTelegramError,
    telegramOkAt: lastTelegramOkAt,
    telegramBackoffUntil:
      Date.now() < telegramBlockedUntil
        ? new Date(telegramBlockedUntil).toISOString()
        : null,
    botDiscover: bot,
    // Auto works if EITHER scrape OR bot path is healthy
    autoDiscoverHealthy: Boolean(
      (!lastTelegramError && Date.now() >= telegramBlockedUntil) ||
        (bot.enabled && !bot.lastError)
    ),
    phoneIngest: supabaseIngest.getStatus(),
  });
});

app.get("/api/settings", (_req, res) => {
  const data = db.read();
  const envLive =
    String(process.env.LIVE_MODE || "false").toLowerCase() === "true";
  const channels = getWatchedChannels(data.settings);
  res.json({
    ...data.settings,
    liveMode: worker.isLive(),
    uiLiveMode: !!data.settings.liveMode,
    envLiveMode: envLive,
    liveAllowedByEnv: envLive,
    hasApiKey: Boolean(process.env.JAP_API_KEY),
    apiUrl: process.env.JAP_API_URL || "https://justanotherpanel.com/api/v2",
    channelUsername: channels[0] || "bansyndicate",
    channelUsernames: channels,
    autoDiscoverMaxAgeMs: AUTO_DISCOVER_MAX_AGE_MS,
    autoDiscoverMaxAgeHours: AUTO_DISCOVER_MAX_AGE_MS / (60 * 60 * 1000),
  });
});

app.post("/api/settings", (req, res) => {
  const {
    liveMode,
    autoDiscover,
    channelUsername,
    channelUsernames,
    serviceId,
  } = req.body || {};
  let turnedAutoOn = false;
  let channelChanged = false;
  const envLive =
    String(process.env.LIVE_MODE || "false").toLowerCase() === "true";

  // Block enabling live when .env forbids it — prevents surprise balance drain
  if (liveMode === true && !envLive) {
    return res.status(400).json({
      error:
        "Live mode blocked: set LIVE_MODE=true in .env and restart, then enable Live in UI. Orders stay dry-run so balance is safe.",
      liveMode: false,
      envLiveMode: false,
    });
  }

  db.update((dbx) => {
    if (typeof liveMode === "boolean") dbx.settings.liveMode = liveMode;
    if (typeof autoDiscover === "boolean") {
      turnedAutoOn = autoDiscover && !dbx.settings.autoDiscover;
      dbx.settings.autoDiscover = autoDiscover;
    }
    const rawChannels =
      channelUsernames != null ? channelUsernames : channelUsername;
    if (rawChannels != null && String(rawChannels).trim() !== "") {
      const next = parseChannelList(rawChannels);
      if (next.length) {
        const prev = getWatchedChannels(dbx.settings);
        channelChanged =
          next.length !== prev.length ||
          next.some((c, i) => c !== prev[i]);
        setWatchedChannels(dbx, next);
      }
    }
    if (serviceId) dbx.settings.serviceId = Number(serviceId);
  });
  db.logEvent(
    "settings",
    `Settings updated (live=${worker.isLive()}, envLive=${envLive})`
  );
  if (turnedAutoOn || autoDiscover === true || channelChanged) {
    setImmediate(() => runAutoDiscover().catch(() => {}));
  }
  const channels = getWatchedChannels();
  res.json({
    ok: true,
    settings: {
      ...db.read().settings,
      channelUsername: channels[0],
      channelUsernames: channels,
    },
    liveMode: worker.isLive(),
    envLiveMode: envLive,
  });
});

app.get("/api/curve", (req, res) => {
  const flowId = normalizeFlowId(req.query.flow || req.query.flowId);
  const analysis = describeCurve({ flowId, orderQty: ORDER_QTY });
  const instant = describeInstantPack({ flowId });
  const early = describeEarlyTicker(10 * 60, { flowId });
  const flow = getFlow(flowId);
  res.json({
    flowId,
    flows: listFlows(),
    analysis,
    instant,
    early,
    exampleA: {
      need: instant.need,
      windowMin: 0.15,
      orders: instant.orders,
      views: instant.views,
      intervalSec: instant.gapSec,
      times: instant.times.map((t) => t.time),
      title: `Instant +${flow.instantViews}`,
    },
    exampleB: {
      from: 0,
      to: early.views,
      need: early.views,
      windowMin: early.windowSec / 60,
      orders: early.drops,
      views: early.views,
      intervalSec: early.maxGapSec,
      title: "First 10 min stamps",
      maxGapSec: early.maxGapSec,
      sample: early.sample,
    },
    curve: flow.plan.map((p) => ({
      tMin: p.tMin,
      cumulative: null,
      id: p.phaseId,
      qty: p.qty,
      label: p.label,
    })),
    flow: analysis.flow,
  });
});

app.get("/api/posts", (_req, res) => {
  const data = db.read();
  res.json(
    data.posts.map((p) => summarizePost(p))
  );
});

app.get("/api/posts/:id", (req, res) => {
  const post = db.read().posts.find((p) => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: "Not found" });
  res.json(post);
});

app.post("/api/posts", (req, res) => {
  try {
    const { link, links, title, startAt, flowId, forceFlow, source, skipOrders } =
      req.body || {};
    const chosenFlow = normalizeFlowId(flowId);
    const forced = forceFlow === true || source === "sniffer";
    const skip = skipOrders === true;

    // Multi-post: links array or multi-line string
    const rawList = links || link;
    const list = Array.isArray(rawList)
      ? rawList
      : String(rawList || "")
          .split(/[\n,]+/)
          .map((s) => s.trim())
          .filter(Boolean);

    if (!list.length) {
      return res.status(400).json({ error: "Paste at least one post link" });
    }

    if (list.length === 1) {
      const post = worker.addPost({
        link: list[0],
        title,
        startAt,
        flowId: chosenFlow,
        forceFlow: forced,
        source: source || "manual",
        skipOrders: skip,
      });
      return res.json({ ...summarizePost(post), batch: false });
    }

    const result = worker.addPosts({
      links: list,
      startAt,
      flowId: chosenFlow,
      forceFlow: forced,
      source: source || "manual",
      skipOrders: skip,
    });
    res.json({
      batch: true,
      ...result,
      posts: result.added,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/posts/:id/pause", (req, res) => {
  try {
    res.json(summarizePost(worker.pausePost(req.params.id)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/posts/:id/resume", (req, res) => {
  try {
    res.json(summarizePost(worker.resumePost(req.params.id)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/posts/:id", (req, res) => {
  try {
    worker.removePost(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Stop every tracked post + clear pending drips (fresh start). */
/** One-off manual view boost (20–100 in steps of 10). */
app.post("/api/manual-boost", async (req, res) => {
  try {
    const { link, qty, postId } = req.body || {};
    const result = await worker.manualBoost({ link, qty, postId });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/manual-boost", (_req, res) => {
  res.json({
    quantities: worker.MANUAL_BOOST_QTYS,
    serviceId: worker.manualBoostServiceId(),
    dripServiceId: Number(process.env.JAP_SERVICE_ID || 7394),
  });
});

app.post("/api/posts/stop-all", (req, res) => {
  try {
    const before = db.read();
    const count = (before.posts || []).length;
    const orderCount = (before.orders || []).length;
    db.update((dbx) => {
      for (const p of dbx.posts || []) {
        p.status = "stopped";
        for (const drop of p.drops || []) {
          if (drop.status === "pending" || drop.status === "sending") {
            drop.status = "skipped";
            drop.error = "stopped by user — fresh start";
          }
        }
      }
      dbx.posts = [];
      dbx.orders = [];
      // Always leave spend off after full reset
      dbx.settings = dbx.settings || {};
      dbx.settings.liveMode = false;
    });
    db.logEvent(
      "reset",
      `Stopped all posts (${count}) · cleared orders (${orderCount}) · live OFF`
    );
    live.broadcast("sync", {
      message: `Reset · ${count} post(s) cleared · dry-run only`,
      stopped: count,
    });
    res.json({
      ok: true,
      stopped: count,
      ordersCleared: orderCount,
      liveMode: worker.isLive(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Order list — filterable; full list by default (limit=all).
 * Query: limit (all|n), offset, postId, mode (live|dry-run), status, link, phaseId, q
 * ?format=flat → bare array (legacy)
 */
app.get("/api/orders", (req, res) => {
  const data = db.read();
  // default: entire list end-to-end (filters still apply)
  const query = { limit: "all", ...req.query };
  if (req.query.limit === undefined) query.limit = "all";
  const result = listOrders(data, query);
  if (String(req.query.format || "").toLowerCase() === "flat") {
    return res.json(result.items);
  }
  res.json(result);
});

app.get("/api/orders/stats", (req, res) => {
  const data = db.read();
  const { items } = listOrders(data, { ...req.query, limit: "all", offset: 0 });
  res.json(summarizeOrders(items));
});

/**
 * Download full filtered order list as CSV.
 * Same filters as GET /api/orders (mode, status, link, phaseId, q, postId).
 */
app.get("/api/orders/export.csv", (req, res) => {
  const data = db.read();
  const { items } = listOrders(data, { ...req.query, limit: "all", offset: 0 });
  const csv = ordersToCsv(items);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  // BOM so Excel opens UTF-8 correctly
  const body = "\uFEFF" + csv;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="robo-views-orders-${stamp}.csv"`
  );
  res.send(body);
});

/** Pull JAP status for recent live orders (best-effort). */
app.post("/api/orders/refresh-status", async (req, res) => {
  try {
    const limit = Math.min(30, Math.max(1, Number(req.body?.limit) || 15));
    const data = db.read();
    const live = data.orders
      .filter((o) => o.mode === "live" && o.japOrderId && !String(o.japOrderId).startsWith("DRY_"))
      .slice(0, limit);

    const updated = [];
    const errors = [];

    for (const order of live) {
      try {
        const st = await jap.getOrderStatus(order.japOrderId);
        db.update((dbx) => {
          const row = dbx.orders.find((x) => x.id === order.id);
          if (row) applyJapStatus(row, st);
        });
        updated.push(order.id);
      } catch (e) {
        errors.push({ id: order.id, error: e.message });
      }
      await new Promise((r) => setTimeout(r, 120));
    }

    db.logEvent(
      "orders_refresh",
      `Refreshed ${updated.length}/${live.length} live order statuses`
    );
    res.json({ ok: true, checked: live.length, updated: updated.length, errors });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/events", (_req, res) => {
  res.json(db.read().events.slice(0, 100));
});

app.get("/api/balance", async (_req, res) => {
  try {
    const bal = await jap.getBalance();
    res.json(bal);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/service", async (_req, res) => {
  try {
    const id = Number(process.env.JAP_SERVICE_ID || 7394);
    const svc = await jap.getService(id);
    res.json(svc || { error: `Service ${id} not found` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Twitter / X followers (separate page) ─────────────────────────

app.get("/twitter", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "twitter.html"));
});

app.get("/instagram", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "instagram.html"));
});

app.get("/instagram-likes", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "instagram-likes.html"));
});

app.get("/twitter-posts", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "twitter-posts.html"));
});

app.get("/twitter-views", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "twitter-views.html"));
});

app.get("/linkedin", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "linkedin.html"));
});

app.get("/fomo", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "fomo.html"));
});

app.get("/youtube", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "youtube.html"));
});

app.get("/api/instagram/settings", (_req, res) => {
  const data = db.read();
  instagram.ensureInstagramStore(data);
  const envLive =
    String(process.env.LIVE_MODE || "false").toLowerCase() === "true";
  const serviceId =
    Number(data.settings.instagramServiceId) || instagram.defaultServiceId();

  const cached = jap.peekServices();
  const fromCache = cached
    ? cached.find((s) => Number(s.service) === Number(serviceId))
    : null;
  const service =
    instagram.mapService(fromCache) || instagram.fallbackService(serviceId);

  jap.getServices().catch(() => {});

  res.json({
    liveMode: worker.isLive(),
    envLiveMode: envLive,
    liveAllowedByEnv: envLive,
    hasApiKey: Boolean(process.env.JAP_API_KEY),
    serviceId,
    defaultServiceId: instagram.defaultServiceId(),
    profileUrl:
      data.settings.instagramProfileUrl || instagram.defaultProfileUrl(),
    service,
  });
});

app.post("/api/instagram/settings", (req, res) => {
  const { serviceId, profileUrl } = req.body || {};
  const link =
    profileUrl != null ? instagram.normalizeProfileUrl(profileUrl) : null;
  if (profileUrl != null && !link) {
    return res.status(400).json({
      error:
        "Invalid Instagram profile. Use @handle or https://www.instagram.com/handle/",
    });
  }
  db.update((dbx) => {
    instagram.ensureInstagramStore(dbx);
    if (serviceId != null && Number(serviceId) > 0) {
      dbx.settings.instagramServiceId = Number(serviceId);
    }
    if (link) dbx.settings.instagramProfileUrl = link;
  });
  const data = db.read();
  res.json({
    ok: true,
    serviceId: data.settings.instagramServiceId,
    profileUrl: data.settings.instagramProfileUrl,
  });
});

app.get("/api/instagram/services", async (req, res) => {
  try {
    const force = String(req.query.refresh || "") === "1";
    const serviceId =
      Number(db.read().settings?.instagramServiceId) ||
      instagram.defaultServiceId();

    const starter = instagram.FALLBACK_SERVICES.slice();
    if (!starter.some((s) => s.service === serviceId)) {
      const fb = instagram.fallbackService(serviceId);
      if (fb) starter.unshift(fb);
    }

    const listPromise = jap.getServices({ force });
    const raced = await Promise.race([
      listPromise.then((list) => ({ ready: true, list })),
      new Promise((resolve) =>
        setTimeout(() => resolve({ ready: false, list: null }), 1200)
      ),
    ]);

    if (raced.ready && Array.isArray(raced.list)) {
      const items = instagram.filterFollowerServices(raced.list);
      return res.json({
        items,
        defaultServiceId: instagram.defaultServiceId(),
        count: items.length,
        cached: !force,
        partial: false,
      });
    }

    listPromise.catch(() => {});
    res.json({
      items: starter,
      defaultServiceId: instagram.defaultServiceId(),
      count: starter.length,
      cached: false,
      partial: true,
    });
  } catch (e) {
    const items = instagram.FALLBACK_SERVICES.slice();
    res.json({
      items,
      defaultServiceId: instagram.defaultServiceId(),
      count: items.length,
      cached: false,
      partial: true,
      error: e.message,
    });
  }
});

app.get("/api/instagram/orders", (req, res) => {
  const data = db.read();
  res.json(instagram.listInstagramOrders(data, req.query));
});

app.get("/api/instagram/plan", (req, res) => {
  const total = Math.floor(Number(req.query.total) || 100);
  res.json(instagram.describeOrganicPlan(total));
});

app.get("/api/instagram/drips", (req, res) => {
  const data = db.read();
  res.json(instagram.listInstagramDrips(data, req.query));
});

/** Start slow organic drip (default). Pass mode:"oneshot" for a single dump. */
app.post("/api/instagram/order", async (req, res) => {
  try {
    const data = db.read();
    instagram.ensureInstagramStore(data);

    const link = instagram.normalizeProfileUrl(
      req.body?.link ||
        req.body?.profileUrl ||
        data.settings.instagramProfileUrl ||
        instagram.defaultProfileUrl()
    );
    if (!link) {
      return res.status(400).json({
        error:
          "Invalid Instagram profile. Use @handle or https://www.instagram.com/handle/",
      });
    }

    const serviceId = Number(
      req.body?.serviceId ||
        data.settings.instagramServiceId ||
        instagram.defaultServiceId()
    );
    if (!Number.isFinite(serviceId) || serviceId <= 0) {
      return res.status(400).json({ error: "Invalid service id" });
    }

    const cached = jap.peekServices();
    const fromCache = cached
      ? cached.find((s) => Number(s.service) === Number(serviceId))
      : null;
    const svcMeta =
      instagram.mapService(fromCache) ||
      instagram.fallbackService(serviceId) ||
      null;

    const oneshot =
      String(req.body?.mode || "").toLowerCase() === "oneshot" ||
      req.body?.drip === false;

    if (!oneshot) {
      const total = Math.floor(Number(req.body?.quantity) || 100);
      if (!Number.isFinite(total) || total < 5) {
        return res.status(400).json({
          error: "Organic drip needs at least 5 followers total",
        });
      }
      const plan = instagram.describeOrganicPlan(total);
      const svcError = instagram.validateDripAgainstService(svcMeta, plan);
      if (svcError) {
        return res.status(400).json({ error: svcError, plan });
      }

      const drip = worker.startInstagramDrip({
        link,
        serviceId,
        total: plan.total,
        note: req.body?.note,
        serviceName: svcMeta?.name || null,
        rate: svcMeta?.rate || null,
        startAt: req.body?.startAt,
      });

      return res.json({
        ok: true,
        mode: "organic_drip",
        live: worker.isLive(),
        drip,
        plan,
      });
    }

    let quantity = Math.floor(Number(req.body?.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ error: "Quantity must be a positive number" });
    }

    if (svcMeta) {
      const min = Number(svcMeta.min) || 1;
      const max = Number(svcMeta.max) || quantity;
      if (quantity < min) {
        return res.status(400).json({
          error: `Quantity below service min (${min})`,
          min,
          max,
        });
      }
      if (quantity > max) {
        return res.status(400).json({
          error: `Quantity above service max (${max})`,
          min,
          max,
        });
      }
    }

    const live = worker.isLive();
    const mode = live ? "live" : "dry-run";
    const orderId = db.uid("ig");
    const record = {
      id: orderId,
      kind: "instagram_followers",
      link,
      serviceId,
      quantity,
      mode,
      status: live ? "submitted" : "simulated",
      japOrderId: null,
      charge: null,
      serviceName: svcMeta?.name || null,
      rate: svcMeta?.rate || null,
      note: req.body?.note ? String(req.body.note).slice(0, 120) : null,
      at: new Date().toISOString(),
      error: null,
    };

    if (live) {
      const japRes = await jap.addOrder({
        service: serviceId,
        link,
        quantity,
        allowLiveSpend: true,
      });
      record.japOrderId = japRes?.order != null ? String(japRes.order) : null;
      record.status = "submitted";
    } else {
      record.japOrderId = `DRY_IG_${Date.now()}`;
      record.status = "simulated";
    }

    db.update((dbx) => {
      instagram.ensureInstagramStore(dbx);
      dbx.settings.instagramProfileUrl = link;
      dbx.settings.instagramServiceId = serviceId;
      dbx.instagramOrders.unshift(record);
      dbx.instagramOrders = dbx.instagramOrders.slice(0, instagram.MAX_ORDERS);
    });

    db.logEvent(
      "instagram_order",
      `${mode === "live" ? "LIVE" : "DRY"} +${quantity} IG followers → ${link}`,
      { orderId, serviceId, japOrderId: record.japOrderId }
    );

    res.json({ ok: true, order: record, live, mode: "oneshot" });
  } catch (e) {
    const status = e.code === "LIVE_BLOCKED" ? 400 : 500;
    res.status(status).json({ error: e.message, jap: e.jap || null });
  }
});

app.post("/api/instagram/drips/:id/pause", (req, res) => {
  const ok = worker.pauseInstagramDrip(req.params.id);
  if (!ok) return res.status(404).json({ error: "Active drip not found" });
  res.json({ ok: true, status: "paused" });
});

app.post("/api/instagram/drips/:id/resume", (req, res) => {
  const ok = worker.resumeInstagramDrip(req.params.id);
  if (!ok) return res.status(404).json({ error: "Paused drip not found" });
  res.json({ ok: true, status: "active" });
});

app.post("/api/instagram/drips/:id/cancel", (req, res) => {
  const ok = worker.cancelInstagramDrip(req.params.id);
  if (!ok) return res.status(404).json({ error: "Drip not found" });
  res.json({ ok: true, status: "cancelled" });
});

app.post("/api/instagram/orders/refresh-status", async (req, res) => {
  try {
    const limit = Math.min(30, Math.max(1, Number(req.body?.limit) || 15));
    const data = db.read();
    instagram.ensureInstagramStore(data);
    const live = data.instagramOrders
      .filter(
        (o) =>
          o.mode === "live" &&
          o.japOrderId &&
          !String(o.japOrderId).startsWith("DRY_")
      )
      .slice(0, limit);

    const updated = [];
    const errors = [];

    for (const order of live) {
      try {
        const st = await jap.getOrderStatus(order.japOrderId);
        db.update((dbx) => {
          instagram.ensureInstagramStore(dbx);
          const row = dbx.instagramOrders.find((x) => x.id === order.id);
          if (row) instagram.applyJapStatus(row, st);
        });
        updated.push(order.id);
      } catch (e) {
        errors.push({ id: order.id, error: e.message });
      }
      await new Promise((r) => setTimeout(r, 120));
    }

    db.logEvent(
      "instagram_orders_refresh",
      `Refreshed ${updated.length}/${live.length} Instagram order statuses`
    );
    res.json({
      ok: true,
      checked: live.length,
      updated: updated.length,
      errors,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── LinkedIn organic drip ────────────────────────────────────────

app.get("/api/linkedin/settings", (_req, res) => {
  const data = db.read();
  linkedin.ensureLinkedInStore(data);
  const serviceId =
    Number(data.settings.linkedinServiceId) || linkedin.defaultServiceId();
  const cached = jap.peekServices();
  const fromCache = cached
    ? cached.find((s) => Number(s.service) === Number(serviceId))
    : null;
  const service =
    linkedin.mapService(fromCache) || linkedin.fallbackService(serviceId);
  const rate = Number(service?.rate) || null;
  res.json({
    liveMode: worker.isLive(),
    serviceId,
    service,
    defaultServiceId: linkedin.defaultServiceId(),
    profileUrl:
      data.settings.linkedinProfileUrl || linkedin.defaultProfileUrl(),
    flows: linkedin.listFlows(),
    packs: linkedin.packPriceMenu(rate),
  });
});

app.post("/api/linkedin/settings", (req, res) => {
  const { serviceId, profileUrl } = req.body || {};
  const link =
    profileUrl != null ? linkedin.normalizeProfileUrl(profileUrl) : null;
  if (profileUrl != null && !link) {
    return res.status(400).json({
      error:
        "Invalid LinkedIn profile. Use /in/slug, /company/slug, or a full LinkedIn URL.",
    });
  }
  db.update((dbx) => {
    linkedin.ensureLinkedInStore(dbx);
    if (serviceId != null && Number(serviceId) > 0) {
      dbx.settings.linkedinServiceId = Number(serviceId);
    }
    if (link) dbx.settings.linkedinProfileUrl = link;
  });
  const data = db.read();
  res.json({
    ok: true,
    serviceId: data.settings.linkedinServiceId,
    profileUrl: data.settings.linkedinProfileUrl,
  });
});

app.get("/api/linkedin/services", async (_req, res) => {
  try {
    const serviceId =
      Number(db.read().settings?.linkedinServiceId) ||
      linkedin.defaultServiceId();
    const starter = linkedin.FALLBACK_SERVICES.slice();
    if (!starter.some((s) => s.service === serviceId)) {
      const fb = linkedin.fallbackService(serviceId);
      if (fb) starter.unshift(fb);
    }

    const raced = await Promise.race([
      jap
        .getServices()
        .then((list) => ({ list, partial: false }))
        .catch(() => ({ list: null, partial: true })),
      new Promise((resolve) =>
        setTimeout(() => resolve({ list: null, partial: true }), 3500)
      ),
    ]);

    if (raced.list) {
      const items = linkedin.filterFollowerServices(raced.list);
      return res.json({
        items: items.length ? items : starter,
        defaultServiceId: linkedin.defaultServiceId(),
        partial: raced.partial || !items.length,
      });
    }

    res.json({
      items: starter,
      defaultServiceId: linkedin.defaultServiceId(),
      partial: true,
    });
  } catch (e) {
    const items = linkedin.FALLBACK_SERVICES.slice();
    res.json({
      items,
      defaultServiceId: linkedin.defaultServiceId(),
      partial: true,
      error: e.message,
    });
  }
});

app.get("/api/linkedin/orders", (req, res) => {
  const data = db.read();
  res.json(linkedin.listLinkedInOrders(data, req.query));
});

app.get("/api/linkedin/flows", (_req, res) => {
  res.json({ flows: linkedin.listFlows(), totals: linkedin.FLOW_TOTALS });
});

app.get("/api/linkedin/plan", (req, res) => {
  const total = linkedin.normalizeFlowTotal(
    req.query.total || req.query.flowId || 100
  );
  const plan = linkedin.describeFlow(total);
  const rate = Number(req.query.rate);
  res.json({
    ...plan,
    packs: linkedin.packPriceMenu(
      Number.isFinite(rate) && rate > 0 ? rate : null
    ),
  });
});

app.get("/api/linkedin/drips", (req, res) => {
  const data = db.read();
  res.json(linkedin.listLinkedInDrips(data, req.query));
});

app.post("/api/linkedin/order", async (req, res) => {
  try {
    const data = db.read();
    linkedin.ensureLinkedInStore(data);

    const link = linkedin.normalizeProfileUrl(
      req.body?.link ||
        req.body?.profileUrl ||
        data.settings.linkedinProfileUrl ||
        linkedin.defaultProfileUrl()
    );
    if (!link) {
      return res.status(400).json({
        error:
          "Invalid LinkedIn profile. Use /in/slug, /company/slug, or a full LinkedIn URL.",
      });
    }

    const serviceId = Number(
      req.body?.serviceId ||
        data.settings.linkedinServiceId ||
        linkedin.defaultServiceId()
    );
    if (!Number.isFinite(serviceId) || serviceId <= 0) {
      return res.status(400).json({ error: "Invalid service id" });
    }

    const cached = jap.peekServices();
    const fromCache = cached
      ? cached.find((s) => Number(s.service) === Number(serviceId))
      : null;
    const svcMeta =
      linkedin.mapService(fromCache) ||
      linkedin.fallbackService(serviceId) ||
      null;

    const total = linkedin.normalizeFlowTotal(
      req.body?.quantity || req.body?.flowId || 100
    );
    const plan = linkedin.describeFlow(total);
    const svcError = linkedin.validateDripAgainstService(svcMeta, plan);
    if (svcError) {
      return res.status(400).json({ error: svcError, plan });
    }

    const drip = worker.startLinkedInDrip({
      link,
      serviceId,
      total: plan.total,
      note: req.body?.note,
      serviceName: svcMeta?.name || null,
      rate: svcMeta?.rate || null,
      startAt: req.body?.startAt,
    });

    return res.json({
      ok: true,
      mode: "organic_drip",
      live: worker.isLive(),
      drip,
      plan,
    });
  } catch (e) {
    const status = e.code === "LIVE_BLOCKED" ? 400 : 500;
    res.status(status).json({ error: e.message, jap: e.jap || null });
  }
});

app.post("/api/linkedin/drips/:id/pause", (req, res) => {
  const ok = worker.pauseLinkedInDrip(req.params.id);
  if (!ok) return res.status(404).json({ error: "Active drip not found" });
  res.json({ ok: true, status: "paused" });
});

app.post("/api/linkedin/drips/:id/resume", (req, res) => {
  const ok = worker.resumeLinkedInDrip(req.params.id);
  if (!ok) return res.status(404).json({ error: "Paused drip not found" });
  res.json({ ok: true, status: "active" });
});

app.post("/api/linkedin/drips/:id/cancel", (req, res) => {
  const ok = worker.cancelLinkedInDrip(req.params.id);
  if (!ok) return res.status(404).json({ error: "Drip not found" });
  res.json({ ok: true, status: "cancelled" });
});

app.post("/api/linkedin/orders/refresh-status", async (req, res) => {
  try {
    const limit = Math.min(30, Math.max(1, Number(req.body?.limit) || 15));
    const data = db.read();
    linkedin.ensureLinkedInStore(data);
    const live = data.linkedinOrders
      .filter(
        (o) =>
          o.mode === "live" &&
          o.japOrderId &&
          !String(o.japOrderId).startsWith("DRY_")
      )
      .slice(0, limit);

    const updated = [];
    const errors = [];

    for (const order of live) {
      try {
        const st = await jap.getOrderStatus(order.japOrderId);
        db.update((dbx) => {
          linkedin.ensureLinkedInStore(dbx);
          const row = dbx.linkedinOrders.find((x) => x.id === order.id);
          if (row) linkedin.applyJapStatus(row, st);
        });
        updated.push(order.id);
      } catch (e) {
        errors.push({ id: order.id, error: e.message });
      }
      await new Promise((r) => setTimeout(r, 120));
    }

    db.logEvent(
      "linkedin_orders_refresh",
      `Refreshed ${updated.length}/${live.length} LinkedIn order statuses`
    );
    res.json({
      ok: true,
      checked: live.length,
      updated: updated.length,
      errors,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/twitter/settings", (_req, res) => {
  const data = db.read();
  twitter.ensureTwitterStore(data);
  const envLive =
    String(process.env.LIVE_MODE || "false").toLowerCase() === "true";
  const serviceId =
    Number(data.settings.twitterServiceId) || twitter.defaultServiceId();

  const cached = jap.peekServices();
  const fromCache = cached
    ? cached.find((s) => Number(s.service) === Number(serviceId))
    : null;
  const service =
    twitter.mapService(fromCache) || twitter.fallbackService(serviceId);

  const catalog = cached
    ? twitter.filterFollowerServices(cached)
    : twitter.FALLBACK_SERVICES;
  const cheapest = twitter.pickCheapest(catalog);
  const instantCheap = twitter.pickInstantCheap(catalog);

  // Warm catalog in background for full dropdown / live rates
  jap.getServices().catch(() => {});

  res.json({
    liveMode: worker.isLive(),
    envLiveMode: envLive,
    liveAllowedByEnv: envLive,
    hasApiKey: Boolean(process.env.JAP_API_KEY),
    serviceId,
    defaultServiceId: twitter.defaultServiceId(),
    profileUrl:
      data.settings.twitterProfileUrl || twitter.defaultProfileUrl(),
    service,
    cheapest,
    instantCheap,
  });
});

app.post("/api/twitter/settings", (req, res) => {
  const { serviceId, profileUrl } = req.body || {};
  const link = profileUrl != null ? twitter.normalizeProfileUrl(profileUrl) : null;
  if (profileUrl != null && !link) {
    return res.status(400).json({
      error: "Invalid X/Twitter profile. Use @handle or https://x.com/handle",
    });
  }
  db.update((dbx) => {
    twitter.ensureTwitterStore(dbx);
    if (serviceId != null && Number(serviceId) > 0) {
      dbx.settings.twitterServiceId = Number(serviceId);
    }
    if (link) dbx.settings.twitterProfileUrl = link;
  });
  const data = db.read();
  res.json({
    ok: true,
    serviceId: data.settings.twitterServiceId,
    profileUrl: data.settings.twitterProfileUrl,
  });
});

app.get("/api/twitter/services", async (req, res) => {
  try {
    const force = String(req.query.refresh || "") === "1";
    const serviceId =
      Number(db.read().settings?.twitterServiceId) ||
      twitter.defaultServiceId();

    // Instant response from fallback while catalog warms
    const starter = twitter.FALLBACK_SERVICES.slice();
    if (!starter.some((s) => s.service === serviceId)) {
      const fb = twitter.fallbackService(serviceId);
      if (fb) starter.unshift(fb);
    }

    const listPromise = jap.getServices({ force });
    const raced = await Promise.race([
      listPromise.then((list) => ({ ready: true, list })),
      new Promise((resolve) =>
        setTimeout(() => resolve({ ready: false, list: null }), 1200)
      ),
    ]);

    if (raced.ready && Array.isArray(raced.list)) {
      const items = twitter.filterFollowerServices(raced.list);
      return res.json({
        items,
        cheapest: twitter.pickCheapest(items),
        instantCheap: twitter.pickInstantCheap(items),
        defaultServiceId: twitter.defaultServiceId(),
        count: items.length,
        cached: !force,
        partial: false,
      });
    }

    // Still loading — return fallback now; client can refresh
    listPromise.catch(() => {});
    res.json({
      items: starter,
      cheapest: twitter.pickCheapest(starter),
      instantCheap: twitter.pickInstantCheap(starter),
      defaultServiceId: twitter.defaultServiceId(),
      count: starter.length,
      cached: false,
      partial: true,
    });
  } catch (e) {
    const items = twitter.FALLBACK_SERVICES.slice();
    res.json({
      items,
      cheapest: twitter.pickCheapest(items),
      instantCheap: twitter.pickInstantCheap(items),
      defaultServiceId: twitter.defaultServiceId(),
      count: items.length,
      cached: false,
      partial: true,
      error: e.message,
    });
  }
});

app.get("/api/twitter/orders", (req, res) => {
  const data = db.read();
  res.json(twitter.listTwitterOrders(data, req.query));
});

app.post("/api/twitter/order", async (req, res) => {
  try {
    const data = db.read();
    twitter.ensureTwitterStore(data);

    const link = twitter.normalizeProfileUrl(
      req.body?.link ||
        req.body?.profileUrl ||
        data.settings.twitterProfileUrl ||
        twitter.defaultProfileUrl()
    );
    if (!link) {
      return res.status(400).json({
        error: "Invalid X/Twitter profile. Use @handle or https://x.com/handle",
      });
    }

    const serviceId = Number(
      req.body?.serviceId ||
        data.settings.twitterServiceId ||
        twitter.defaultServiceId()
    );
    if (!Number.isFinite(serviceId) || serviceId <= 0) {
      return res.status(400).json({ error: "Invalid service id" });
    }

    let quantity = Math.floor(Number(req.body?.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ error: "Quantity must be a positive number" });
    }

    // Never block placing an order on the slow full catalog.
    const cached = jap.peekServices();
    const fromCache = cached
      ? cached.find((s) => Number(s.service) === Number(serviceId))
      : null;
    const svcMeta =
      twitter.mapService(fromCache) ||
      twitter.fallbackService(serviceId) ||
      null;

    if (svcMeta) {
      const min = Number(svcMeta.min) || 1;
      const max = Number(svcMeta.max) || quantity;
      if (quantity < min) {
        return res.status(400).json({
          error: `Quantity below service min (${min})`,
          min,
          max,
        });
      }
      if (quantity > max) {
        return res.status(400).json({
          error: `Quantity above service max (${max})`,
          min,
          max,
        });
      }
    }

    const live = worker.isLive();
    const mode = live ? "live" : "dry-run";
    const orderId = db.uid("tw");
    const record = {
      id: orderId,
      kind: "twitter_followers",
      link,
      serviceId,
      quantity,
      mode,
      status: live ? "submitted" : "simulated",
      japOrderId: null,
      charge: null,
      serviceName: svcMeta?.name || null,
      rate: svcMeta?.rate || null,
      note: req.body?.note ? String(req.body.note).slice(0, 120) : null,
      at: new Date().toISOString(),
      error: null,
    };

    if (live) {
      const japRes = await jap.addOrder({
        service: serviceId,
        link,
        quantity,
        allowLiveSpend: true,
      });
      record.japOrderId = japRes?.order != null ? String(japRes.order) : null;
      record.status = "submitted";
    } else {
      record.japOrderId = `DRY_TW_${Date.now()}`;
      record.status = "simulated";
    }

    db.update((dbx) => {
      twitter.ensureTwitterStore(dbx);
      dbx.settings.twitterProfileUrl = link;
      dbx.settings.twitterServiceId = serviceId;
      dbx.twitterOrders.unshift(record);
      dbx.twitterOrders = dbx.twitterOrders.slice(0, twitter.MAX_ORDERS);
    });

    db.logEvent(
      "twitter_order",
      `${mode === "live" ? "LIVE" : "DRY"} +${quantity} followers → ${link}`,
      { orderId, serviceId, japOrderId: record.japOrderId }
    );

    res.json({ ok: true, order: record, live });
  } catch (e) {
    const status = e.code === "LIVE_BLOCKED" ? 400 : 500;
    res.status(status).json({ error: e.message, jap: e.jap || null });
  }
});

app.post("/api/twitter/orders/refresh-status", async (req, res) => {
  try {
    const limit = Math.min(30, Math.max(1, Number(req.body?.limit) || 15));
    const data = db.read();
    twitter.ensureTwitterStore(data);
    const live = data.twitterOrders
      .filter(
        (o) =>
          o.mode === "live" &&
          o.japOrderId &&
          !String(o.japOrderId).startsWith("DRY_")
      )
      .slice(0, limit);

    const updated = [];
    const errors = [];

    for (const order of live) {
      try {
        const st = await jap.getOrderStatus(order.japOrderId);
        db.update((dbx) => {
          twitter.ensureTwitterStore(dbx);
          const row = dbx.twitterOrders.find((x) => x.id === order.id);
          if (row) twitter.applyJapStatus(row, st);
        });
        updated.push(order.id);
      } catch (e) {
        errors.push({ id: order.id, error: e.message });
      }
      await new Promise((r) => setTimeout(r, 120));
    }

    db.logEvent(
      "twitter_orders_refresh",
      `Refreshed ${updated.length}/${live.length} Twitter order statuses`
    );
    res.json({
      ok: true,
      checked: live.length,
      updated: updated.length,
      errors,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Instagram post likes (separate page) ──────────────────────────

app.get("/api/instagram-likes/settings", (_req, res) => {
  const data = db.read();
  instagramLikes.ensureInstagramLikesStore(data);
  const envLive =
    String(process.env.LIVE_MODE || "false").toLowerCase() === "true";
  const serviceId =
    Number(data.settings.instagramLikesServiceId) ||
    instagramLikes.defaultServiceId();

  const cached = jap.peekServices();
  const fromCache = cached
    ? cached.find((s) => Number(s.service) === Number(serviceId))
    : null;
  const service =
    instagramLikes.mapService(fromCache) ||
    instagramLikes.fallbackService(serviceId);

  const catalog = cached
    ? instagramLikes.filterLikeServices(cached)
    : instagramLikes.FALLBACK_SERVICES;
  const cheapest = instagramLikes.pickCheapest(catalog);
  const instantCheap = instagramLikes.pickInstantCheap(catalog);

  jap.getServices().catch(() => {});

  res.json({
    liveMode: worker.isLive(),
    envLiveMode: envLive,
    liveAllowedByEnv: envLive,
    hasApiKey: Boolean(process.env.JAP_API_KEY),
    serviceId,
    defaultServiceId: instagramLikes.defaultServiceId(),
    postUrl:
      data.settings.instagramLikesPostUrl || instagramLikes.defaultPostUrl(),
    service,
    cheapest,
    instantCheap,
  });
});

app.post("/api/instagram-likes/settings", (req, res) => {
  const { serviceId, postUrl } = req.body || {};
  const link =
    postUrl != null ? instagramLikes.normalizePostUrl(postUrl) : null;
  if (postUrl != null && postUrl !== "" && !link) {
    return res.status(400).json({
      error:
        "Invalid Instagram post URL. Use https://www.instagram.com/p/CODE/ or /reel/CODE/",
    });
  }
  db.update((dbx) => {
    instagramLikes.ensureInstagramLikesStore(dbx);
    if (serviceId != null && Number(serviceId) > 0) {
      dbx.settings.instagramLikesServiceId = Number(serviceId);
    }
    if (link) dbx.settings.instagramLikesPostUrl = link;
  });
  const data = db.read();
  res.json({
    ok: true,
    serviceId: data.settings.instagramLikesServiceId,
    postUrl: data.settings.instagramLikesPostUrl,
  });
});

app.get("/api/instagram-likes/services", async (req, res) => {
  try {
    const force = String(req.query.refresh || "") === "1";
    const serviceId =
      Number(db.read().settings?.instagramLikesServiceId) ||
      instagramLikes.defaultServiceId();

    const starter = instagramLikes.FALLBACK_SERVICES.slice();
    if (!starter.some((s) => s.service === serviceId)) {
      const fb = instagramLikes.fallbackService(serviceId);
      if (fb) starter.unshift(fb);
    }

    const listPromise = jap.getServices({ force });
    const raced = await Promise.race([
      listPromise.then((list) => ({ ready: true, list })),
      new Promise((resolve) =>
        setTimeout(() => resolve({ ready: false, list: null }), 1200)
      ),
    ]);

    if (raced.ready && Array.isArray(raced.list)) {
      const items = instagramLikes.filterLikeServices(raced.list);
      return res.json({
        items,
        cheapest: instagramLikes.pickCheapest(items),
        instantCheap: instagramLikes.pickInstantCheap(items),
        defaultServiceId: instagramLikes.defaultServiceId(),
        count: items.length,
        cached: !force,
        partial: false,
      });
    }

    listPromise.catch(() => {});
    res.json({
      items: starter,
      cheapest: instagramLikes.pickCheapest(starter),
      instantCheap: instagramLikes.pickInstantCheap(starter),
      defaultServiceId: instagramLikes.defaultServiceId(),
      count: starter.length,
      cached: false,
      partial: true,
    });
  } catch (e) {
    const items = instagramLikes.FALLBACK_SERVICES.slice();
    res.json({
      items,
      cheapest: instagramLikes.pickCheapest(items),
      instantCheap: instagramLikes.pickInstantCheap(items),
      defaultServiceId: instagramLikes.defaultServiceId(),
      count: items.length,
      cached: false,
      partial: true,
      error: e.message,
    });
  }
});

app.get("/api/instagram-likes/orders", (req, res) => {
  const data = db.read();
  res.json(instagramLikes.listInstagramLikeOrders(data, req.query));
});

app.post("/api/instagram-likes/order", async (req, res) => {
  try {
    const data = db.read();
    instagramLikes.ensureInstagramLikesStore(data);

    const link = instagramLikes.normalizePostUrl(
      req.body?.link ||
        req.body?.postUrl ||
        data.settings.instagramLikesPostUrl ||
        instagramLikes.defaultPostUrl()
    );
    if (!link) {
      return res.status(400).json({
        error:
          "Invalid Instagram post URL. Paste a /p/ or /reel/ link — not a profile.",
      });
    }

    const serviceId = Number(
      req.body?.serviceId ||
        data.settings.instagramLikesServiceId ||
        instagramLikes.defaultServiceId()
    );
    if (!Number.isFinite(serviceId) || serviceId <= 0) {
      return res.status(400).json({ error: "Invalid service id" });
    }

    let quantity = Math.floor(Number(req.body?.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ error: "Quantity must be a positive number" });
    }

    const cached = jap.peekServices();
    const fromCache = cached
      ? cached.find((s) => Number(s.service) === Number(serviceId))
      : null;
    const svcMeta =
      instagramLikes.mapService(fromCache) ||
      instagramLikes.fallbackService(serviceId) ||
      null;

    if (svcMeta) {
      const min = Number(svcMeta.min) || 1;
      const max = Number(svcMeta.max) || quantity;
      if (quantity < min) {
        return res.status(400).json({
          error: `Quantity below service min (${min})`,
          min,
          max,
        });
      }
      if (quantity > max) {
        return res.status(400).json({
          error: `Quantity above service max (${max})`,
          min,
          max,
        });
      }
    }

    const live = worker.isLive();
    const mode = live ? "live" : "dry-run";
    const orderId = db.uid("igl");
    const record = {
      id: orderId,
      kind: "instagram_likes",
      link,
      serviceId,
      quantity,
      mode,
      status: live ? "submitted" : "simulated",
      japOrderId: null,
      charge: null,
      serviceName: svcMeta?.name || null,
      rate: svcMeta?.rate || null,
      note: req.body?.note ? String(req.body.note).slice(0, 120) : null,
      at: new Date().toISOString(),
      error: null,
    };

    if (live) {
      const japRes = await jap.addOrder({
        service: serviceId,
        link,
        quantity,
        allowLiveSpend: true,
      });
      record.japOrderId = japRes?.order != null ? String(japRes.order) : null;
      record.status = "submitted";
    } else {
      record.japOrderId = `DRY_IGL_${Date.now()}`;
      record.status = "simulated";
    }

    db.update((dbx) => {
      instagramLikes.ensureInstagramLikesStore(dbx);
      dbx.settings.instagramLikesPostUrl = link;
      dbx.settings.instagramLikesServiceId = serviceId;
      dbx.instagramLikeOrders.unshift(record);
      dbx.instagramLikeOrders = dbx.instagramLikeOrders.slice(
        0,
        instagramLikes.MAX_ORDERS
      );
    });

    db.logEvent(
      "instagram_likes_order",
      `${mode === "live" ? "LIVE" : "DRY"} +${quantity} likes → ${link}`,
      { orderId, serviceId, japOrderId: record.japOrderId }
    );

    res.json({ ok: true, order: record, live });
  } catch (e) {
    const status = e.code === "LIVE_BLOCKED" ? 400 : 500;
    res.status(status).json({ error: e.message, jap: e.jap || null });
  }
});

app.post("/api/instagram-likes/orders/refresh-status", async (req, res) => {
  try {
    const limit = Math.min(30, Math.max(1, Number(req.body?.limit) || 15));
    const data = db.read();
    instagramLikes.ensureInstagramLikesStore(data);
    const live = data.instagramLikeOrders
      .filter(
        (o) =>
          o.mode === "live" &&
          o.japOrderId &&
          !String(o.japOrderId).startsWith("DRY_")
      )
      .slice(0, limit);

    const updated = [];
    const errors = [];

    for (const order of live) {
      try {
        const st = await jap.getOrderStatus(order.japOrderId);
        db.update((dbx) => {
          instagramLikes.ensureInstagramLikesStore(dbx);
          const row = dbx.instagramLikeOrders.find((x) => x.id === order.id);
          if (row) instagramLikes.applyJapStatus(row, st);
        });
        updated.push(order.id);
      } catch (e) {
        errors.push({ id: order.id, error: e.message });
      }
      await new Promise((r) => setTimeout(r, 120));
    }

    db.logEvent(
      "instagram_likes_orders_refresh",
      `Refreshed ${updated.length}/${live.length} IG likes order statuses`
    );
    res.json({
      ok: true,
      checked: live.length,
      updated: updated.length,
      errors,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── X / Twitter post likes & comments ─────────────────────────────

app.get("/api/twitter-posts/settings", (_req, res) => {
  const data = db.read();
  twitterPosts.ensureTwitterPostsStore(data);
  const envLive =
    String(process.env.LIVE_MODE || "false").toLowerCase() === "true";
  const task = data.settings.twitterPostTask || twitterPosts.DEFAULT_TASK;
  const serviceId =
    Number(data.settings.twitterPostServiceId) ||
    twitterPosts.defaultServiceId(task);

  const cached = jap.peekServices();
  const fromCache = cached
    ? cached.find((s) => Number(s.service) === Number(serviceId))
    : null;
  const service =
    twitterPosts.mapService(fromCache, task) ||
    twitterPosts.fallbackService(serviceId, task);

  const catalog = cached || twitterPosts.FALLBACK_SERVICES;
  const tasks = twitterPosts.buildTaskMenu(catalog);

  jap.getServices().catch(() => {});

  res.json({
    liveMode: worker.isLive(),
    envLiveMode: envLive,
    liveAllowedByEnv: envLive,
    hasApiKey: Boolean(process.env.JAP_API_KEY),
    task,
    serviceId,
    defaultServiceId: twitterPosts.defaultServiceId(task),
    postUrl: data.settings.twitterPostUrl || twitterPosts.defaultPostUrl(),
    commentStyle: data.settings.twitterPostCommentStyle || "custom",
    comments: data.settings.twitterPostComments || "",
    service,
    tasks,
    taskTypes: twitterPosts.TASK_TYPES.map((t) => ({
      id: t.id,
      label: t.label,
      short: t.short,
      blurb: t.blurb,
      unit: t.unit,
      icon: t.icon,
    })),
  });
});

app.post("/api/twitter-posts/settings", (req, res) => {
  const { serviceId, postUrl, task, commentStyle, comments } = req.body || {};
  const taskId = task ? String(task).toLowerCase() : null;
  if (taskId && !twitterPosts.taskDef(taskId)) {
    return res.status(400).json({ error: "Unknown task type (likes or comments)" });
  }
  const style =
    commentStyle != null ? String(commentStyle).toLowerCase() : null;
  if (style && style !== "custom" && style !== "random") {
    return res.status(400).json({ error: "commentStyle must be custom or random" });
  }
  const link =
    postUrl != null ? twitterPosts.normalizePostUrl(postUrl) : null;
  if (postUrl != null && postUrl !== "" && !link) {
    return res.status(400).json({
      error:
        "Invalid X post URL. Use https://x.com/user/status/1234567890",
    });
  }
  const commentLines =
    comments != null ? twitterPosts.parseCommentLines(comments) : null;
  db.update((dbx) => {
    twitterPosts.ensureTwitterPostsStore(dbx);
    if (taskId) dbx.settings.twitterPostTask = taskId;
    if (serviceId != null && Number(serviceId) > 0) {
      dbx.settings.twitterPostServiceId = Number(serviceId);
    }
    if (link) dbx.settings.twitterPostUrl = link;
    if (style) dbx.settings.twitterPostCommentStyle = style;
    if (commentLines) {
      dbx.settings.twitterPostComments = commentLines.join("\n").slice(0, 8000);
    }
  });
  const data = db.read();
  res.json({
    ok: true,
    task: data.settings.twitterPostTask,
    serviceId: data.settings.twitterPostServiceId,
    postUrl: data.settings.twitterPostUrl,
    commentStyle: data.settings.twitterPostCommentStyle,
    comments: data.settings.twitterPostComments,
  });
});

app.get("/api/twitter-posts/services", async (req, res) => {
  try {
    const force = String(req.query.refresh || "") === "1";
    const task =
      String(
        req.query.task || db.read().settings?.twitterPostTask || ""
      ).toLowerCase() || twitterPosts.DEFAULT_TASK;
    const commentStyle =
      String(
        req.query.style ||
          db.read().settings?.twitterPostCommentStyle ||
          "custom"
      ).toLowerCase() || "custom";
    const serviceId =
      Number(db.read().settings?.twitterPostServiceId) ||
      twitterPosts.defaultServiceId(task);

    const filterOpts =
      task === "comments" ? { commentStyle } : {};

    const starter = twitterPosts.filterServicesForTask(
      twitterPosts.FALLBACK_SERVICES,
      task,
      filterOpts
    );

    const listPromise = jap.getServices({ force });
    const raced = await Promise.race([
      listPromise.then((list) => ({ ready: true, list })),
      new Promise((resolve) =>
        setTimeout(() => resolve({ ready: false, list: null }), 1200)
      ),
    ]);

    const cheapestOf = (items) =>
      task === "comments" && commentStyle === "custom"
        ? twitterPosts.pickOurTypeComments(items) ||
          twitterPosts.pickCheapest(items)
        : twitterPosts.pickCheapest(items);

    if (raced.ready && Array.isArray(raced.list)) {
      const items = twitterPosts.filterServicesForTask(
        raced.list,
        task,
        filterOpts
      );
      const tasks = twitterPosts.buildTaskMenu(raced.list);
      return res.json({
        task,
        commentStyle: task === "comments" ? commentStyle : null,
        items,
        tasks,
        cheapest: cheapestOf(items),
        instantCheap: twitterPosts.pickInstantCheap(items),
        defaultServiceId: twitterPosts.defaultServiceId(task),
        preferredServiceId: serviceId,
        count: items.length,
        partial: false,
      });
    }

    listPromise.catch(() => {});
    res.json({
      task,
      commentStyle: task === "comments" ? commentStyle : null,
      items: starter,
      tasks: twitterPosts.buildTaskMenu(twitterPosts.FALLBACK_SERVICES),
      cheapest: cheapestOf(starter),
      instantCheap: twitterPosts.pickInstantCheap(starter),
      defaultServiceId: twitterPosts.defaultServiceId(task),
      preferredServiceId: serviceId,
      count: starter.length,
      partial: true,
    });
  } catch (e) {
    const task = twitterPosts.DEFAULT_TASK;
    const items = twitterPosts.filterServicesForTask(
      twitterPosts.FALLBACK_SERVICES,
      task
    );
    res.json({
      task,
      items,
      tasks: twitterPosts.buildTaskMenu(twitterPosts.FALLBACK_SERVICES),
      cheapest: twitterPosts.pickCheapest(items),
      instantCheap: twitterPosts.pickInstantCheap(items),
      defaultServiceId: twitterPosts.defaultServiceId(task),
      partial: true,
      error: e.message,
    });
  }
});

app.get("/api/twitter-posts/orders", (req, res) => {
  const data = db.read();
  res.json(twitterPosts.listTwitterPostOrders(data, req.query));
});

app.post("/api/twitter-posts/order", async (req, res) => {
  try {
    const data = db.read();
    twitterPosts.ensureTwitterPostsStore(data);

    const task =
      String(
        req.body?.task || data.settings.twitterPostTask || ""
      ).toLowerCase() || twitterPosts.DEFAULT_TASK;
    if (!twitterPosts.taskDef(task)) {
      return res.status(400).json({ error: "Unknown task type" });
    }

    const link = twitterPosts.normalizePostUrl(
      req.body?.link ||
        req.body?.postUrl ||
        data.settings.twitterPostUrl ||
        twitterPosts.defaultPostUrl()
    );
    if (!link) {
      return res.status(400).json({
        error:
          "Invalid X post URL. Paste a /status/ link — not a profile.",
      });
    }

    const serviceId = Number(
      req.body?.serviceId ||
        data.settings.twitterPostServiceId ||
        twitterPosts.defaultServiceId(task)
    );
    if (!Number.isFinite(serviceId) || serviceId <= 0) {
      return res.status(400).json({ error: "Invalid service id" });
    }

    const cached = jap.peekServices();
    const fromCache = cached
      ? cached.find((s) => Number(s.service) === Number(serviceId))
      : null;
    const svcMeta =
      twitterPosts.mapService(fromCache, task) ||
      twitterPosts.fallbackService(serviceId, task) ||
      null;

    const commentLines = twitterPosts.parseCommentLines(req.body?.comments);
    const wantsCustom =
      task === "comments" &&
      (twitterPosts.isCustomCommentService(svcMeta) ||
        String(req.body?.commentStyle || "").toLowerCase() === "custom");

    let quantity = Math.floor(Number(req.body?.quantity));
    if (task === "comments" && wantsCustom) {
      if (!commentLines.length) {
        return res.status(400).json({
          error:
            "Custom comments need your lines. Paste one comment per line.",
        });
      }
      if (!Number.isFinite(quantity) || quantity <= 0) {
        quantity = commentLines.length;
      }
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ error: "Quantity must be a positive number" });
    }

    if (svcMeta) {
      const min = Number(svcMeta.min) || 1;
      const max = Number(svcMeta.max) || quantity;
      if (quantity < min) {
        return res.status(400).json({
          error: `Quantity below this service min (${min}). Raise qty or pick a service with a lower min.`,
          min,
          max,
        });
      }
      if (quantity > max) {
        return res.status(400).json({
          error: `Quantity above this service max (${max})`,
          min,
          max,
        });
      }
    }

    const japComments =
      wantsCustom
        ? twitterPosts.expandCommentLines(commentLines, quantity)
        : [];

    const live = worker.isLive();
    const mode = live ? "live" : "dry-run";
    const orderId = db.uid("twp");
    const record = {
      id: orderId,
      kind: `twitter_${task}`,
      task,
      link,
      serviceId,
      quantity,
      mode,
      status: live ? "submitted" : "simulated",
      japOrderId: null,
      charge: null,
      serviceName: svcMeta?.name || null,
      rate: svcMeta?.rate || null,
      commentStyle: wantsCustom ? "custom" : task === "comments" ? "random" : null,
      commentsCount: japComments.length || commentLines.length || null,
      commentsPreview: (japComments.length ? japComments : commentLines).slice(
        0,
        8
      ),
      note: req.body?.note ? String(req.body.note).slice(0, 120) : null,
      at: new Date().toISOString(),
      error: null,
    };

    if (live) {
      const japRes = await jap.addOrder({
        service: serviceId,
        link,
        quantity,
        comments: wantsCustom
          ? twitterPosts.commentsParam(japComments)
          : undefined,
        allowLiveSpend: true,
      });
      record.japOrderId = japRes?.order != null ? String(japRes.order) : null;
      record.status = "submitted";
    } else {
      record.japOrderId = `DRY_TWP_${Date.now()}`;
      record.status = "simulated";
    }

    db.update((dbx) => {
      twitterPosts.ensureTwitterPostsStore(dbx);
      dbx.settings.twitterPostUrl = link;
      dbx.settings.twitterPostTask = task;
      dbx.settings.twitterPostServiceId = serviceId;
      if (task === "comments") {
        dbx.settings.twitterPostCommentStyle = wantsCustom ? "custom" : "random";
        if (commentLines.length) {
          dbx.settings.twitterPostComments = commentLines.join("\n").slice(0, 8000);
        }
      }
      dbx.twitterPostOrders.unshift(record);
      dbx.twitterPostOrders = dbx.twitterPostOrders.slice(
        0,
        twitterPosts.MAX_ORDERS
      );
    });

    db.logEvent(
      `twitter_${task}_order`,
      `${mode === "live" ? "LIVE" : "DRY"} +${quantity} ${task} → ${link}`,
      { orderId, serviceId, japOrderId: record.japOrderId, task }
    );

    res.json({ ok: true, order: record, live });
  } catch (e) {
    const status = e.code === "LIVE_BLOCKED" ? 400 : 500;
    res.status(status).json({ error: e.message, jap: e.jap || null });
  }
});

app.post("/api/twitter-posts/orders/refresh-status", async (req, res) => {
  try {
    const limit = Math.min(30, Math.max(1, Number(req.body?.limit) || 15));
    const data = db.read();
    twitterPosts.ensureTwitterPostsStore(data);
    const live = data.twitterPostOrders
      .filter(
        (o) =>
          o.mode === "live" &&
          o.japOrderId &&
          !String(o.japOrderId).startsWith("DRY_")
      )
      .slice(0, limit);

    const updated = [];
    const errors = [];

    for (const order of live) {
      try {
        const st = await jap.getOrderStatus(order.japOrderId);
        db.update((dbx) => {
          twitterPosts.ensureTwitterPostsStore(dbx);
          const row = dbx.twitterPostOrders.find((x) => x.id === order.id);
          if (row) twitterPosts.applyJapStatus(row, st);
        });
        updated.push(order.id);
      } catch (err) {
        errors.push({ id: order.id, error: err.message });
      }
    }

    db.logEvent(
      "twitter_posts_orders_refresh",
      `Refreshed ${updated.length}/${live.length} X post order statuses`
    );
    res.json({
      ok: true,
      checked: live.length,
      updated: updated.length,
      errors,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── X / Twitter post views (separate page) ────────────────────────

app.get("/api/twitter-views/settings", (_req, res) => {
  const data = db.read();
  twitterViews.ensureTwitterViewsStore(data);
  const envLive =
    String(process.env.LIVE_MODE || "false").toLowerCase() === "true";
  const serviceId =
    Number(data.settings.twitterViewsServiceId) ||
    twitterViews.defaultServiceId();

  const cached = jap.peekServices();
  const fromCache = cached
    ? cached.find((s) => Number(s.service) === Number(serviceId))
    : null;
  const service =
    twitterViews.mapService(fromCache) ||
    twitterViews.fallbackService(serviceId);

  const catalog = cached
    ? twitterViews.filterViewServices(cached)
    : twitterViews.FALLBACK_SERVICES;
  const cheapest = twitterViews.pickCheapest(catalog);
  const instantCheap = twitterViews.pickInstantCheap(catalog);

  jap.getServices().catch(() => {});

  res.json({
    liveMode: worker.isLive(),
    envLiveMode: envLive,
    liveAllowedByEnv: envLive,
    hasApiKey: Boolean(process.env.JAP_API_KEY),
    serviceId,
    defaultServiceId: twitterViews.defaultServiceId(),
    postUrl:
      data.settings.twitterViewsPostUrl || twitterViews.defaultPostUrl(),
    service,
    cheapest,
    instantCheap,
  });
});

app.post("/api/twitter-views/settings", (req, res) => {
  const { serviceId, postUrl } = req.body || {};
  const link =
    postUrl != null ? twitterViews.normalizePostUrl(postUrl) : null;
  if (postUrl != null && postUrl !== "" && !link) {
    return res.status(400).json({
      error:
        "Invalid X post URL. Use https://x.com/user/status/1234567890",
    });
  }
  db.update((dbx) => {
    twitterViews.ensureTwitterViewsStore(dbx);
    if (serviceId != null && Number(serviceId) > 0) {
      dbx.settings.twitterViewsServiceId = Number(serviceId);
    }
    if (link) dbx.settings.twitterViewsPostUrl = link;
  });
  const data = db.read();
  res.json({
    ok: true,
    serviceId: data.settings.twitterViewsServiceId,
    postUrl: data.settings.twitterViewsPostUrl,
  });
});

app.get("/api/twitter-views/services", async (req, res) => {
  try {
    const force = String(req.query.refresh || "") === "1";
    const serviceId =
      Number(db.read().settings?.twitterViewsServiceId) ||
      twitterViews.defaultServiceId();

    const starter = twitterViews.FALLBACK_SERVICES.slice();
    if (!starter.some((s) => s.service === serviceId)) {
      const fb = twitterViews.fallbackService(serviceId);
      if (fb) starter.unshift(fb);
    }

    const listPromise = jap.getServices({ force });
    const raced = await Promise.race([
      listPromise.then((list) => ({ ready: true, list })),
      new Promise((resolve) =>
        setTimeout(() => resolve({ ready: false, list: null }), 1200)
      ),
    ]);

    if (raced.ready && Array.isArray(raced.list)) {
      const items = twitterViews.filterViewServices(raced.list);
      return res.json({
        items,
        cheapest: twitterViews.pickCheapest(items),
        instantCheap: twitterViews.pickInstantCheap(items),
        defaultServiceId: twitterViews.defaultServiceId(),
        count: items.length,
        cached: !force,
        partial: false,
      });
    }

    listPromise.catch(() => {});
    res.json({
      items: starter,
      cheapest: twitterViews.pickCheapest(starter),
      instantCheap: twitterViews.pickInstantCheap(starter),
      defaultServiceId: twitterViews.defaultServiceId(),
      count: starter.length,
      cached: false,
      partial: true,
    });
  } catch (e) {
    const items = twitterViews.FALLBACK_SERVICES.slice();
    res.json({
      items,
      cheapest: twitterViews.pickCheapest(items),
      instantCheap: twitterViews.pickInstantCheap(items),
      defaultServiceId: twitterViews.defaultServiceId(),
      count: items.length,
      cached: false,
      partial: true,
      error: e.message,
    });
  }
});

app.get("/api/twitter-views/orders", (req, res) => {
  const data = db.read();
  res.json(twitterViews.listTwitterViewOrders(data, req.query));
});

app.post("/api/twitter-views/order", async (req, res) => {
  try {
    const data = db.read();
    twitterViews.ensureTwitterViewsStore(data);

    const link = twitterViews.normalizePostUrl(
      req.body?.link ||
        req.body?.postUrl ||
        data.settings.twitterViewsPostUrl ||
        twitterViews.defaultPostUrl()
    );
    if (!link) {
      return res.status(400).json({
        error:
          "Invalid X post URL. Paste a /status/ link — not a profile.",
      });
    }

    const serviceId = Number(
      req.body?.serviceId ||
        data.settings.twitterViewsServiceId ||
        twitterViews.defaultServiceId()
    );
    if (!Number.isFinite(serviceId) || serviceId <= 0) {
      return res.status(400).json({ error: "Invalid service id" });
    }
    if (twitterViews.UNSAFE_SERVICE_IDS.has(serviceId)) {
      return res.status(400).json({
        error:
          "Service is not tweet views (old fallback was likes/retweets). Pick Tweet Views #8413.",
      });
    }

    let quantity = Math.floor(Number(req.body?.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ error: "Quantity must be a positive number" });
    }

    let catalog = jap.peekServices();
    if (!catalog || !catalog.length) {
      try {
        catalog = await jap.getServices();
      } catch (_) {
        catalog = null;
      }
    }
    const fromCache = catalog
      ? catalog.find((s) => Number(s.service) === Number(serviceId))
      : null;

    if (fromCache && !twitterViews.isTwitterViewService(fromCache)) {
      return res.status(400).json({
        error: `Service #${serviceId} is ${fromCache.name} — not tweet views. That will not raise the public view count on X.`,
      });
    }
    if (!fromCache) {
      const known = twitterViews.FALLBACK_SERVICES.some(
        (s) => Number(s.service) === serviceId
      );
      if (!known) {
        return res.status(400).json({
          error:
            "Unknown views service. Wait for the catalog, then pick a Tweet Views lane.",
        });
      }
    }

    const svcMeta =
      twitterViews.mapService(fromCache) ||
      twitterViews.fallbackService(serviceId) ||
      null;

    if (svcMeta) {
      const min = Number(svcMeta.min) || 1;
      const max = Number(svcMeta.max) || quantity;
      if (quantity < min) {
        return res.status(400).json({
          error: `Quantity below service min (${min})`,
          min,
          max,
        });
      }
      if (quantity > max) {
        return res.status(400).json({
          error: `Quantity above service max (${max})`,
          min,
          max,
        });
      }
    }

    const live = worker.isLive();
    const mode = live ? "live" : "dry-run";
    const orderId = db.uid("twv");
    const record = {
      id: orderId,
      kind: "twitter_views",
      link,
      serviceId,
      quantity,
      mode,
      status: live ? "submitted" : "simulated",
      japOrderId: null,
      charge: null,
      serviceName: svcMeta?.name || null,
      serviceCategory: svcMeta?.category || null,
      viewKind: svcMeta?.viewKind || twitterViews.viewKind(svcMeta),
      rate: svcMeta?.rate || null,
      note: req.body?.note ? String(req.body.note).slice(0, 120) : null,
      at: new Date().toISOString(),
      error: null,
    };

    if (live) {
      const japRes = await jap.addOrder({
        service: serviceId,
        link,
        quantity,
        allowLiveSpend: true,
      });
      record.japOrderId = japRes?.order != null ? String(japRes.order) : null;
      record.status = "submitted";
    } else {
      record.japOrderId = `DRY_TWV_${Date.now()}`;
      record.status = "simulated";
    }

    db.update((dbx) => {
      twitterViews.ensureTwitterViewsStore(dbx);
      dbx.settings.twitterViewsPostUrl = link;
      dbx.settings.twitterViewsServiceId = serviceId;
      dbx.twitterViewOrders.unshift(record);
      dbx.twitterViewOrders = dbx.twitterViewOrders.slice(
        0,
        twitterViews.MAX_ORDERS
      );
    });

    db.logEvent(
      "twitter_views_order",
      `${mode === "live" ? "LIVE" : "DRY"} +${quantity} views → ${link}`,
      { orderId, serviceId, japOrderId: record.japOrderId }
    );

    res.json({ ok: true, order: record, live });
  } catch (e) {
    const status = e.code === "LIVE_BLOCKED" ? 400 : 500;
    res.status(status).json({ error: e.message, jap: e.jap || null });
  }
});

app.post("/api/twitter-views/orders/refresh-status", async (req, res) => {
  try {
    const limit = Math.min(30, Math.max(1, Number(req.body?.limit) || 15));
    const data = db.read();
    twitterViews.ensureTwitterViewsStore(data);
    const live = data.twitterViewOrders
      .filter(
        (o) =>
          o.mode === "live" &&
          o.japOrderId &&
          !String(o.japOrderId).startsWith("DRY_")
      )
      .slice(0, limit);

    const updated = [];
    const errors = [];

    for (const order of live) {
      try {
        const st = await jap.getOrderStatus(order.japOrderId);
        db.update((dbx) => {
          twitterViews.ensureTwitterViewsStore(dbx);
          const row = dbx.twitterViewOrders.find((x) => x.id === order.id);
          if (row) twitterViews.applyJapStatus(row, st);
        });
        updated.push(order.id);
      } catch (err) {
        errors.push({ id: order.id, error: err.message });
      }
      await new Promise((r) => setTimeout(r, 120));
    }

    db.logEvent(
      "twitter_views_orders_refresh",
      `Refreshed ${updated.length}/${live.length} X view order statuses`
    );
    res.json({
      ok: true,
      checked: live.length,
      updated: updated.length,
      errors,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── YouTube task desk ─────────────────────────────────────────────

app.get("/api/youtube/settings", (_req, res) => {
  const data = db.read();
  youtube.ensureYoutubeStore(data);
  const envLive =
    String(process.env.LIVE_MODE || "false").toLowerCase() === "true";
  const task = data.settings.youtubeTask || youtube.DEFAULT_TASK;
  const serviceId =
    Number(data.settings.youtubeServiceId) || youtube.defaultServiceId(task);

  const cached = jap.peekServices();
  const fromCache = cached
    ? cached.find((s) => Number(s.service) === Number(serviceId))
    : null;
  const service =
    youtube.mapService(fromCache, task) ||
    youtube.fallbackService(serviceId, task);

  const catalog = cached || youtube.FALLBACK_SERVICES;
  const tasks = youtube.buildTaskMenu(catalog);

  jap.getServices().catch(() => {});

  res.json({
    liveMode: worker.isLive(),
    envLiveMode: envLive,
    liveAllowedByEnv: envLive,
    hasApiKey: Boolean(process.env.JAP_API_KEY),
    task,
    serviceId,
    defaultServiceId: youtube.defaultServiceId(task),
    linkUrl:
      data.settings.youtubeLinkUrl || youtube.SOLID_ACCOUNT.profileUrl,
    channelUrl: youtube.SOLID_ACCOUNT.profileUrl,
    account: youtube.SOLID_ACCOUNT,
    service,
    tasks,
    taskTypes: youtube.TASK_TYPES.map((t) => ({
      id: t.id,
      label: t.label,
      short: t.short,
      blurb: t.blurb,
      linkKind: t.linkKind,
      unit: t.unit,
      icon: t.icon,
    })),
  });
});

app.post("/api/youtube/settings", (req, res) => {
  const { serviceId, linkUrl, task } = req.body || {};
  const taskId = task ? String(task).toLowerCase() : null;
  if (taskId && !youtube.taskDef(taskId)) {
    return res.status(400).json({ error: "Unknown YouTube task type" });
  }
  let link =
    linkUrl != null ? youtube.normalizeYoutubeUrl(linkUrl) : null;
  if (linkUrl != null && !link) {
    return res.status(400).json({
      error:
        "Invalid YouTube URL. Use a watch link, youtu.be, Shorts, or channel / @handle",
    });
  }
  // Subscribers always lock to the solid channel
  if (taskId === "subscribers" || (!taskId && link && youtube.linkKindOf(link) === "channel")) {
    if (taskId === "subscribers") link = youtube.SOLID_ACCOUNT.profileUrl;
  }
  db.update((dbx) => {
    youtube.ensureYoutubeStore(dbx);
    if (taskId) dbx.settings.youtubeTask = taskId;
    if (serviceId != null && Number(serviceId) > 0) {
      dbx.settings.youtubeServiceId = Number(serviceId);
    }
    if (link) dbx.settings.youtubeLinkUrl = link;
    dbx.settings.youtubeChannelUrl = youtube.SOLID_ACCOUNT.profileUrl;
  });
  const data = db.read();
  res.json({
    ok: true,
    task: data.settings.youtubeTask,
    serviceId: data.settings.youtubeServiceId,
    linkUrl: data.settings.youtubeLinkUrl,
    channelUrl: youtube.SOLID_ACCOUNT.profileUrl,
    account: youtube.SOLID_ACCOUNT,
  });
});

app.get("/api/youtube/services", async (req, res) => {
  try {
    const force = String(req.query.refresh || "") === "1";
    const task =
      String(req.query.task || db.read().settings?.youtubeTask || "").toLowerCase() ||
      youtube.DEFAULT_TASK;
    const serviceId =
      Number(db.read().settings?.youtubeServiceId) ||
      youtube.defaultServiceId(task);

    const starter = youtube.filterServicesForTask(
      youtube.FALLBACK_SERVICES,
      task
    );

    const listPromise = jap.getServices({ force });
    const raced = await Promise.race([
      listPromise.then((list) => ({ ready: true, list })),
      new Promise((resolve) =>
        setTimeout(() => resolve({ ready: false, list: null }), 1200)
      ),
    ]);

    if (raced.ready && Array.isArray(raced.list)) {
      const items = youtube.filterServicesForTask(raced.list, task);
      const tasks = youtube.buildTaskMenu(raced.list);
      return res.json({
        task,
        items,
        tasks,
        cheapest: youtube.pickCheapest(items),
        instantCheap: youtube.pickInstantCheap(items),
        defaultServiceId: youtube.defaultServiceId(task),
        preferredServiceId: serviceId,
        partial: false,
      });
    }

    listPromise.catch(() => {});
    res.json({
      task,
      items: starter,
      tasks: youtube.buildTaskMenu(youtube.FALLBACK_SERVICES),
      cheapest: youtube.pickCheapest(starter),
      instantCheap: youtube.pickInstantCheap(starter),
      defaultServiceId: youtube.defaultServiceId(task),
      preferredServiceId: serviceId,
      partial: true,
    });
  } catch (e) {
    const task = youtube.DEFAULT_TASK;
    const items = youtube.filterServicesForTask(
      youtube.FALLBACK_SERVICES,
      task
    );
    res.json({
      task,
      items,
      tasks: youtube.buildTaskMenu(youtube.FALLBACK_SERVICES),
      cheapest: youtube.pickCheapest(items),
      instantCheap: youtube.pickInstantCheap(items),
      defaultServiceId: youtube.defaultServiceId(task),
      partial: true,
      error: e.message,
    });
  }
});

app.get("/api/youtube/tasks", async (_req, res) => {
  try {
    const cached = jap.peekServices();
    if (cached) {
      return res.json({ tasks: youtube.buildTaskMenu(cached), partial: false });
    }
    const listPromise = jap.getServices();
    const raced = await Promise.race([
      listPromise.then((list) => ({ ready: true, list })),
      new Promise((resolve) =>
        setTimeout(() => resolve({ ready: false, list: null }), 1200)
      ),
    ]);
    if (raced.ready && Array.isArray(raced.list)) {
      return res.json({
        tasks: youtube.buildTaskMenu(raced.list),
        partial: false,
      });
    }
    listPromise.catch(() => {});
    res.json({
      tasks: youtube.buildTaskMenu(youtube.FALLBACK_SERVICES),
      partial: true,
    });
  } catch (e) {
    res.json({
      tasks: youtube.buildTaskMenu(youtube.FALLBACK_SERVICES),
      partial: true,
      error: e.message,
    });
  }
});

app.get("/api/youtube/orders", (req, res) => {
  const data = db.read();
  res.json(youtube.listYoutubeOrders(data, req.query));
});

app.post("/api/youtube/order", async (req, res) => {
  try {
    const data = db.read();
    youtube.ensureYoutubeStore(data);

    const taskId = String(
      req.body?.task || data.settings.youtubeTask || youtube.DEFAULT_TASK
    ).toLowerCase();
    const task = youtube.taskDef(taskId);
    if (!task) {
      return res.status(400).json({ error: "Unknown YouTube task type" });
    }

    // Subscribers always fire into the locked solid channel
    let link =
      taskId === "subscribers"
        ? youtube.SOLID_ACCOUNT.profileUrl
        : youtube.normalizeYoutubeUrl(
            req.body?.link ||
              req.body?.linkUrl ||
              data.settings.youtubeLinkUrl ||
              youtube.defaultLinkUrl()
          );
    if (!link) {
      return res.status(400).json({
        error:
          "Invalid YouTube URL. Use a watch link, youtu.be, Shorts, or channel / @handle",
      });
    }
    if (task.linkKind === "video" && youtube.linkKindOf(link) === "channel") {
      return res.status(400).json({
        error: `Paste a video URL from @${youtube.SOLID_ACCOUNT.handle} for ${task.label}`,
      });
    }

    const serviceId = Number(
      req.body?.serviceId ||
        data.settings.youtubeServiceId ||
        youtube.defaultServiceId(taskId)
    );
    if (!Number.isFinite(serviceId) || serviceId <= 0) {
      return res.status(400).json({ error: "Invalid service id" });
    }

    let quantity = Math.floor(Number(req.body?.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ error: "Quantity must be a positive number" });
    }

    const cached = jap.peekServices();
    const fromCache = cached
      ? cached.find((s) => Number(s.service) === Number(serviceId))
      : null;
    const svcMeta =
      youtube.mapService(fromCache, taskId) ||
      youtube.fallbackService(serviceId, taskId) ||
      null;

    if (svcMeta) {
      const min = Number(svcMeta.min) || 1;
      const max = Number(svcMeta.max) || quantity;
      if (quantity < min) {
        return res.status(400).json({
          error: `Quantity below service min (${min})`,
          min,
          max,
        });
      }
      if (quantity > max) {
        return res.status(400).json({
          error: `Quantity above service max (${max})`,
          min,
          max,
        });
      }
    }

    const live = worker.isLive();
    const mode = live ? "live" : "dry-run";
    const orderId = db.uid("yt");
    const est = youtube.estCost(svcMeta, quantity);
    const record = {
      id: orderId,
      kind: `youtube_${taskId}`,
      task: taskId,
      link,
      serviceId,
      quantity,
      mode,
      status: live ? "submitted" : "simulated",
      japOrderId: null,
      charge: null,
      serviceName: svcMeta?.name || null,
      rate: svcMeta?.rate || null,
      estCost: est,
      note: req.body?.note ? String(req.body.note).slice(0, 120) : null,
      at: new Date().toISOString(),
      error: null,
    };

    if (live) {
      const japRes = await jap.addOrder({
        service: serviceId,
        link,
        quantity,
        allowLiveSpend: true,
      });
      record.japOrderId = japRes?.order != null ? String(japRes.order) : null;
      record.status = "submitted";
    } else {
      record.japOrderId = `DRY_YT_${Date.now()}`;
      record.status = "simulated";
    }

    db.update((dbx) => {
      youtube.ensureYoutubeStore(dbx);
      dbx.settings.youtubeLinkUrl = link;
      dbx.settings.youtubeServiceId = serviceId;
      dbx.settings.youtubeTask = taskId;
      dbx.youtubeOrders.unshift(record);
      dbx.youtubeOrders = dbx.youtubeOrders.slice(0, youtube.MAX_ORDERS);
    });

    db.logEvent(
      "youtube_order",
      `${mode === "live" ? "LIVE" : "DRY"} +${quantity} ${task.unit} → ${link}`,
      { orderId, serviceId, task: taskId, japOrderId: record.japOrderId, estCost: est }
    );

    res.json({ ok: true, order: record, live, estCost: est });
  } catch (e) {
    const status = e.code === "LIVE_BLOCKED" ? 400 : 500;
    res.status(status).json({ error: e.message, jap: e.jap || null });
  }
});

app.post("/api/youtube/orders/refresh-status", async (req, res) => {
  try {
    const limit = Math.min(30, Math.max(1, Number(req.body?.limit) || 15));
    const data = db.read();
    youtube.ensureYoutubeStore(data);
    const live = data.youtubeOrders
      .filter(
        (o) =>
          o.mode === "live" &&
          o.japOrderId &&
          !String(o.japOrderId).startsWith("DRY_")
      )
      .slice(0, limit);

    const updated = [];
    const errors = [];

    for (const order of live) {
      try {
        const st = await jap.getOrderStatus(order.japOrderId);
        db.update((dbx) => {
          youtube.ensureYoutubeStore(dbx);
          const row = dbx.youtubeOrders.find((x) => x.id === order.id);
          if (row) youtube.applyJapStatus(row, st);
        });
        updated.push(order.id);
      } catch (e) {
        errors.push({ id: order.id, error: e.message });
      }
      await new Promise((r) => setTimeout(r, 120));
    }

    db.logEvent(
      "youtube_orders_refresh",
      `Refreshed ${updated.length}/${live.length} YouTube order statuses`
    );
    res.json({
      ok: true,
      checked: live.length,
      updated: updated.length,
      errors,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/fomo/settings", (_req, res) => {
  db.update((dbx) => {
    fomo.ensureFomoStore(dbx);
    fomo.reviveHouseOrders(dbx);
  });
  const data = db.read();
  fomo.ensureFomoStore(data);
  const envLive =
    String(process.env.LIVE_MODE || "false").toLowerCase() === "true";
  const serviceId =
    Number(data.settings.fomoServiceId) || fomo.defaultServiceId();

  const cached = jap.peekServices();
  const service =
    fomo.findServiceById(cached, serviceId) || fomo.fallbackService(serviceId);

  const catalog = fomo.filterFollowerServices(cached || []);
  const cheapest = fomo.pickCheapest(catalog);
  const rate = Number(service.rate) || fomo.estimateRatePer1k();

  jap.getServices().catch(() => {});

  res.json({
    liveMode: worker.isLive(),
    envLiveMode: envLive,
    liveAllowedByEnv: envLive,
    hasApiKey: Boolean(process.env.JAP_API_KEY),
    serviceId,
    defaultServiceId: fomo.defaultServiceId(),
    profileUrl: fomo.SOLID_ACCOUNT.profileUrl,
    account: fomo.accountSnapshot(data),
    service,
    houseServices: fomo.HOUSE_SERVICES.map(fomo.mapService),
    cheapest,
    ratePer1k: rate,
    rateIsEstimate: false,
    packs: fomo.packPriceMenu(rate),
    catalogNote:
      "House API is live — Starter, Heat, Legend fill on this desk (no JAP). Locked to @noormemewebdev.",
  });
});

app.get("/api/fomo/account", (_req, res) => {
  const data = db.read();
  fomo.ensureFomoStore(data);
  fomo.tickHouseOrders(data, Date.now());
  res.json({
    ok: true,
    account: fomo.accountSnapshot(data),
    house: true,
  });
});

app.post("/api/fomo/settings", (req, res) => {
  const { serviceId } = req.body || {};
  db.update((dbx) => {
    fomo.ensureFomoStore(dbx);
    if (serviceId != null && Number(serviceId) > 0) {
      dbx.settings.fomoServiceId = Number(serviceId);
    }
    dbx.settings.fomoProfileUrl = fomo.SOLID_ACCOUNT.profileUrl;
  });
  const data = db.read();
  res.json({
    ok: true,
    serviceId: data.settings.fomoServiceId,
    profileUrl: fomo.SOLID_ACCOUNT.profileUrl,
    account: fomo.accountSnapshot(data),
  });
});

app.get("/api/fomo/services", async (req, res) => {
  try {
    const force = String(req.query.refresh || "") === "1";
    const lookupId = Number(req.query.id) || null;
    const serviceId =
      lookupId ||
      Number(db.read().settings?.fomoServiceId) ||
      fomo.defaultServiceId();

    const house = fomo.HOUSE_SERVICES.map(fomo.mapService);
    const listPromise = jap.getServices({ force });
    const raced = await Promise.race([
      listPromise.then((list) => ({ ready: true, list })),
      new Promise((resolve) =>
        setTimeout(() => resolve({ ready: false, list: null }), 800)
      ),
    ]);

    let items = house.slice();
    if (raced.ready && Array.isArray(raced.list)) {
      items = fomo.filterFollowerServices(raced.list);
    } else {
      listPromise.catch(() => {});
    }

    const resolved =
      fomo.findServiceById(raced.list || [], serviceId) ||
      fomo.fallbackService(serviceId);

    if (resolved && !items.some((s) => s.service === resolved.service)) {
      items.unshift(resolved);
    }

    res.json({
      items,
      cheapest: fomo.pickCheapest(items),
      resolved,
      defaultServiceId: fomo.defaultServiceId(),
      count: items.length,
      cached: Boolean(raced.ready),
      partial: !raced.ready,
      catalogEmpty: false,
      house: true,
    });
  } catch (e) {
    const items = fomo.HOUSE_SERVICES.map(fomo.mapService);
    res.json({
      items,
      cheapest: fomo.pickCheapest(items),
      defaultServiceId: fomo.defaultServiceId(),
      count: items.length,
      cached: false,
      partial: false,
      catalogEmpty: false,
      house: true,
      error: e.message,
    });
  }
});

app.get("/api/fomo/orders", (req, res) => {
  const data = db.read();
  res.json(fomo.listFomoOrders(data, req.query));
});

app.post("/api/fomo/order", async (req, res) => {
  try {
    const data = db.read();
    fomo.ensureFomoStore(data);

    const link =
      fomo.normalizeProfileUrl(
        req.body?.link ||
          req.body?.profileUrl ||
          fomo.SOLID_ACCOUNT.profileUrl
      ) || fomo.SOLID_ACCOUNT.profileUrl;

    const serviceId = Number(
      req.body?.serviceId ||
        data.settings.fomoServiceId ||
        fomo.defaultServiceId()
    );
    if (!Number.isFinite(serviceId) || serviceId <= 0) {
      return res.status(400).json({ error: "Pick a FOMO service" });
    }

    let quantity = Math.floor(Number(req.body?.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ error: "Quantity must be a positive number" });
    }

    const cached = jap.peekServices();
    const svcMeta =
      fomo.findServiceById(cached, serviceId) ||
      fomo.fallbackService(serviceId) ||
      null;
    const house = fomo.isHouseServiceId(serviceId);

    if (svcMeta) {
      const min = Number(svcMeta.min) || 1;
      const max = Number(svcMeta.max) || quantity;
      if (quantity < min) {
        return res.status(400).json({
          error: `Quantity below service min (${min})`,
          min,
          max,
        });
      }
      if (max > 0 && quantity > max) {
        return res.status(400).json({
          error: `Quantity above service max (${max})`,
          min,
          max,
        });
      }
    }

    // House FOMO is our own API — fills locally, never spends JAP.
    const live = house ? true : worker.isLive();
    const mode = live ? "live" : "dry-run";
    const orderId = db.uid("fm");
    const rate = Number(svcMeta?.rate) || fomo.estimateRatePer1k();
    const charge = Number.isFinite(rate) ? (rate * quantity) / 1000 : null;
    const nowIso = new Date().toISOString();

    if (house) {
      const record = {
        id: orderId,
        kind: "fomo_followers",
        link,
        serviceId,
        quantity,
        mode: "live",
        status: "in progress",
        japOrderId: `HOUSE_FM_${Date.now()}`,
        charge,
        serviceName: svcMeta?.name || null,
        rate: svcMeta?.rate || String(rate),
        house: true,
        remains: quantity,
        startCount: fomo.accountSnapshot(data).followers,
        startedAt: nowIso,
        note: req.body?.note ? String(req.body.note).slice(0, 120) : null,
        at: nowIso,
        error: null,
      };

      fomo.advanceHouseOrder(record, Date.now());

      db.update((dbx) => {
        fomo.ensureFomoStore(dbx);
        dbx.settings.fomoProfileUrl = link;
        dbx.settings.fomoServiceId = serviceId;
        dbx.fomoOrders.unshift(record);
        dbx.fomoOrders = dbx.fomoOrders.slice(0, fomo.MAX_ORDERS);
      });

      db.logEvent(
        "fomo_order",
        `HOUSE +${quantity} FOMO → ${link} · $${charge != null ? charge.toFixed(4) : "—"}`,
        { orderId, serviceId, japOrderId: record.japOrderId, house: true }
      );

      return res.json({
        ok: true,
        order: record,
        live: true,
        house: true,
        account: fomo.accountSnapshot(db.read()),
      });
    }

    const record = {
      id: orderId,
      kind: "fomo_followers",
      link,
      serviceId,
      quantity,
      mode,
      status: live ? "submitted" : "simulated",
      japOrderId: null,
      charge,
      serviceName: svcMeta?.name || null,
      rate: svcMeta?.rate || String(rate),
      house: false,
      demo: false,
      deliveredToFomo: null,
      remains: live ? null : quantity,
      startCount: fomo.SOLID_ACCOUNT.followers,
      startedAt: nowIso,
      note: req.body?.note ? String(req.body.note).slice(0, 120) : null,
      at: nowIso,
      error: null,
    };

    if (live) {
      const japRes = await jap.addOrder({
        service: serviceId,
        link,
        quantity,
        allowLiveSpend: true,
      });
      record.japOrderId = japRes?.order != null ? String(japRes.order) : null;
      record.status = "submitted";
    } else {
      record.japOrderId = `DRY_FM_${Date.now()}`;
      record.status = "simulated";
    }

    db.update((dbx) => {
      fomo.ensureFomoStore(dbx);
      dbx.settings.fomoProfileUrl = link;
      dbx.settings.fomoServiceId = serviceId;
      dbx.fomoOrders.unshift(record);
      dbx.fomoOrders = dbx.fomoOrders.slice(0, fomo.MAX_ORDERS);
    });

    db.logEvent(
      "fomo_order",
      `${mode === "live" ? "LIVE" : "DRY"} +${quantity} FOMO → ${link} · $${charge != null ? charge.toFixed(4) : "—"}`,
      { orderId, serviceId, japOrderId: record.japOrderId, house: false }
    );

    res.json({ ok: true, order: record, live, house: false });
  } catch (e) {
    const status = e.code === "LIVE_BLOCKED" ? 400 : 500;
    res.status(status).json({ error: e.message, jap: e.jap || null });
  }
});

app.post("/api/fomo/orders/refresh-status", async (req, res) => {
  try {
    const limit = Math.min(30, Math.max(1, Number(req.body?.limit) || 15));
    const data = db.read();
    fomo.ensureFomoStore(data);

    // Advance house orders first
    db.update((dbx) => {
      fomo.tickHouseOrders(dbx, Date.now());
    });

    const live = data.fomoOrders
      .filter(
        (o) =>
          o.mode === "live" &&
          o.japOrderId &&
          !String(o.japOrderId).startsWith("DRY_") &&
          !o.house &&
          !String(o.japOrderId).startsWith("HOUSE_")
      )
      .slice(0, limit);

    const updated = [];
    const errors = [];

    for (const order of live) {
      try {
        const st = await jap.getOrderStatus(order.japOrderId);
        db.update((dbx) => {
          fomo.ensureFomoStore(dbx);
          const row = dbx.fomoOrders.find((x) => x.id === order.id);
          if (row) fomo.applyJapStatus(row, st);
        });
        updated.push(order.id);
      } catch (e) {
        errors.push({ id: order.id, error: e.message });
      }
      await new Promise((r) => setTimeout(r, 120));
    }

    db.logEvent(
      "fomo_orders_refresh",
      `Refreshed ${updated.length}/${live.length} FOMO order statuses`
    );
    res.json({
      ok: true,
      checked: live.length,
      updated: updated.length,
      errors,
      account: fomo.accountSnapshot(db.read()),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/channel", async (req, res) => {
  try {
    const username =
      req.query.u ||
      getWatchedChannels()[0] ||
      "bansyndicate";
    const posts = await telegram.fetchChannelPosts(username, 25);
    res.json({ username, posts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/channel/sync", async (_req, res) => {
  try {
    const result = await syncAllChannels();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/preview-schedule", (req, res) => {
  const startAt = req.body?.startAt
    ? new Date(req.body.startAt).getTime()
    : Date.now();
  const flowId = normalizeFlowId(req.body?.flowId);
  const flow = getFlow(flowId);
  const drops = buildSchedule(startAt, { flow: flow.plan });
  res.json({
    flowId: flow.id,
    flowName: flow.name,
    startAt: new Date(startAt).toISOString(),
    totalOrders: drops.length,
    totalViews: drops.reduce((s, d) => s + d.qty, 0),
    first: drops.slice(0, 20).map((d) => ({
      at: new Date(d.at).toISOString(),
      qty: d.qty,
      stage: d.stageLabel,
      seq: d.seq,
    })),
    sampleIntervals: sampleFirstStage(flowId),
  });
});

function sampleFirstStage(flowId = DEFAULT_FLOW_ID) {
  const instant = describeInstantPack({ flowId });
  return instant.times.map((t) => ({ time: t.time, views: t.views }));
}

function summarizePost(p) {
  const pending = p.drops.filter(
    (d) => d.status === "pending" || d.status === "sending"
  ).length;
  const sent = p.drops.filter((d) => d.status === "sent").length;
  const failed = p.drops.filter((d) => d.status === "failed").length;
  const skipped = p.drops.filter((d) => d.status === "skipped").length;
  const next = p.drops.find((d) => d.status === "pending");
  const dripOrdered = p.drops
    .filter((d) => d.status === "sent")
    .reduce((s, d) => s + (Number(d.qty) || 0), 0);
  const manualOrdered = Number(p.manualOrdered) || 0;
  const progress =
    p.totalPlanned > 0
      ? Math.min(100, Math.round((dripOrdered / p.totalPlanned) * 100))
      : 0;
  // Match post age to schedule remaining
  const startMs = new Date(p.startAt).getTime();
  const ageMin = Number.isFinite(startMs)
    ? Math.max(0, (Date.now() - startMs) / 60000)
    : 0;
  return {
    id: p.id,
    link: p.link,
    title: p.title,
    source: p.source,
    flowId: p.flowId || DEFAULT_FLOW_ID,
    flowName: p.flowName || getFlow(p.flowId).name,
    startAt: p.startAt,
    status: p.status,
    totalPlanned: p.totalPlanned,
    totalOrdered: dripOrdered,
    manualOrdered,
    dropsTotal: p.drops.length,
    pending,
    sent,
    failed,
    skipped,
    progress,
    ageMin: Math.round(ageMin * 10) / 10,
    nextDropAt: next ? next.at : null,
    createdAt: p.createdAt,
  };
}

/** ── Multi-channel watch helpers ───────────────────────────────── */

const DEFAULT_CHANNELS = ["bansyndicate", "robogems"];

function normalizeChannelName(raw) {
  return String(raw || "")
    .replace(/^@/, "")
    .replace(/^https?:\/\/t\.me\//i, "")
    .split(/[/?#]/)[0]
    .trim()
    .toLowerCase();
}

function parseChannelList(raw) {
  if (Array.isArray(raw)) {
    return [...new Set(raw.map(normalizeChannelName).filter(Boolean))];
  }
  return [
    ...new Set(
      String(raw || "")
        .split(/[,;\s]+/)
        .map(normalizeChannelName)
        .filter(Boolean)
    ),
  ];
}

function channelFromLink(link) {
  const m = String(link || "").match(/t\.me\/([^/?#]+)/i);
  return m ? normalizeChannelName(m[1]) : "";
}

function getWatchedChannels(settings) {
  const s = settings || db.read().settings || {};
  const fromArr = parseChannelList(s.channelUsernames);
  if (fromArr.length) return fromArr;
  const single = normalizeChannelName(
    s.channelUsername || process.env.CHANNEL_USERNAME || ""
  );
  return single ? [single] : [...DEFAULT_CHANNELS];
}

function setWatchedChannels(dbx, list) {
  const next = parseChannelList(list);
  if (!next.length) return;
  dbx.settings.channelUsernames = next;
  dbx.settings.channelUsername = next[0];
  dbx.settings.channelWaters = dbx.settings.channelWaters || {};
  for (const u of next) {
    if (!dbx.settings.channelWaters[u]) {
      dbx.settings.channelWaters[u] = {
        scrapeHighWater: 0,
        discoverAfterMessageId: 0,
      };
    }
  }
}

function getChannelWater(username, settings) {
  const s = settings || db.read().settings || {};
  const key = normalizeChannelName(username);
  const waters = s.channelWaters || {};
  const w = waters[key] || {};
  // Legacy global fallback only for primary channel
  const isPrimary =
    key === normalizeChannelName(s.channelUsername) ||
    key === (getWatchedChannels(s)[0] || "");
  return {
    scrapeHighWater:
      Number(w.scrapeHighWater || 0) ||
      (isPrimary ? Number(s.scrapeHighWater || 0) || 0 : 0),
    discoverAfterMessageId:
      Number(w.discoverAfterMessageId || 0) ||
      (isPrimary ? Number(s.discoverAfterMessageId || 0) || 0 : 0),
  };
}

function setChannelHighWater(username, maxId, { snapDown = false } = {}) {
  if (!maxId) return;
  const key = normalizeChannelName(username);
  db.update((dbx) => {
    dbx.settings.channelWaters = dbx.settings.channelWaters || {};
    const cur = dbx.settings.channelWaters[key] || {
      scrapeHighWater: 0,
      discoverAfterMessageId: 0,
    };
    const prev = Number(cur.scrapeHighWater || 0) || 0;
    if (snapDown && prev > maxId) cur.scrapeHighWater = maxId;
    else if (maxId > prev) cur.scrapeHighWater = maxId;
    dbx.settings.channelWaters[key] = cur;
    // Keep legacy field in sync for primary channel
    if (key === normalizeChannelName(dbx.settings.channelUsername)) {
      dbx.settings.scrapeHighWater = cur.scrapeHighWater;
    }
  });
}

/** Highest real message id for next-id probing (per channel). */
function highWaterMark(username, extraPosts = []) {
  const key = normalizeChannelName(username);
  const data = db.read();
  let hi = getChannelWater(key, data.settings).scrapeHighWater;
  for (const p of data.posts || []) {
    if (channelFromLink(p.link) !== key) continue;
    let id = Number(p.messageId);
    if (!Number.isFinite(id) || id <= 0) {
      const m = String(p.link || "").match(/t\.me\/[^/]+\/(\d+)/i);
      id = m ? Number(m[1]) : 0;
    }
    if (id > hi) hi = id;
  }
  for (const p of extraPosts) {
    const id = Number(p.messageId) || 0;
    if (id > hi) hi = id;
  }
  return hi;
}

function rememberHighWater(username, posts) {
  let maxId = 0;
  for (const p of posts) {
    const id = Number(p.messageId) || 0;
    if (id > maxId) maxId = id;
  }
  if (!maxId) return;
  setChannelHighWater(username, maxId);
}

/** Prefer channel listing high-water (embeds can false-positive). */
function alignWaterToListing(username, listPosts) {
  if (!listPosts || listPosts.length < 2) return;
  const listMax = Math.max(
    0,
    ...listPosts.map((p) => Number(p.messageId) || 0)
  );
  if (listMax < 1) return;
  setChannelHighWater(username, listMax, { snapDown: true });
}

const lastAggressiveCatchupAt = Object.create(null);

async function syncOneChannel(username) {
  const u = normalizeChannelName(username);
  if (!u) throw new Error("Channel username required");

  const now = Date.now();
  const maxAgeMs = AUTO_DISCOVER_MAX_AGE_MS;
  const byId = new Map();
  const afterId = getChannelWater(u).discoverAfterMessageId;

  // Probe + list in parallel (list is usually cached; probe is the hot path)
  let listErr = null;
  let listPosts = [];
  const watermark = highWaterMark(u, []);
  const doAggressive =
    now - (lastAggressiveCatchupAt[u] || 0) > 20_000;
  if (doAggressive) {
    lastAggressiveCatchupAt[u] = now;
    telegram.invalidateListCache();
  }

  const [listOutcome, probed] = await Promise.all([
    telegram
      .fetchChannelPosts(u, doAggressive ? 15 : 12)
      .then((posts) => ({ ok: true, posts }))
      .catch((e) => ({ ok: false, error: e, posts: [] })),
    telegram
      .probeNewPosts(u, watermark, { maxAhead: 3, missLimit: 1 })
      .catch(() => []),
  ]);

  if (listOutcome.ok) {
    listPosts = listOutcome.posts || [];
    for (const p of listPosts) {
      if (Number(p.messageId) > 0) byId.set(p.messageId, p);
    }
    alignWaterToListing(u, listPosts);
  } else {
    listErr = listOutcome.error;
  }

  for (const p of probed || []) {
    if (Number(p.messageId) > 0) byId.set(p.messageId, p);
  }

  // If listing raised the watermark past what we probed from, chase the tip once
  const watermark2 = highWaterMark(u, listPosts);
  if (watermark2 > watermark) {
    try {
      const more = await telegram.probeNewPosts(u, watermark2, {
        maxAhead: 2,
        missLimit: 1,
      });
      for (const p of more) {
        if (Number(p.messageId) > 0) byId.set(p.messageId, p);
      }
    } catch (_) {
      /* keep going */
    }
  }

  const posts = [...byId.values()].sort(
    (a, b) => Number(b.messageId) - Number(a.messageId)
  );

  if (listPosts.length >= 2) {
    alignWaterToListing(u, listPosts);
  } else {
    rememberHighWater(u, posts);
  }

  if (!posts.length && listErr) throw listErr;

  const existing = new Set(db.read().posts.map((p) => p.link));
  const added = [];
  const listMax = listPosts.length
    ? Math.max(...listPosts.map((p) => Number(p.messageId) || 0))
    : 0;

  for (const post of posts) {
    if (existing.has(post.link)) continue;
    if (afterId && Number(post.messageId) <= afterId) continue;

    if (!post.date) {
      if (!listMax || Number(post.messageId) < listMax - 2) continue;
    }
    const ageMs = post.date ? now - new Date(post.date).getTime() : 0;
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > maxAgeMs) continue;

    if (listMax > 0 && Number(post.messageId) > listMax + 3) continue;

    const startAt = new Date().toISOString();
    const flowId = flowIdForChannel(u, "1");
    const created = worker.addPost({
      link: post.link,
      title: post.text || post.link,
      startAt,
      source: "auto",
      flowId,
    });
    added.push(created.link);
    existing.add(created.link);
  }

  if (added.length) {
    const flowLabel = `Flow ${flowIdForChannel(u, "1")}`;
    db.logEvent(
      "sync",
      `Channel @${u}: ${posts.length} seen, ${added.length} new · ${flowLabel}`
    );
    live.broadcast("sync", {
      username: u,
      scanned: posts.length,
      added,
      maxAgeMs,
      message: `@${u}: ${added.length} new post(s) · ${flowLabel}`,
    });
  }
  return {
    username: u,
    scanned: posts.length,
    added,
    posts,
    maxAgeMs,
    maxAgeHours: maxAgeMs / (60 * 60 * 1000),
    watermark: highWaterMark(u, posts),
  };
}

/** Sync every watched channel (auto + Sync now). Channel map picks flow. */
async function syncAllChannels() {
  const channels = getWatchedChannels();
  const results = [];
  const errors = [];
  // Parallel per channel — detect Ban + Robo in the same tick
  const settled = await Promise.allSettled(
    channels.map((u) => syncOneChannel(u))
  );
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === "fulfilled") results.push(s.value);
    else
      errors.push({
        username: channels[i],
        error: s.reason?.message || String(s.reason || "sync failed"),
      });
  }
  if (!results.length && errors.length) {
    const err = new Error(errors.map((e) => `@${e.username}: ${e.error}`).join(" · "));
    err.code = "TELEGRAM_SCRAPE";
    throw err;
  }

  const added = results.flatMap((r) => r.added || []);
  const scanned = results.reduce((s, r) => s + (r.scanned || 0), 0);
  // recovery after at least one channel succeeded
  telegramBlockedUntil = 0;
  return {
    username: channels.join(","),
    channels,
    scanned,
    added,
    results,
    errors,
    maxAgeMs: AUTO_DISCOVER_MAX_AGE_MS,
    maxAgeHours: AUTO_DISCOVER_MAX_AGE_MS / (60 * 60 * 1000),
  };
}

/** @deprecated alias — Sync now / auto-discover */
async function syncChannel() {
  return syncAllChannels();
}

// ── boot ─────────────────────────────────────────────────────────

// Hydrate settings from env on every boot (.env seeds defaults)
db.update((dbx) => {
  dbx.settings.serviceId = Number(
    process.env.JAP_SERVICE_ID || dbx.settings.serviceId || 7394
  );
  dbx.settings.orderQty = Number(
    process.env.ORDER_QTY || dbx.settings.orderQty || 20
  );

  const envList = parseChannelList(
    process.env.CHANNEL_USERNAMES ||
      process.env.CHANNEL_USERNAME ||
      ""
  );
  const existing = getWatchedChannels(dbx.settings);
  const nextChannels =
    envList.length >= 2
      ? envList
      : existing.length >= 2
        ? existing
        : envList.length
          ? [...new Set([...envList, ...DEFAULT_CHANNELS.filter((c) => !envList.includes(c))])]
          : [...DEFAULT_CHANNELS];

  const prevKey = existing.join(",");
  const nextKey = nextChannels.join(",");
  setWatchedChannels(dbx, nextChannels);

  // Migrate legacy global high-water onto primary channel once
  dbx.settings.channelWaters = dbx.settings.channelWaters || {};
  const primary = nextChannels[0];
  if (
    primary &&
    Number(dbx.settings.scrapeHighWater || 0) > 0 &&
    !Number(dbx.settings.channelWaters[primary]?.scrapeHighWater || 0)
  ) {
    dbx.settings.channelWaters[primary] = {
      scrapeHighWater: Number(dbx.settings.scrapeHighWater || 0),
      discoverAfterMessageId: Number(
        dbx.settings.discoverAfterMessageId || 0
      ),
    };
  }

  if (prevKey !== nextKey) {
    // New channels start clean; keep waters for channels still watched
    for (const u of nextChannels) {
      if (!dbx.settings.channelWaters[u]) {
        dbx.settings.channelWaters[u] = {
          scrapeHighWater: 0,
          discoverAfterMessageId: 0,
        };
      }
    }
  }

  // Safe default: never boot into live unless env explicitly allows
  if (String(process.env.LIVE_MODE || "false").toLowerCase() !== "true") {
    dbx.settings.liveMode = false;
  } else if (typeof dbx.settings.liveMode !== "boolean") {
    dbx.settings.liveMode = false;
  }
  if (process.env.AUTO_DISCOVER_POSTS !== undefined) {
    dbx.settings.autoDiscover =
      String(process.env.AUTO_DISCOVER_POSTS).toLowerCase() === "true";
  } else if (typeof dbx.settings.autoDiscover !== "boolean") {
    dbx.settings.autoDiscover = true;
  }
});

worker.startWorker();
supabaseIngest.start();
// Warm JAP catalog in background — never block manual boost clicks on cold cache
jap.getServices().catch(() => {});

/** Skip auto-sync while Telegram is unreachable (avoid spam). */
let telegramBlockedUntil = 0;
let autoDiscoverRunning = false;
let lastTelegramError = null;
let lastTelegramOkAt = null;

async function runAutoDiscover() {
  const auto = db.read().settings.autoDiscover;
  if (!auto) return;
  if (Date.now() < telegramBlockedUntil) return;
  if (autoDiscoverRunning) return;
  autoDiscoverRunning = true;
  try {
    await syncAllChannels();
    lastTelegramError = null;
    lastTelegramOkAt = new Date().toISOString();
  } catch (e) {
    lastTelegramError = e.message || "sync failed";
    console.error("sync error", e.message);
    const unreachable =
      e.code === "TELEGRAM_UNREACHABLE" ||
      e.code === "TELEGRAM_SCRAPE" ||
      /403|timeout|blocked|unreachable/i.test(lastTelegramError);
    if (unreachable) {
      // Short pause only — long backoff made "instant" discover look broken (banner stuck)
      telegramBlockedUntil = Date.now() + 3_000;
      // Avoid flooding events log every tick
      const last = db.read().events?.[0];
      if (
        !last ||
        last.type !== "sync_error" ||
        Date.now() - new Date(last.at).getTime() > 60_000
      ) {
        db.logEvent(
          "sync_error",
          "Can't reach Telegram public pages — retrying soon (no BotFather needed)."
        );
      }
    } else {
      db.logEvent("sync_error", lastTelegramError);
    }
  } finally {
    autoDiscoverRunning = false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Tight loop: scrape → short gap → scrape (no wasted ticks while a scrape is in-flight). */
async function autoDiscoverLoop() {
  for (;;) {
    try {
      await runAutoDiscover();
    } catch (_) {}
    await sleep(AUTO_DISCOVER_MS);
  }
}

// Start continuous near-instant auto-discover (scrape) + Bot API (preferred)
autoDiscoverLoop();
telegramBot.botDiscoverLoop().catch((e) =>
  console.error("[bot-discover] fatal", e.message || e)
);

app.listen(PORT, "0.0.0.0", () => {
  const channels = getWatchedChannels();
  console.log(`\n  Robo View Machine → http://0.0.0.0:${PORT}`);
  console.log(`  Mode: ${worker.isLive() ? "LIVE ⚠️" : "DRY-RUN (safe)"}`);
  console.log(
    `  Watching: ${channels.map((c) => "@" + c).join(" + ")} · @bansyndicate→F4 · @robogems→Flow Robo · others→F1`
  );
  console.log(`  Auto-discover scrape: every ${AUTO_DISCOVER_MS}ms · max age ${AUTO_DISCOVER_MAX_AGE_MS / 60000}m`);
  console.log(
    `  Scrape-only (no BotFather). Optional bot: ${
      telegramBot.token() ? "ON" : "OFF (not required)"
    }`
  );
  console.log(`  Service: ${process.env.JAP_SERVICE_ID || 7394} · qty=${ORDER_QTY}`);
  console.log(
    `  Twitter followers → http://0.0.0.0:${PORT}/twitter · service ${twitter.defaultServiceId()}`
  );
  console.log(
    `  X post likes & comments → http://0.0.0.0:${PORT}/twitter-posts`
  );
  console.log(
    `  X post views → http://0.0.0.0:${PORT}/twitter-views · service ${twitterViews.defaultServiceId()}`
  );
  console.log(
    `  Instagram followers → http://0.0.0.0:${PORT}/instagram · service ${instagram.defaultServiceId()}`
  );
  console.log(
    `  Instagram post likes → http://0.0.0.0:${PORT}/instagram-likes · service ${instagramLikes.defaultServiceId()}`
  );
  console.log(
    `  LinkedIn followers → http://0.0.0.0:${PORT}/linkedin · service ${linkedin.defaultServiceId()}`
  );
  console.log(
    `  FOMO followers → http://0.0.0.0:${PORT}/fomo · service ${fomo.defaultServiceId() || "(set JAP_FOMO_FOLLOWERS_SERVICE_ID)"}`
  );
  console.log(
    `  YouTube desk → http://0.0.0.0:${PORT}/youtube · solid @${youtube.SOLID_ACCOUNT.handle}`
  );
  const phone = supabaseIngest.getStatus();
  console.log(
    `  Phone queue → http://0.0.0.0:${PORT}/m · supabase ${
      phone.enabled ? "ON" : "OFF (set SUPABASE_URL + SUPABASE_ANON_KEY)"
    }\n`
  );
});
