/* YouTube task desk — solid @ognoormuhammad8951 + costs */

const $ = (sel) => document.querySelector(sel);

const SOLID = {
  handle: "ognoormuhammad8951",
  displayName: "Og Noor Muhammad",
  profileUrl: "https://www.youtube.com/@ognoormuhammad8951",
  initials: "ON",
  locked: true,
};

let settings = null;
let services = [];
let selectedSvc = null;
let selectedTask = "subscribers";
let taskMenu = [];

const COST_QTYS = [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];

async function api(path, opts = {}) {
  const ctrl = new AbortController();
  const ms = opts.timeoutMs ?? 45000;
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
      signal: ctrl.signal,
      timeoutMs: undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText || "Request failed");
    return data;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Request timed out — try again");
    if (err.message === "Failed to fetch" || err.name === "TypeError") {
      throw new Error("Cannot reach server — is it running? Refresh and try again");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function showMsg(el, text, kind = "") {
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || "";
  el.className = "msg" + (kind ? " " + kind : "");
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function estCost(svc, qty) {
  if (!svc || !qty) return null;
  const rate = Number(svc.rate);
  if (!Number.isFinite(rate)) return null;
  return (rate * qty) / 1000;
}

function fmtMoney(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function fmtQty(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return String(n);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortLink(url) {
  const u = String(url || "");
  if (!u) return "—";
  try {
    const parsed = new URL(u);
    if (parsed.searchParams.get("v")) return `v=${parsed.searchParams.get("v")}`;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0]?.startsWith("@")) return parts[0];
    return parts.slice(0, 2).join("/") || parsed.hostname;
  } catch {
    return u.slice(0, 28);
  }
}

function qtyAllowed(svc, qty) {
  if (!svc) return false;
  const min = Number(svc.min) || 1;
  const max = Number(svc.max) || Infinity;
  return qty >= min && qty <= max;
}

function currentTaskMeta() {
  return taskMenu.find((t) => t.id === selectedTask) || null;
}

function renderTaskGrid() {
  const grid = $("#taskGrid");
  if (!grid) return;
  if (!taskMenu.length) {
    grid.innerHTML = `<div class="yt-task-empty muted-sm">Loading task lanes…</div>`;
    return;
  }

  grid.innerHTML = taskMenu
    .map((t) => {
      const active = t.id === selectedTask ? " is-active" : "";
      const rate = t.ratePer1k != null ? `$${t.ratePer1k}` : "$—";
      const packs = (t.packs || [])
        .slice(0, 4)
        .map(
          (p) =>
            `<span class="yt-task-pack"><em>+${fmtQty(p.qty)}</em> ${fmtMoney(p.cost)}</span>`
        )
        .join("");
      return `<button type="button" class="yt-task-card${active}" data-task="${escapeHtml(t.id)}" role="option" aria-selected="${t.id === selectedTask}">
        <span class="yt-task-icon">${escapeHtml(t.icon || "▶")}</span>
        <span class="yt-task-name">${escapeHtml(t.label)}</span>
        <span class="yt-task-blurb">${escapeHtml(t.blurb || "")}</span>
        <span class="yt-task-rate">${rate} <small>/ 1k</small></span>
        <span class="yt-task-meta">#${escapeHtml(String(t.cheapest?.service || "—"))} · ${t.serviceCount || 0} svcs</span>
        <span class="yt-task-packs">${packs || "<span class='muted-sm'>No packs in range</span>"}</span>
      </button>`;
    })
    .join("");
}

function renderPriceBoard() {
  const board = $("#priceBoard");
  if (!board) return;
  if (!taskMenu.length) {
    board.innerHTML = `<p class="muted-sm">Loading…</p>`;
    return;
  }
  board.innerHTML = taskMenu
    .map((t) => {
      const active = t.id === selectedTask ? " is-active" : "";
      return `<button type="button" class="yt-price-row${active}" data-task="${escapeHtml(t.id)}">
        <span>${escapeHtml(t.icon || "")} ${escapeHtml(t.label)}</span>
        <strong>$${escapeHtml(String(t.ratePer1k ?? "—"))}<small>/1k</small></strong>
      </button>`;
    })
    .join("");
}

function renderPacks() {
  const grid = $("#packGrid");
  if (!grid) return;
  const meta = currentTaskMeta();
  const svc = selectedSvc || meta?.cheapest;
  const packs = meta?.packs?.length
    ? meta.packs
    : (COST_QTYS.filter((q) => qtyAllowed(svc, q)).map((qty) => ({
        qty,
        cost: estCost(svc, qty),
      })));

  if (!svc || !packs.length) {
    grid.innerHTML = "";
    return;
  }

  const currentQty = Number($("#qtyInput")?.value) || 0;
  grid.innerHTML = packs
    .map((p) => {
      const active = p.qty === currentQty ? " is-active" : "";
      return `<button type="button" class="yt-pack${active}" data-qty="${p.qty}">
        <span class="q">+${fmtQty(p.qty)}</span>
        <span class="c">${fmtMoney(p.cost)}</span>
      </button>`;
    })
    .join("");
}

function renderCostTable() {
  const body = $("#costBody");
  const rateLabel = $("#costRateLabel");
  const footer = $("#costFooter");
  if (!body) return;

  if (!selectedSvc) {
    body.innerHTML = `<tr><td colspan="2" class="muted-sm">Pick a task…</td></tr>`;
    if (rateLabel) rateLabel.textContent = "$— / 1k";
    return;
  }

  const rate = Number(selectedSvc.rate);
  if (rateLabel) {
    rateLabel.textContent = Number.isFinite(rate) ? `$${rate}/1k` : "$— / 1k";
  }

  const currentQty = Number($("#qtyInput")?.value) || 0;
  let rows = COST_QTYS.filter((q) => qtyAllowed(selectedSvc, q));
  if (!rows.length) {
    const min = Number(selectedSvc.min) || 1;
    const max = Number(selectedSvc.max) || min;
    rows = [min, Math.min(max, min * 2), Math.min(max, 500), Math.min(max, 1000)]
      .filter((q, i, a) => a.indexOf(q) === i && qtyAllowed(selectedSvc, q));
  }

  body.innerHTML = rows
    .map((q) => {
      const cost = estCost(selectedSvc, q);
      const active = q === currentQty ? ' class="tw-cost-active"' : "";
      return `<tr data-qty="${q}"${active}>
        <td>+${fmtQty(q)}</td>
        <td><strong>${fmtMoney(cost)}</strong></td>
      </tr>`;
    })
    .join("");

  if (footer) {
    footer.textContent = `min ${selectedSvc.min || 1} · max ${selectedSvc.max || "∞"} · click to set qty`;
  }
}

function updateCostHint() {
  const qty = Number($("#qtyInput")?.value) || 0;
  const cost = estCost(selectedSvc, qty);
  const meta = currentTaskMeta();
  const rate = selectedSvc ? Number(selectedSvc.rate) : meta?.ratePer1k;

  $("#ctrlCost").textContent = cost == null ? "—" : `~${fmtMoney(cost)}`;
  $("#selectedPackLabel").textContent = qty ? `+${fmtQty(qty)} ${meta?.unit || ""}` : "+—";
  $("#selectedPackCost").textContent = fmtMoney(cost);

  if ($("#heroBurn")) {
    $("#heroBurn").innerHTML = Number.isFinite(rate)
      ? `$${escapeHtml(String(rate))} <small>/ 1k</small>`
      : `$— <small>/ 1k</small>`;
  }
  if ($("#heroPackCost")) $("#heroPackCost").textContent = fmtMoney(cost);
  if ($("#heroBurnSub")) {
    $("#heroBurnSub").textContent = qty
      ? `${fmtQty(qty)} ${meta?.unit || "units"} · ${meta?.label || selectedTask}`
      : `solid @${SOLID.handle}`;
  }
  if ($("#heroTaskLabel")) {
    $("#heroTaskLabel").textContent = meta?.label || selectedTask;
  }

  if (selectedSvc) {
    $("#svcMeta").textContent = `min ${selectedSvc.min || 1} · max ${selectedSvc.max || "∞"} · $${selectedSvc.rate}/1k`;
    $("#svcPill").textContent = `${selectedTask} · #${selectedSvc.service}`;
  } else {
    $("#svcMeta").textContent = "—";
  }

  renderPacks();
  renderCostTable();
}

function renderSolidAccount(account) {
  const a = account || SOLID;
  if ($("#solidDisplayName")) {
    $("#solidDisplayName").textContent = a.displayName || SOLID.displayName;
  }
  if ($("#solidHandle")) {
    $("#solidHandle").textContent = "@" + (a.handle || SOLID.handle);
    $("#solidHandle").href = a.profileUrl || SOLID.profileUrl;
  }
  if ($("#solidInitials")) {
    $("#solidInitials").textContent = a.initials || SOLID.initials;
  }
  if ($("#lockedLinkText")) {
    $("#lockedLinkText").textContent = "@" + (a.handle || SOLID.handle);
  }
  if ($("#ctrlLink")) {
    $("#ctrlLink").textContent = "@" + (a.handle || SOLID.handle);
  }
  const openBtn = $("#openChannelBtn");
  if (openBtn) openBtn.href = a.profileUrl || SOLID.profileUrl;
}

function updateLinkHint() {
  const meta = currentTaskMeta();
  const hint = $("#linkHint");
  const input = $("#linkInput");
  const wrap = $("#linkFieldWrap");
  const locked = $("#lockedLinkBox");
  if (!meta) return;

  const isSubs = meta.id === "subscribers" || meta.linkKind === "channel";
  if (locked) locked.hidden = !isSubs;
  if (wrap) wrap.hidden = isSubs;

  if (isSubs) {
    if (input) {
      input.value = SOLID.profileUrl;
      input.required = false;
    }
    if (hint) {
      hint.textContent = `Subscribers lock to @${SOLID.handle} — solid channel.`;
    }
  } else {
    if (input) {
      input.required = true;
      if (!input.value || input.value === SOLID.profileUrl) {
        input.value = "";
        input.placeholder = `Paste a video from @${SOLID.handle}`;
      }
    }
    if (hint) {
      hint.textContent = `Paste a video / Shorts URL from @${SOLID.handle} for ${meta.label}.`;
    }
  }

  $("#orderKicker").textContent = `Armed · ${meta.label}`;
  $("#ctrlTask").textContent = meta.id;
  const hidden = $("#taskHidden");
  if (hidden) hidden.value = meta.id;
}

function selectService(svc, qty, msg) {
  if (!svc) return;
  const sel = $("#serviceSelect");
  if (sel) {
    const exists = [...sel.options].some(
      (o) => Number(o.value) === Number(svc.service)
    );
    if (!exists) {
      const opt = document.createElement("option");
      opt.value = String(svc.service);
      opt.textContent = `#${svc.service} · $${svc.rate}/1k · ${String(svc.name || "").slice(0, 72)}`;
      sel.appendChild(opt);
    }
    sel.value = String(svc.service);
  }
  if (!services.some((s) => s.service === svc.service)) {
    services = [svc, ...services];
  }
  selectedSvc = svc;
  if (qty && $("#qtyInput")) {
    $("#qtyInput").value = String(qty);
  } else if ($("#qtyInput")) {
    const min = Number(svc.min) || 100;
    const cur = Number($("#qtyInput").value) || 0;
    if (cur < min) $("#qtyInput").value = String(Math.max(min, 100));
  }
  updateCostHint();
  if (msg) showMsg($("#formMsg"), msg, "ok");
}

function renderServices(items, preferredId) {
  const sel = $("#serviceSelect");
  services = items || [];
  if (!services.length) {
    sel.innerHTML = `<option value="">No services for this task</option>`;
    selectedSvc = null;
    updateCostHint();
    return;
  }
  const prefer =
    Number(preferredId) ||
    Number(settings?.serviceId) ||
    services[0].service;
  sel.innerHTML = services
    .map((s) => {
      const label = `#${s.service} · $${s.rate}/1k · ${String(s.name).slice(0, 72)}`;
      return `<option value="${s.service}">${escapeHtml(label)}</option>`;
    })
    .join("");
  const has = services.some((s) => s.service === prefer);
  sel.value = String(has ? prefer : services[0].service);
  selectedSvc =
    services.find((s) => s.service === Number(sel.value)) || services[0];
  updateCostHint();
}

async function selectTask(taskId, opts = {}) {
  selectedTask = String(taskId || "subscribers");
  renderTaskGrid();
  renderPriceBoard();
  updateLinkHint();
  showMsg($("#formMsg"), `Armed ${selectedTask} · @${SOLID.handle}`, "ok");
  await loadServices({ preferCheapest: opts.preferCheapest !== false });
  const meta = currentTaskMeta();
  if (meta?.cheapest && opts.useCheapest !== false) {
    selectService(
      meta.cheapest,
      opts.qty || meta.packs?.[0]?.qty,
      `Cheapest ${meta.label} · $${meta.cheapest.rate}/1k · @${SOLID.handle}`
    );
  }
}

function setLiveUi(live) {
  const pill = $("#modePill");
  const badge = $("#ctrlModeBadge");
  const toggle = $("#liveToggle");
  if (toggle) toggle.checked = !!live;
  if (pill) {
    pill.textContent = live ? "LIVE" : "DRY-RUN";
    pill.classList.toggle("live", !!live);
  }
  if (badge) {
    badge.textContent = live ? "LIVE" : "DRY-RUN";
    badge.classList.toggle("live", !!live);
  }
}

async function loadBalance() {
  try {
    const bal = await api("/api/balance");
    const n = bal.balance != null ? bal.balance : bal;
    $("#balPill").textContent = `balance ${n}`;
  } catch {
    $("#balPill").textContent = "balance —";
  }
}

async function loadSettings() {
  settings = await api("/api/youtube/settings");
  setLiveUi(settings.liveMode);
  selectedTask = settings.task || "subscribers";
  if (Array.isArray(settings.tasks) && settings.tasks.length) {
    taskMenu = settings.tasks;
  }
  renderSolidAccount(settings.account || SOLID);
  if (settings.linkUrl && selectedTask !== "subscribers") {
    $("#linkInput").value = settings.linkUrl;
  } else if ($("#linkInput")) {
    $("#linkInput").value = SOLID.profileUrl;
  }
  $("#ctrlDefaultSvc").textContent = String(settings.defaultServiceId || "—");
  $("#ctrlTask").textContent = selectedTask;
  renderTaskGrid();
  renderPriceBoard();
  updateLinkHint();

  if (settings.service) {
    selectedSvc = settings.service;
    const sel = $("#serviceSelect");
    if (sel && (!services.length || sel.options.length <= 1)) {
      sel.innerHTML = `<option value="${settings.service.service}">#${settings.service.service} · $${settings.service.rate}/1k · ${escapeHtml(String(settings.service.name || "Selected").slice(0, 72))}</option>`;
      services = [settings.service];
    }
    updateCostHint();
  }
  return settings;
}

async function loadServices(opts = {}) {
  const sel = $("#serviceSelect");
  try {
    if (sel && !services.length) {
      sel.innerHTML = `<option value="">Loading services…</option>`;
    }
    const data = await api(
      `/api/youtube/services?task=${encodeURIComponent(selectedTask)}`
    );
    if (data.tasks?.length) {
      taskMenu = data.tasks;
      renderTaskGrid();
      renderPriceBoard();
    }
    const prefer = opts.preferCheapest
      ? data.cheapest?.service
      : settings?.serviceId || data.preferredServiceId || data.defaultServiceId;
    renderServices(data.items, prefer);
    if (opts.preferCheapest && data.cheapest) {
      selectService(data.cheapest);
    }
    if (data.partial) {
      setTimeout(() => {
        api(`/api/youtube/services?task=${encodeURIComponent(selectedTask)}`)
          .then((full) => {
            if (full.tasks?.length) {
              taskMenu = full.tasks;
              renderTaskGrid();
              renderPriceBoard();
            }
            if (!full.partial && full.items?.length) {
              renderServices(
                full.items,
                settings?.serviceId || full.defaultServiceId
              );
            }
          })
          .catch(() => {});
      }, 2500);
    }
  } catch (err) {
    if (!services.length) {
      sel.innerHTML = `<option value="">Failed to load services</option>`;
    }
    showMsg($("#formMsg"), `Services: ${err.message}`, "err");
    updateCostHint();
  }
}

function progressCell(o) {
  const p = o.progress || {};
  const pct = Math.max(0, Math.min(100, Number(p.pct) || 0));
  const phase = p.phase || "pending";
  const label = p.label || "—";
  const delivered = p.delivered != null ? p.delivered : null;
  const qty = p.qty != null ? p.qty : o.quantity;
  const detail =
    delivered != null && qty != null
      ? `${delivered} / ${qty} filled`
      : String(label);
  return `<td class="tw-progress-cell">
    <div class="tw-progress" data-phase="${escapeHtml(phase)}" title="${escapeHtml(detail)}">
      <div class="tw-progress-track">
        <div class="tw-progress-fill" style="width:${pct}%"></div>
      </div>
      <div class="tw-progress-meta">
        <span>${escapeHtml(String(label))}</span>
        <strong>${pct}%</strong>
      </div>
    </div>
  </td>`;
}

async function loadOrders() {
  const q = new URLSearchParams();
  const mode = $("#orderModeFilter")?.value;
  const status = $("#orderStatusFilter")?.value;
  const task = $("#orderTaskFilter")?.value;
  const search = $("#orderSearch")?.value?.trim();
  if (mode) q.set("mode", mode);
  if (status) q.set("status", status);
  if (task) q.set("task", task);
  if (search) q.set("q", search);
  const data = await api("/api/youtube/orders?" + q.toString());
  const body = $("#ordersBody");
  const items = data.items || [];
  const sum = data.summary || {};

  $("#sOrders").textContent = String(sum.orders ?? items.length);
  $("#sUnits").textContent = String(sum.units ?? 0);
  $("#sSpend").textContent = fmtMoney(sum.spend ?? 0);
  $("#sLive").textContent = String(sum.live ?? 0);

  const active =
    Number(sum.active) ||
    items.filter((o) => {
      const ph = o.progress?.phase;
      return o.mode === "live" && (ph === "pending" || ph === "filling");
    }).length;
  ensureProgressPolling(active > 0);

  if (!items.length) {
    body.innerHTML = `<tr><td colspan="10" class="muted-sm">No orders yet for @${SOLID.handle}</td></tr>`;
    $("#ordersFooter").textContent = `No YouTube orders yet · solid @${SOLID.handle}`;
    return;
  }

  body.innerHTML = items
    .map((o) => {
      const modeCls = o.mode === "live" ? "live" : "";
      const cost =
        o.charge != null
          ? fmtMoney(Number(o.charge))
          : fmtMoney(o.estCost ?? estCost({ rate: o.rate }, o.quantity));
      return `<tr>
        <td>${escapeHtml(fmtTime(o.at))}</td>
        <td><span class="yt-task-chip">${escapeHtml(o.task || "—")}</span></td>
        <td><span class="pill ${modeCls}" style="padding:0.2rem 0.45rem;font-size:0.65rem">${escapeHtml(o.mode || "—")}</span></td>
        <td>${escapeHtml(o.status || "—")}</td>
        ${progressCell(o)}
        <td>+${escapeHtml(String(o.quantity || 0))}</td>
        <td><strong>${cost}</strong></td>
        <td title="${escapeHtml(o.serviceName || "")}">#${escapeHtml(String(o.serviceId || "—"))}</td>
        <td class="mono">${escapeHtml(o.japOrderId || "—")}</td>
        <td><a href="${escapeHtml(o.link || "#")}" target="_blank" rel="noopener">${escapeHtml(shortLink(o.link))}</a></td>
      </tr>`;
    })
    .join("");
  $("#ordersFooter").textContent = `${items.length} order${items.length === 1 ? "" : "s"}${
    active ? ` · ${active} filling` : ""
  }`;
}

let progressTimer = null;
let progressBusy = false;

function ensureProgressPolling(need) {
  const label = $("#progressSyncLabel");
  if (label) label.hidden = !need;
  if (need && !progressTimer) {
    progressTimer = setInterval(() => {
      syncOrderProgress().catch(() => {});
    }, 8000);
    syncOrderProgress().catch(() => {});
  }
  if (!need && progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
}

async function syncOrderProgress() {
  if (progressBusy) return;
  progressBusy = true;
  try {
    await api("/api/youtube/orders/refresh-status", {
      method: "POST",
      timeoutMs: 60000,
      body: JSON.stringify({ limit: 20 }),
    });
    await loadOrders();
  } finally {
    progressBusy = false;
  }
}

async function refreshAll() {
  try {
    await loadSettings();
  } catch (err) {
    showMsg($("#formMsg"), err.message, "err");
  }
  await Promise.all([
    loadBalance().catch(() => {}),
    loadServices({ preferCheapest: true }),
    loadOrders().catch((err) => showMsg($("#formMsg"), err.message, "err")),
  ]);
}

$("#taskGrid")?.addEventListener("click", (e) => {
  const card = e.target.closest("[data-task]");
  if (!card) return;
  selectTask(card.dataset.task).catch((err) =>
    showMsg($("#formMsg"), err.message, "err")
  );
});

$("#priceBoard")?.addEventListener("click", (e) => {
  const row = e.target.closest("[data-task]");
  if (!row) return;
  selectTask(row.dataset.task).catch((err) =>
    showMsg($("#formMsg"), err.message, "err")
  );
});

$("#packGrid")?.addEventListener("click", (e) => {
  const pack = e.target.closest("[data-qty]");
  if (!pack) return;
  const qty = Number(pack.dataset.qty);
  if (!Number.isFinite(qty)) return;
  $("#qtyInput").value = String(qty);
  updateCostHint();
});

$("#serviceSelect")?.addEventListener("change", () => {
  selectedSvc =
    services.find((s) => s.service === Number($("#serviceSelect").value)) ||
    null;
  updateCostHint();
});

$("#qtyInput")?.addEventListener("input", updateCostHint);

$("#costBody")?.addEventListener("click", (e) => {
  const row = e.target.closest("tr[data-qty]");
  if (!row) return;
  const qty = Number(row.dataset.qty);
  if (!Number.isFinite(qty) || qty <= 0) return;
  $("#qtyInput").value = String(qty);
  updateCostHint();
});

$("#liveToggle")?.addEventListener("change", async (e) => {
  const on = !!e.target.checked;
  try {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({ liveMode: on }),
    });
    await loadSettings();
    showMsg($("#ctrlMsg"), on ? "Live mode ON" : "Dry-run (safe)", on ? "ok" : "");
  } catch (err) {
    e.target.checked = !on;
    showMsg($("#ctrlMsg"), err.message, "err");
  }
});

$("#orderForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const btn = $("#orderBtn");
  btn.disabled = true;
  showMsg($("#formMsg"), "Placing order…");
  try {
    let serviceId = Number(fd.get("serviceId"));
    if (!Number.isFinite(serviceId) || serviceId <= 0) {
      serviceId =
        selectedSvc?.service ||
        settings?.serviceId ||
        settings?.defaultServiceId;
    }
    if (!Number.isFinite(Number(serviceId)) || Number(serviceId) <= 0) {
      throw new Error("Pick a service first");
    }
    const task = fd.get("task") || selectedTask;
    const link =
      task === "subscribers"
        ? SOLID.profileUrl
        : fd.get("link") || SOLID.profileUrl;
    const result = await api("/api/youtube/order", {
      method: "POST",
      timeoutMs: 60000,
      body: JSON.stringify({
        task,
        link,
        serviceId: Number(serviceId),
        quantity: Number(fd.get("quantity")),
        note: fd.get("note") || undefined,
      }),
    });
    const o = result.order;
    const cost = result.estCost != null ? ` · ~${fmtMoney(result.estCost)}` : "";
    showMsg(
      $("#formMsg"),
      `${result.live ? "LIVE" : "DRY-RUN"} ${o.task} +${o.quantity}${cost} → ${shortLink(o.link)}` +
        (o.japOrderId ? ` · ${o.japOrderId}` : ""),
      "ok"
    );
    await loadOrders();
    await loadBalance();
  } catch (err) {
    showMsg($("#formMsg"), err.message, "err");
  } finally {
    btn.disabled = false;
  }
});

$("#saveLinkBtn")?.addEventListener("click", async () => {
  try {
    const linkUrl =
      selectedTask === "subscribers"
        ? SOLID.profileUrl
        : $("#linkInput").value || SOLID.profileUrl;
    const serviceId = Number($("#serviceSelect").value) || undefined;
    await api("/api/youtube/settings", {
      method: "POST",
      body: JSON.stringify({
        linkUrl,
        serviceId,
        task: selectedTask,
      }),
    });
    await loadSettings();
    showMsg($("#ctrlMsg"), `Saved · @${SOLID.handle}`, "ok");
  } catch (err) {
    showMsg($("#ctrlMsg"), err.message, "err");
  }
});

$("#armSubsBtn")?.addEventListener("click", () => {
  selectTask("subscribers").catch((err) =>
    showMsg($("#formMsg"), err.message, "err")
  );
});
$("#armViewsBtn")?.addEventListener("click", () => {
  selectTask("views").catch((err) =>
    showMsg($("#formMsg"), err.message, "err")
  );
});

$("#refreshBtn")?.addEventListener("click", () => refreshAll().catch(() => {}));
$("#ordersRefreshBtn")?.addEventListener("click", async () => {
  try {
    showMsg($("#formMsg"), "Syncing order progress…");
    await syncOrderProgress();
    showMsg($("#formMsg"), "Progress updated", "ok");
  } catch (err) {
    showMsg($("#formMsg"), err.message, "err");
  }
});

["orderModeFilter", "orderStatusFilter", "orderTaskFilter"].forEach((id) => {
  $(`#${id}`)?.addEventListener("change", () => loadOrders().catch(() => {}));
});
let searchTimer = null;
$("#orderSearch")?.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadOrders().catch(() => {}), 250);
});

renderSolidAccount(SOLID);
refreshAll().catch((err) => {
  showMsg($("#formMsg"), err.message, "err");
});
