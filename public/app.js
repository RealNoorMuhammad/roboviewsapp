const $ = (s) => document.querySelector(s);

async function api(path, opts = {}) {
  const ctrl = new AbortController();
  const ms = opts.timeoutMs ?? 45_000;
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const { timeoutMs, ...rest } = opts;
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(rest.headers || {}) },
      ...rest,
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("Request timed out — JAP may still be processing");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function shortLink(link) {
  return String(link || "").replace(/^https?:\/\//, "");
}

// ── loaders ──────────────────────────────────────────────────────

async function loadAll() {
  await Promise.all([
    loadStatus(),
    loadSettings(),
    loadPosts(),
    loadOrders(),
    loadEvents(),
    loadCurve(),
    loadBalance(),
  ]);
}

async function loadStatus() {
  const s = await api("/api/status");
  $("#sActive").textContent = s.active;
  $("#sPending").textContent = s.pendingDrops;
  $("#sSent").textContent = s.sentDrops;
  $("#sPosts").textContent = s.posts;
  const pill = $("#modePill");
  if (s.liveMode) {
    pill.textContent = "LIVE";
    pill.classList.add("live");
  } else {
    pill.textContent = "DRY-RUN";
    pill.classList.remove("live");
  }
  updateControlsUI({ status: s });
  setPhonePill(s.phoneIngest);

  const banner = $("#tgBlockBanner");
  if (banner) {
    const bot = s.botDiscover || {};
    if (bot.enabled && !bot.lastError) {
      banner.hidden = true;
    } else if (s.telegramError || s.telegramOk === false || (bot.enabled && bot.lastError)) {
      banner.hidden = false;
      banner.innerHTML =
        `<strong>Auto-discover is waiting on Telegram public pages</strong> (no BotFather needed). ` +
        `New posts are checked by message id (next post after last seen) every ~1s.<br/>` +
        `If this stays yellow: VPN/hotspot can help; or paste the post link below for instant +56.` +
        (s.telegramError
          ? `<br/><span class="muted">Scrape: ${escapeHtml(s.telegramError)}</span>`
          : "") +
        (bot.enabled && bot.lastError
          ? `<br/><span class="muted">Optional bot path: ${escapeHtml(bot.lastError)}</span>`
          : "");
    } else {
      banner.hidden = true;
    }
  }
}

async function loadSettings() {
  const s = await api("/api/settings");
  const effectiveLive = !!s.liveMode;
  $("#liveToggle").checked = !!(s.uiLiveMode ?? s.liveMode);
  // Visual: if env blocks live, keep toggle offline-effective
  if (s.liveAllowedByEnv === false) {
    $("#liveToggle").checked = false;
  } else {
    $("#liveToggle").checked = effectiveLive || !!s.uiLiveMode;
  }
  $("#autoToggle").checked = s.autoDiscover !== false;
  const channels = Array.isArray(s.channelUsernames) && s.channelUsernames.length
    ? s.channelUsernames.map((c) => String(c).replace(/^@/, "").trim()).filter(Boolean)
    : [String(s.channelUsername || "bansyndicate").replace(/^@/, "")];
  const chLabel = channels.map((c) => `@${c}`).join(" + ");
  $("#channelLabel").textContent = chLabel;
  const channelInput = $("#channelInput");
  if (channelInput && document.activeElement !== channelInput) {
    channelInput.value = channels.join(", ");
  }
  const linksEl = $("#channelOpenLinks");
  if (linksEl) {
    linksEl.innerHTML = channels
      .map(
        (c) =>
          `<a class="ctrl-channel-link" href="https://t.me/${encodeURIComponent(c)}" target="_blank" rel="noopener">@${c} ↗</a>`
      )
      .join("");
  }
  const adHint = $("#autoDiscoverHint");
  if (adHint) {
    const hours = s.autoDiscoverMaxAgeHours != null ? s.autoDiscoverMaxAgeHours : 1;
    const windowLabel = hours === 1 ? "last 1h" : `last ${hours}h`;
    adHint.textContent = `Watch ${chLabel} — @bansyndicate→F4, @robogems→Flow Robo (${windowLabel}) · auto + manual.`;
  }
  const svc = $("#ctrlService");
  if (svc) svc.textContent = String(s.serviceId || "—");
  updateControlsUI({ settings: { ...s, liveMode: effectiveLive } });
}

function setCtrlMsg(text, isErr = false) {
  const el = $("#ctrlMsg");
  if (!el) return;
  if (!text) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.className = isErr ? "msg err" : "msg";
  el.textContent = text;
}

function updateControlsUI({ settings, status } = {}) {
  const liveOn = settings
    ? !!settings.liveMode
    : $("#liveToggle")?.checked;
  const autoOn = settings
    ? settings.autoDiscover !== false
    : $("#autoToggle")?.checked;

  const badge = $("#ctrlModeBadge");
  if (badge) {
    badge.textContent = liveOn ? "LIVE" : "DRY-RUN";
    badge.classList.toggle("is-live", !!liveOn);
  }

  const liveLab = $("#ctrlLiveLabel");
  const liveDot = $("#ctrlDotLive");
  if (liveLab) liveLab.textContent = liveOn ? "LIVE" : "DRY";
  if (liveDot) {
    liveDot.classList.toggle("dim", !liveOn);
    liveDot.classList.toggle("warn", !!liveOn);
  }

  const autoLab = $("#ctrlAutoLabel");
  const autoDot = $("#ctrlDotAuto");
  if (autoLab) autoLab.textContent = autoOn ? "ON" : "OFF";
  if (autoDot) autoDot.classList.toggle("dim", !autoOn);

  if (status && status.liveClients != null) {
    const rt = $("#ctrlRtLabel");
    const rtDot = $("#ctrlDotRt");
    const n = Number(status.liveClients) || 0;
    if (rt) rt.textContent = n > 0 ? `${n} tab` : "idle";
    if (rtDot) rtDot.classList.toggle("dim", n === 0);
  }
}

function stampCtrl(key, iso) {
  const map = {
    sync: "#ctrlLastSync",
    hit: "#ctrlLastHit",
  };
  const el = $(map[key]);
  if (el) el.textContent = iso ? fmtTime(iso) : "—";
}


async function loadBalance() {
  try {
    const b = await api("/api/balance");
    $("#balPill").textContent = `$${Number(b.balance).toFixed(4)} ${b.currency || ""}`.trim();
    $("#balPill").title = "JAP panel balance";
  } catch (err) {
    $("#balPill").textContent = "balance n/a";
    $("#balPill").title = err?.message || "Balance unavailable";
  }
}

async function loadPosts() {
  const posts = await api("/api/posts");
  const el = $("#postsList");
  if (!posts.length) {
    el.innerHTML = `<div class="empty">
      <strong>No posts tracked — so no JAP views ordered.</strong><br/>
      1 view on Telegram = you opened the post (bot did not run).<br/>
      Paste post link(s) below, e.g. <code>https://t.me/bansyndicate/15</code>
    </div>`;
    return;
  }
  el.innerHTML = posts
    .map(
      (p) => `
    <div class="post-card" data-id="${p.id}">
      <div>
        <span class="badge ${p.status}">${p.status}</span>
        <span class="badge">${p.source === "mobile" ? "phone" : p.source || "manual"}</span>
        <span class="badge">${p.flowName || (p.flowId === "6" ? "Flow Robo · 420" : p.flowId === "5" ? "Flow 5 · 456" : p.flowId === "4" ? "Flow 4 · 536" : p.flowId === "3" ? "Flow 3 · 746" : p.flowId === "2" ? "Flow 2 · 300" : "Flow 1 · 396")}</span>
        <span class="badge">${p.progress || 0}%</span>
      </div>
      <a class="link" href="${p.link}" target="_blank" rel="noopener">${shortLink(p.link)}</a>
      <div class="progress" title="${p.totalOrdered}/${p.totalPlanned}"><i style="width:${p.progress || 0}%"></i></div>
      <div class="meta">
        <span>ordered <b>${p.totalOrdered}</b> / ${p.totalPlanned}${p.manualOrdered ? ` · manual <b>+${p.manualOrdered}</b>` : ""}</span>
        <span>drops <b>${p.sent}</b> sent · <b>${p.pending}</b> left</span>
        <span>age <b>${p.ageMin ?? "—"}m</b></span>
        <span>next <b>${p.nextDropAt ? fmtTime(p.nextDropAt) : "—"}</b></span>
      </div>
      <div class="actions">
        <button type="button" class="btn ghost sm" data-act="detail">Schedule</button>
        <button type="button" class="btn ghost sm" data-act="boost" title="Instant manual boost">Boost</button>
        ${
          p.status === "active"
            ? `<button type="button" class="btn ghost sm" data-act="pause">Pause</button>`
            : p.status === "paused"
            ? `<button type="button" class="btn ghost sm" data-act="resume">Resume</button>`
            : ""
        }
        <button type="button" class="btn danger sm" data-act="remove">Remove</button>
      </div>
    </div>`
    )
    .join("");
}

async function loadOrders() {
  const mode = $("#orderModeFilter")?.value || "";
  const status = $("#orderStatusFilter")?.value || "";
  const q = ($("#orderSearch")?.value || "").trim();
  // Full list end-to-end (no 80-row cap)
  const params = new URLSearchParams({ limit: "all", offset: "0" });
  if (mode) params.set("mode", mode);
  if (status) params.set("status", status);
  if (q) params.set("q", q);

  const data = await api(`/api/orders?${params}`);
  const items = data.items || (Array.isArray(data) ? data : []);
  const summary = data.summary || computeClientSummary(items);
  const body = $("#ordersBody");

  if ($("#osTotal")) {
    const total = summary.total ?? data.total ?? items.length;
    $("#osTotal").textContent = total;
    $("#osViews").textContent =
      summary.views != null ? summary.views : items.reduce((s, o) => s + (Number(o.qty) || 0), 0);
    $("#osLive").textContent =
      summary.live != null
        ? summary.live
        : items.filter((o) => (o.mode || "").toLowerCase() === "live").length;
    $("#osDry").textContent =
      summary.dryRun != null
        ? summary.dryRun
        : items.filter((o) => (o.mode || "").toLowerCase() !== "live").length;
  }

  if (!items.length) {
    body.innerHTML = `<tr><td colspan="8" style="color:var(--muted)">No orders match</td></tr>`;
    if ($("#ordersFooter")) $("#ordersFooter").textContent = "";
    return;
  }

  body.innerHTML = items
    .map((o) => {
      const modeCls = o.isLive || o.mode === "live" ? "live" : "dry";
      const st = o.japStatus || o.status || "—";
      return `
    <tr>
      <td>${fmtTime(o.at)}</td>
      <td><span class="badge mode-${modeCls}">${escapeHtml(o.mode || "—")}</span></td>
      <td><span class="badge st-${escapeHtml(String(st).toLowerCase().replace(/\s+/g, "_"))}">${escapeHtml(st)}</span></td>
      <td>+${o.qty}</td>
      <td class="mono-cell">${o.seq != null ? "#" + o.seq : "—"}</td>
      <td class="mono-cell">${escapeHtml(o.phaseId || "—")}</td>
      <td class="mono-cell" title="${escapeHtml(o.japOrderId || "")}">${escapeHtml(shortId(o.japOrderId))}</td>
      <td><a href="${escapeHtml(o.link || "#")}" target="_blank" rel="noopener">${escapeHtml(o.linkShort || shortLink(o.link))}</a></td>
    </tr>`;
    })
    .join("");

  if ($("#ordersFooter")) {
    const total = data.total ?? items.length;
    const views =
      summary.views != null
        ? summary.views
        : items.reduce((s, o) => s + (Number(o.qty) || 0), 0);
    $("#ordersFooter").textContent =
      total === items.length
        ? `Full list · ${items.length} orders · ${views} views`
        : `Showing ${items.length} of ${total} · ${views} views` +
          (data.hasMore ? " · more available" : "");
  }
}

function computeClientSummary(items) {
  let views = 0;
  let live = 0;
  let dryRun = 0;
  for (const o of items) {
    views += Number(o.qty) || 0;
    if ((o.mode || "").toLowerCase() === "live") live += 1;
    else dryRun += 1;
  }
  return { total: items.length, views, live, dryRun };
}

function shortId(id) {
  if (!id) return "—";
  const s = String(id);
  if (s.length <= 14) return s;
  return s.slice(0, 6) + "…" + s.slice(-4);
}

async function loadEvents() {
  const events = await api("/api/events");
  const el = $("#events");
  if (!events.length) {
    el.innerHTML = `<div class="evt">Waiting for activity…</div>`;
    return;
  }
  el.innerHTML = events
    .slice(0, 40)
    .map(
      (e) => `
    <div class="evt ${e.type}">
      <span class="t">${fmtTime(e.at)}</span>${escapeHtml(e.message)}
    </div>`
    )
    .join("");
}

async function loadCurve(flowId) {
  const selected =
    flowId ||
    $("#flowSelect")?.value ||
    "1";
  const data = await api(`/api/curve?flow=${encodeURIComponent(selected)}`);
  const { analysis } = data;
  const flow = analysis.flow || [];

  const title = $("#curveTitle");
  if (title) {
    title.textContent = analysis.flowName || `Flow · ${analysis.totalViews || "—"}`;
  }

  const compare = $("#compareHint");
  if (compare) {
    compare.textContent =
      analysis.formula ||
      `+${analysis.instantViews} instant · ${analysis.stages?.[1]?.orders || "—"}× +${analysis.dripViews || 20} · ${analysis.totalViews} total`;
  }

  let running = 0;
  $("#curveBody").innerHTML = flow
    .map((f) => {
      running += f.qty;
      return `<tr><td>${f.mark}</td><td>+${f.qty}</td><td>${running}</td></tr>`;
    })
    .join("");

  $("#curveTotal").textContent = `${analysis.totalOrders || flow.length} orders · ${analysis.totalViews || running} views · 24h`;
}

$("#flowSelect")?.addEventListener("change", (e) => {
  loadCurve(e.target.value).catch(() => {});
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── actions ──────────────────────────────────────────────────────

function flowLabelForId(flowId) {
  const id = String(flowId || "");
  if (id === "6") return "Flow Robo (+20 → 420)";
  if (id === "5") return "Flow 5 (+36 → 456)";
  if (id === "4") return "Flow 4 (+56 → 536)";
  if (id === "3") return "Flow 3 (+66 → 746)";
  if (id === "2") return "Flow 2 (+40 → 300)";
  return "Flow 1 (+56 → 396)";
}

function detectPreferredFlowFromLinks(text) {
  const links = String(text || "")
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!links.length) return null;
  const channels = links.map((l) => {
    const m = l.match(/t\.me\/([^/?#]+)/i);
    return m ? m[1].toLowerCase() : "";
  });
  const allRobo = channels.every((c) => c === "robogems");
  const allBan = channels.every((c) => c === "bansyndicate");
  if (allRobo) return "6";
  if (allBan) return "4";
  return null;
}

function syncFlowSelectFromLinks() {
  const ta = document.querySelector('#addForm textarea[name="link"]');
  const sel = $("#flowSelect");
  if (!ta || !sel) return;
  const preferred = detectPreferredFlowFromLinks(ta.value);
  if (!preferred) return;
  if (sel.value !== preferred) {
    sel.value = preferred;
    loadCurve(preferred).catch(() => {});
  }
}

$("#addForm")?.querySelector('textarea[name="link"]')?.addEventListener("input", () => {
  syncFlowSelectFromLinks();
});

function setManualBoostMsg(text, isErr = false) {
  const el = $("#manualBoostMsg");
  if (!el) return;
  if (!text) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.className = isErr ? "msg err" : "msg";
  el.textContent = text;
}

let manualBoostBusy = false;

async function runManualBoost(qty) {
  const link = ($("#manualBoostLink")?.value || "").trim();
  if (!link) {
    setManualBoostMsg("Paste a post link first", true);
    return;
  }
  if (manualBoostBusy) return;

  const activeBtn = document.querySelector(`.manual-qty-btn[data-qty="${qty}"]`);
  manualBoostBusy = true;
  if (activeBtn) {
    activeBtn.disabled = true;
    activeBtn.classList.add("is-active");
  }

  const liveOn = $("#liveToggle")?.checked;
  setManualBoostMsg(`${liveOn ? "LIVE" : "DRY"} +${qty} sending to JAP…`);

  try {
    const res = await api("/api/manual-boost", {
      method: "POST",
      body: JSON.stringify({ link, qty }),
      timeoutMs: 90_000,
    });
    const svc =
      res.serviceId != null ? ` · svc #${res.serviceId}` : "";
    setManualBoostMsg(
      `${res.mode === "live" ? "LIVE" : "DRY"} +${res.qty} sent in ${((res.elapsedMs || 0) / 1000).toFixed(1)}s · ${shortLink(res.link)}${svc}`
    );
    showHitToast(
      `<strong>Manual +${res.qty}</strong> instant · ${escapeHtml(shortLink(res.link || ""))}`
    );
    loadAll().catch(() => {});
  } catch (err) {
    setManualBoostMsg(err.message, true);
  } finally {
    manualBoostBusy = false;
    if (activeBtn) {
      activeBtn.disabled = false;
      activeBtn.classList.remove("is-active");
    }
  }
}

function focusManualBoost(link) {
  const input = $("#manualBoostLink");
  if (!input) return;
  input.value = link;
  input.focus();
  input.scrollIntoView({ behavior: "smooth", block: "center" });
  setManualBoostMsg(`Ready — pick +20…+100 for ${shortLink(link)}`);
}

$("#manualQtyGrid")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".manual-qty-btn");
  if (!btn || btn.disabled) return;
  const qty = Number(btn.dataset.qty);
  if (!Number.isFinite(qty)) return;
  runManualBoost(qty).catch(console.error);
});

$("#addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  syncFlowSelectFromLinks();
  const fd = new FormData(e.target);
  const link = fd.get("link");
  const title = fd.get("title") || undefined;
  const flowId = fd.get("flowId") || "1";
  let startAt = fd.get("startAt") || undefined;
  if (startAt) startAt = new Date(startAt).toISOString();
  const msg = $("#formMsg");
  try {
    const res = await api("/api/posts", {
      method: "POST",
      body: JSON.stringify({ link, title, startAt, flowId }),
    });
    msg.hidden = false;
    msg.className = "msg";
    if (res.batch) {
      const flows = (res.added || [])
        .map((p) => p.flowName || flowLabelForId(p.flowId))
        .filter(Boolean);
      const unique = [...new Set(flows)];
      msg.textContent =
        `Added ${res.added.length} post(s)` +
        (res.skipped?.length ? ` · ${res.skipped.length} already tracking` : "") +
        (res.errors?.length ? ` · ${res.errors.length} failed` : "") +
        (unique.length ? ` — ${unique.join(" · ")}` : "");
    } else {
      const applied = res.flowName || flowLabelForId(res.flowId || flowId);
      msg.textContent = `${applied} started — instant pack fires now (if Live ON). @robogems always uses Flow Robo.`;
    }
    const keepFlow = flowId;
    e.target.reset();
    if ($("#flowSelect")) $("#flowSelect").value = keepFlow;
    loadCurve(keepFlow).catch(() => {});
    await loadAll();
  } catch (err) {
    msg.hidden = false;
    msg.className = "msg err";
    msg.textContent = err.message;
  }
});

$("#liveToggle").addEventListener("change", async (e) => {
  const on = e.target.checked;
  if (on) {
    const ok = confirm(
      "LIVE MODE will spend real JAP balance and place real orders.\n\n@robogems → Flow Robo (+20→420) · @bansyndicate → Flow 4 (+56→536).\n\nAlso requires LIVE_MODE=true in .env.\n\nContinue?"
    );
    if (!ok) {
      e.target.checked = false;
      return;
    }
  }
  try {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({ liveMode: on }),
    });
    setCtrlMsg(on ? "Live mode ON — real orders" : "Dry-run — no real spend");
    await loadStatus();
    await loadSettings();
  } catch (err) {
    e.target.checked = false;
    setCtrlMsg(err.message, true);
    await loadSettings().catch(() => {});
  }
});

$("#autoToggle").addEventListener("change", async (e) => {
  try {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({ autoDiscover: e.target.checked }),
    });
    setCtrlMsg(
      e.target.checked
        ? "Auto-discover ON — @bansyndicate→F4 · @robogems→Flow Robo"
        : "Auto-discover OFF — paste links manually"
    );
    await loadSettings();
  } catch (err) {
    e.target.checked = !e.target.checked;
    setCtrlMsg(err.message, true);
  }
});

async function saveChannel() {
  const raw = ($("#channelInput")?.value || "").trim();
  if (!raw) {
    setCtrlMsg("At least one channel username required", true);
    return;
  }
  try {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({ channelUsernames: raw }),
    });
    setCtrlMsg(`Watching ${raw.replace(/@/g, "")} · Flow 1 auto`);
    await loadSettings();
  } catch (err) {
    setCtrlMsg(err.message, true);
  }
}

$("#saveChannelBtn")?.addEventListener("click", () => saveChannel());
$("#channelInput")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveChannel();
  }
});

$("#syncBtn").addEventListener("click", async () => {
  const btn = $("#syncBtn");
  btn.disabled = true;
  btn.textContent = "Syncing…";
  setCtrlMsg("Scanning channels…");
  try {
    const r = await api("/api/channel/sync", { method: "POST" });
    stampCtrl("sync", new Date().toISOString());
    const ch = Array.isArray(r.channels) ? r.channels.map((c) => `@${c}`).join(" + ") : r.username;
    setCtrlMsg(`Scanned ${ch}: ${r.scanned} · added ${r.added.length} new (Flow 1)`);
    await loadAll();
  } catch (err) {
    setCtrlMsg(err.message, true);
    try {
      await loadSettings();
      await loadEvents();
    } catch (_) {}
  } finally {
    btn.disabled = false;
    btn.textContent = "Sync now";
  }
});

$("#refreshBtn").addEventListener("click", async () => {
  setCtrlMsg("Refreshing…");
  try {
    await loadAll();
    setCtrlMsg("Dashboard refreshed");
  } catch (err) {
    setCtrlMsg(err.message, true);
  }
});

$("#stopAllBtn")?.addEventListener("click", async () => {
  const ok = confirm(
    "Stop ALL tracked posts and clear their drip schedules?\n\nThis cannot be undone (order log cleared). Continue?"
  );
  if (!ok) return;
  const btn = $("#stopAllBtn");
  btn.disabled = true;
  try {
    const r = await api("/api/posts/stop-all", { method: "POST" });
    setCtrlMsg(`Stopped ${r.stopped} post(s) · clean start`);
    stampCtrl("hit", null);
    await loadAll();
  } catch (err) {
    setCtrlMsg(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

const orderFilterIds = ["orderModeFilter", "orderStatusFilter", "orderSearch"];
for (const id of orderFilterIds) {
  const el = document.getElementById(id);
  if (!el) continue;
  const evt = el.tagName === "INPUT" ? "input" : "change";
  el.addEventListener(evt, () => {
    clearTimeout(el._t);
    el._t = setTimeout(() => loadOrders().catch(console.error), 200);
  });
}

$("#ordersRefreshBtn")?.addEventListener("click", async () => {
  const btn = $("#ordersRefreshBtn");
  btn.disabled = true;
  btn.textContent = "Syncing…";
  try {
    const r = await api("/api/orders/refresh-status", {
      method: "POST",
      body: JSON.stringify({ limit: 20 }),
    });
    alert(`Checked ${r.checked} live orders · updated ${r.updated}`);
    await loadOrders();
    await loadEvents();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Sync status";
  }
});

$("#ordersCsvBtn")?.addEventListener("click", () => {
  const mode = $("#orderModeFilter")?.value || "";
  const status = $("#orderStatusFilter")?.value || "";
  const q = ($("#orderSearch")?.value || "").trim();
  const params = new URLSearchParams();
  if (mode) params.set("mode", mode);
  if (status) params.set("status", status);
  if (q) params.set("q", q);
  const qs = params.toString();
  // Force download via same-origin link (includes current filters)
  const a = document.createElement("a");
  a.href = `/api/orders/export.csv${qs ? `?${qs}` : ""}`;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
});

$("#postsList").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const card = btn.closest(".post-card");
  const id = card.dataset.id;
  const act = btn.dataset.act;
  try {
    if (act === "pause") await api(`/api/posts/${id}/pause`, { method: "POST" });
    if (act === "resume") await api(`/api/posts/${id}/resume`, { method: "POST" });
    if (act === "remove") {
      if (!confirm("Remove this post and its remaining schedule?")) return;
      await api(`/api/posts/${id}`, { method: "DELETE" });
    }
    if (act === "detail") {
      const post = await api(`/api/posts/${id}`);
      showDetail(post);
      return;
    }
    if (act === "boost") {
      const link = card.querySelector(".link")?.href || card.querySelector(".link")?.textContent;
      if (link) focusManualBoost(link);
      return;
    }
    await loadAll();
  } catch (err) {
    alert(err.message);
  }
});

function showDetail(post) {
  $("#dlgTitle").textContent = shortLink(post.link);
  $("#dlgBody").innerHTML = post.drops
    .map(
      (d) => `
    <div class="drop-row ${d.status}">
      <span>#${d.seq}</span>
      <span>${fmtTime(d.at)}</span>
      <span>+${d.qty}</span>
      <span>${d.status}${d.japOrderId ? " · " + d.japOrderId : ""}</span>
    </div>`
    )
    .join("");
  $("#detailDlg").showModal();
}

// ── realtime (SSE) ───────────────────────────────────────────────

const liveFeedItems = [];
const LIVE_FEED_MAX = 40;
let es = null;
let toastTimer = null;
let refreshDebounce = null;

function renderPhoneQueue(info) {
  const el = $("#phoneQueue");
  if (!el) return;
  const rows = (info && info.recent) || [];
  if (!rows.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.innerHTML =
    `<div class="phone-queue-label">From phone</div>` +
    rows
      .map((r) => {
        const st = r.status || "pending";
        return `<div class="phone-queue-row"><a href="${escapeHtml(r.link)}" target="_blank" rel="noopener">${escapeHtml(shortLink(r.link))}</a><span class="badge">${escapeHtml(st)}</span></div>`;
      })
      .join("");
}

function setPhonePill(info) {
  const pill = $("#phonePill");
  renderPhoneQueue(info);
  if (!pill) return;
  pill.classList.remove("muted", "phone-on", "phone-err");
  if (!info || !info.enabled) {
    pill.classList.add("muted");
    pill.textContent = "PHONE OFF";
    pill.title = "Set SUPABASE_URL + SUPABASE_ANON_KEY, then open /m on your phone host";
    return;
  }
  if (info.lastError) {
    pill.classList.add("phone-err");
    pill.textContent = "PHONE ERR";
    pill.title = info.lastError;
    return;
  }
  pill.classList.add("phone-on");
  if (info.lastImportedAt) {
    const when = fmtTime(info.lastImportedAt);
    pill.textContent = "PHONE OK";
    pill.title = info.lastLink
      ? `Last phone post ${info.lastStatus || "imported"} · ${info.lastLink} · ${when}`
      : `Watching Supabase · last ingest ${when}`;
  } else {
    pill.textContent = "PHONE ON";
    pill.title = "Waiting for a post from the phone page";
  }
}

function setLivePill(state, label) {
  const pill = $("#livePill");
  if (!pill) return;
  pill.classList.remove("live-on", "live-hit", "muted");
  // Short labels so the badge never looks "cut"
  const text =
    label ||
    (state === "on" ? "RT OK" : state === "hit" ? "HIT" : "RT OFF");
  if (state === "on") {
    pill.classList.add("live-on");
    pill.textContent = text;
    pill.title = "Realtime stream connected";
  } else if (state === "hit") {
    pill.classList.add("live-hit");
    pill.textContent = text;
    pill.title = "New post/order hit";
  } else {
    pill.classList.add("muted");
    pill.textContent = text;
    pill.title = "Realtime stream offline / reconnecting";
  }
}

function showHitToast(text) {
  const el = $("#hitToast");
  if (!el) return;
  el.hidden = false;
  el.innerHTML = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 4200);
}

function pushLiveFeed(item) {
  const feed = $("#liveFeed");
  if (!feed) return;
  liveFeedItems.unshift(item);
  if (liveFeedItems.length > LIVE_FEED_MAX) liveFeedItems.length = LIVE_FEED_MAX;

  feed.innerHTML = liveFeedItems
    .map((h, i) => {
      const cls = [
        "live-hit-row",
        h.kind === "order" ? "is-order" : "",
        i === 0 ? "is-new" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const tag = h.kind === "order" ? "ORDER" : "POST HIT";
      return `<div class="${cls}">
        <span class="tag">${tag}</span>
        <span class="msg" title="${escapeHtml(h.message || h.link || "")}">${escapeHtml(
        h.message || h.link || "—"
      )}</span>
        <span class="t">${fmtTime(h.at)}</span>
      </div>`;
    })
    .join("");
}

function flashPostCard(postId) {
  if (!postId) return;
  const card = document.querySelector(`.post-card[data-id="${CSS.escape(postId)}"]`);
  if (!card) return;
  card.classList.remove("flash-hit");
  // reflow so animation restarts
  void card.offsetWidth;
  card.classList.add("flash-hit");
}

function scheduleRealtimeRefresh(heavy = false) {
  clearTimeout(refreshDebounce);
  refreshDebounce = setTimeout(() => {
    if (heavy) {
      Promise.all([loadStatus(), loadPosts(), loadOrders(), loadEvents()]).catch(console.error);
    } else {
      Promise.all([loadStatus(), loadPosts(), loadEvents()]).catch(console.error);
    }
  }, 80);
}

function handleLiveEvent(type, data) {
  if (type === "hello") {
    setLivePill("on", "RT OK");
    const rt = $("#ctrlRtLabel");
    const rtDot = $("#ctrlDotRt");
    if (rt) rt.textContent = "ON";
    if (rtDot) rtDot.classList.remove("dim");
    return;
  }

  if (type === "post_hit") {
    setLivePill("hit", "HIT");
    setTimeout(() => setLivePill("on", "RT OK"), 1800);
    stampCtrl("hit", data.at || new Date().toISOString());
    pushLiveFeed({
      kind: "post",
      at: data.at,
      link: data.link,
      message: data.message || data.link,
      postId: data.postId,
    });
    const short = shortLink(data.link || "");
    showHitToast(
      `<strong>Channel hit</strong> · ${escapeHtml(short)} · drip started`
    );
    scheduleRealtimeRefresh(true);
    // Flash after list re-renders
    setTimeout(() => flashPostCard(data.postId), 200);
    return;
  }

  if (type === "order") {
    pushLiveFeed({
      kind: "order",
      at: data.at,
      link: data.link,
      message: data.message || `+${data.qty} ${data.phaseId || ""}`,
      postId: data.postId,
    });
    if (data.phaseId === "instant") {
      showHitToast(
        `<strong>Instant +${Number(data.qty) || 56}</strong> · ${escapeHtml(
          shortLink(data.link || "")
        )}`
      );
      stampCtrl("hit", data.at || new Date().toISOString());
    } else if (data.phaseId === "manual") {
      showHitToast(
        `<strong>Manual +${Number(data.qty) || "?"}</strong> instant · ${escapeHtml(
          shortLink(data.link || "")
        )}`
      );
    }
    scheduleRealtimeRefresh(true);
    return;
  }

  if (type === "sync") {
    stampCtrl("sync", data.at || new Date().toISOString());
    pushLiveFeed({
      kind: "post",
      at: data.at,
      message: data.message || "sync",
    });
    scheduleRealtimeRefresh(true);
  }
}

function connectLive() {
  if (es) {
    try {
      es.close();
    } catch (_) {}
    es = null;
  }
  // EventSource reconnects automatically; avoid spam labels
  es = new EventSource("/api/live");
  setLivePill("off", "RT…");

  es.addEventListener("hello", (e) => {
    try {
      handleLiveEvent("hello", JSON.parse(e.data));
    } catch (_) {
      setLivePill("on", "RT OK");
    }
  });

  for (const type of ["post_hit", "order", "sync"]) {
    es.addEventListener(type, (e) => {
      try {
        handleLiveEvent(type, JSON.parse(e.data));
      } catch (err) {
        console.error("live event parse", err);
      }
    });
  }

  // EventSource fires error on every reconnect attempt — only show if still closed
  let errStreak = 0;
  es.onerror = () => {
    errStreak += 1;
    if (es && es.readyState === EventSource.CLOSED) {
      setLivePill("off", "RT OFF");
      // manual reconnect after full close
      setTimeout(connectLive, 2000);
    } else if (errStreak === 1) {
      setLivePill("off", "RT…");
    }
  };
  es.onopen = () => {
    errStreak = 0;
  };
}

// poll (backup) + live stream
loadAll();
api("/api/manual-boost")
  .then((m) => {
    const el = $("#manualBoostSvc");
    if (el && m.serviceId) el.textContent = `#${m.serviceId}`;
  })
  .catch(() => {});
connectLive();
setInterval(loadAll, 15000);

