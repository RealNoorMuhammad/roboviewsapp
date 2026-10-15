/* FOMO (fomo.family) followers — solid account @noormemewebdev */

const $ = (sel) => document.querySelector(sel);

const SOLID = {
  handle: "noormemewebdev",
  displayName: "Noor Muhammad Dev",
  profileUrl: "https://fomo.family/r/noormemewebdev",
  following: 35,
  followers: 3,
};

let settings = null;
let services = [];
let selectedSvc = null;
let cheapestSvc = null;
let ratePer1k = 1.5;
let rateIsEstimate = false;

const HOUSE_DEFAULT = {
  service: 900002,
  name: "FOMO Followers · Heat [Fast · Balanced]",
  rate: "1.50",
  min: 10,
  max: 5000,
  house: true,
  badge: "Heat",
  blurb: "Best bang · default pick",
  featured: true,
  speedPerHour: 3600,
};

const PACKS = [
  { qty: 10, tag: "Starter" },
  { qty: 20, tag: "Warm" },
  { qty: 50, tag: "Spark" },
  { qty: 100, tag: "Pop", hot: true },
  { qty: 200, tag: "Heat" },
  { qty: 500, tag: "Boost", hot: true },
  { qty: 1000, tag: "1K club" },
  { qty: 2000, tag: "Wave" },
  { qty: 5000, tag: "Legend", hot: true },
];

const CHEAP_QTYS = [10, 20, 100, 200, 500, 1000, 5000];

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
    if (err.name === "AbortError") {
      throw new Error("Request timed out — try again");
    }
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

function activeRate() {
  const fromSvc = Number(selectedSvc?.rate);
  if (Number.isFinite(fromSvc) && fromSvc > 0) return fromSvc;
  return Number.isFinite(ratePer1k) && ratePer1k > 0 ? ratePer1k : 1.5;
}

function estCost(_svc, qty) {
  if (!qty) return null;
  const rate = activeRate();
  return (rate * qty) / 1000;
}

function fmtMoney(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function fmtQty(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return String(n);
}

function qtyAllowed(svc, qty) {
  if (!svc || svc.estimate) return true;
  const min = Number(svc.min) || 1;
  const max = Number(svc.max) || Infinity;
  return qty >= min && qty <= max;
}

function handleFromLink(link) {
  if (!link) return "@" + SOLID.handle;
  return String(link).replace(/^https:\/\/fomo\.family\/r\//i, "@");
}

function currentServiceId() {
  const hidden = Number($("#serviceIdHidden")?.value);
  if (Number.isFinite(hidden) && hidden > 0) return hidden;
  const sel = Number($("#serviceSelect")?.value);
  if (Number.isFinite(sel) && sel > 0) return sel;
  return (
    selectedSvc?.service ||
    settings?.serviceId ||
    settings?.defaultServiceId ||
    900002
  );
}

function selectService(svc, { silent } = {}) {
  if (!svc) return;
  selectedSvc = svc;
  ratePer1k = Number(svc.rate) || ratePer1k;
  rateIsEstimate = Boolean(svc.estimate);
  if ($("#serviceIdHidden")) $("#serviceIdHidden").value = String(svc.service);
  if ($("#serviceSelect")) {
    const exists = [...($("#serviceSelect").options || [])].some(
      (o) => Number(o.value) === Number(svc.service)
    );
    if (!exists) {
      const opt = document.createElement("option");
      opt.value = String(svc.service);
      opt.textContent = svc.name || `#${svc.service}`;
      $("#serviceSelect").appendChild(opt);
    }
    $("#serviceSelect").value = String(svc.service);
  }
  updateCostHint();
  if (!silent) {
    showMsg(
      $("#formMsg"),
      `${svc.badge || "Service"} locked · $${svc.rate}/1k`,
      "ok"
    );
  }
}

function renderSvcGrid() {
  const grid = $("#svcGrid");
  if (!grid) return;
  const list = (services.length ? services : [HOUSE_DEFAULT]).filter(
    (s) => s.house || s.featured || services.length <= 6
  );
  const show = list.length ? list.slice(0, 6) : [HOUSE_DEFAULT];
  const activeId = currentServiceId();

  grid.innerHTML = show
    .map((s) => {
      const active = Number(s.service) === Number(activeId);
      const cls = [
        "fomo-svc",
        s.featured ? "fomo-svc-hot" : "",
        active ? "is-active" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<button type="button" class="${cls}" data-svc="${s.service}">
        <span class="fomo-svc-badge">${escapeHtml(s.badge || "FOMO")}</span>
        <span class="fomo-svc-rate">$${escapeHtml(String(s.rate))}<small>/1k</small></span>
        <span class="fomo-svc-blurb">${escapeHtml(s.blurb || s.name || "")}</span>
      </button>`;
    })
    .join("");
}

function selectPack(qty, { silent } = {}) {
  const input = $("#qtyInput");
  if (input) input.value = String(qty);
  updateCostHint();
  if (!silent) {
    const cost = estCost(selectedSvc, qty);
    showMsg(
      $("#formMsg"),
      `+${fmtQty(qty)} for ${SOLID.handle} · ${fmtMoney(cost)}`,
      "ok"
    );
  }
}

function renderSolidAccount(account) {
  const a = account || SOLID;
  if ($("#solidDisplayName")) $("#solidDisplayName").textContent = a.displayName || SOLID.displayName;
  if ($("#solidHandle")) {
    $("#solidHandle").textContent = "@" + (a.handle || SOLID.handle);
    $("#solidHandle").href = a.profileUrl || SOLID.profileUrl;
  }
  if ($("#solidFollowing")) $("#solidFollowing").textContent = String(a.following ?? SOLID.following);
  if ($("#solidFollowers")) $("#solidFollowers").textContent = String(a.followers ?? SOLID.followers);
  if ($("#profileInput")) $("#profileInput").value = a.profileUrl || SOLID.profileUrl;
  if ($("#ctrlProfile")) $("#ctrlProfile").textContent = "@" + (a.handle || SOLID.handle);
}

function renderRateStrip() {
  const rate = activeRate();
  const el = $("#rateStripValue");
  if (el) {
    el.innerHTML = `$${escapeHtml(String(rate))} <small>/ 1k</small>`;
  }
  const note = $("#rateStripNote");
  if (note) {
    const badge = selectedSvc?.badge || "Heat";
    const speed = selectedSvc?.speedPerHour;
    note.textContent = speed
      ? `${badge} · ~${fmtQty(speed)}/hr house fill`
      : `${badge} · house rate · local fill`;
    note.classList.add("is-live");
  }
}

function renderPriceBoard() {
  const board = $("#priceBoard");
  if (!board) return;
  board.innerHTML = `
    <div class="fomo-price-board-head">
      <span>Full price list</span>
      <span>$${activeRate()}/1k${rateIsEstimate ? " est." : ""}</span>
    </div>
    <div class="fomo-price-board-grid">
      ${PACKS.map((p) => {
        const cost = estCost(selectedSvc, p.qty);
        return `<div class="fomo-price-row">
          <span>+${fmtQty(p.qty)}</span>
          <strong>${fmtMoney(cost)}</strong>
        </div>`;
      }).join("")}
    </div>
  `;
}

function renderPacks() {
  const grid = $("#packGrid");
  if (!grid) return;
  const currentQty = Number($("#qtyInput")?.value) || 0;

  grid.innerHTML = PACKS.map((p) => {
    const allowed = qtyAllowed(selectedSvc, p.qty);
    const cost = estCost(selectedSvc, p.qty);
    const active = p.qty === currentQty;
    const cls = [
      "fomo-pack",
      p.hot ? "fomo-pack-hot" : "",
      active ? "is-active" : "",
      !allowed ? "is-disabled" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return `<button type="button" class="${cls}" data-qty="${p.qty}" role="option" aria-selected="${active}" ${!allowed ? "disabled" : ""}>
      <span class="fomo-pack-tag">${escapeHtml(p.tag)}</span>
      <span class="fomo-pack-qty">+${fmtQty(p.qty)}</span>
      <span class="fomo-pack-cost">${fmtMoney(cost)}</span>
    </button>`;
  }).join("");
}

function updateCostHint() {
  const qty = Number($("#qtyInput")?.value) || 0;
  const cost = estCost(selectedSvc, qty);

  $("#ctrlCost").textContent = cost == null ? "—" : fmtMoney(cost);

  const packLabel = $("#selectedPackLabel");
  const packCost = $("#selectedPackCost");
  const ctaQty = $("#ctaQty");
  const ctaCost = $("#ctaCost");
  if (packLabel) packLabel.textContent = `+${fmtQty(qty)}`;
  if (packCost) packCost.textContent = fmtMoney(cost);
  if (ctaQty) ctaQty.textContent = `+${fmtQty(qty)}`;
  if (ctaCost) ctaCost.textContent = fmtMoney(cost);

  const rateLabel = $("#svcRateLabel");
  if (rateLabel) rateLabel.textContent = `$${activeRate()} / 1k`;

  if (selectedSvc && selectedSvc.service) {
    const min = selectedSvc.min || 10;
    const max = selectedSvc.max || "∞";
    const rate = activeRate();
    const kind = selectedSvc.house ? "HOUSE" : "JAP";
    $("#svcMeta").textContent = `${kind} #${selectedSvc.service} · ${selectedSvc.badge || "svc"} · min ${min} · max ${max} · $${rate}/1k`;
    $("#svcPill").textContent = `${selectedSvc.badge || "svc"} ${selectedSvc.service}`;
  } else {
    $("#svcMeta").textContent = "Pick Starter, Heat, or Legend";
    $("#svcPill").textContent = "svc —";
  }

  renderRateStrip();
  renderSvcGrid();
  renderPacks();
  renderPriceBoard();
}

function renderCheapestDeal(svc) {
  cheapestSvc = svc || null;
  const rateEl = $("#cheapDealRate");
  const metaEl = $("#cheapDealMeta");
  const pricesEl = $("#cheapDealPrices");
  const hintEl = $("#cheapDealHint");
  if (!rateEl || !metaEl || !pricesEl) return;

  if (!cheapestSvc || !Number.isFinite(Number(cheapestSvc.rate)) || cheapestSvc.estimate) {
    rateEl.innerHTML = `$${escapeHtml(String(activeRate()))} <span>/ 1k</span>`;
    metaEl.textContent = "Estimate rate until a FOMO JAP service is linked";
    pricesEl.innerHTML = CHEAP_QTYS.map((q) => {
      const cost = estCost(null, q);
      return `<button type="button" class="tw-deal-chip" data-cheap-qty="${q}">
        <span>+${fmtQty(q)}</span>
        <strong>${fmtMoney(cost)}</strong>
      </button>`;
    }).join("");
    if (hintEl) hintEl.textContent = "Pack prices for @noormemewebdev (estimate)";
    return;
  }

  rateEl.innerHTML = `$${escapeHtml(String(cheapestSvc.rate))} <span>/ 1k</span>`;
  metaEl.textContent = `#${cheapestSvc.service} · min ${cheapestSvc.min} · max ${cheapestSvc.max} · ${String(cheapestSvc.name || "").slice(0, 70)}`;
  if (hintEl) {
    hintEl.textContent = "Lowest $/1k FOMO followers service from JAP right now";
  }

  const qtys = CHEAP_QTYS.filter((q) => qtyAllowed(cheapestSvc, q));
  pricesEl.innerHTML = qtys
    .map((q) => {
      const cost = estCost(cheapestSvc, q);
      return `<button type="button" class="tw-deal-chip" data-cheap-qty="${q}">
        <span>+${fmtQty(q)}</span>
        <strong>${fmtMoney(cost)}</strong>
      </button>`;
    })
    .join("");
}

function useCheapestService(qty) {
  if (!cheapestSvc || cheapestSvc.estimate) {
    if (qty) selectPack(qty);
    return;
  }
  const sel = $("#serviceSelect");
  if (sel) {
    const exists = [...sel.options].some(
      (o) => Number(o.value) === Number(cheapestSvc.service)
    );
    if (!exists) {
      const opt = document.createElement("option");
      opt.value = String(cheapestSvc.service);
      opt.textContent = `#${cheapestSvc.service} · $${cheapestSvc.rate}/1k · ${String(cheapestSvc.name || "").slice(0, 72)}`;
      sel.appendChild(opt);
    }
    sel.value = String(cheapestSvc.service);
  }
  if ($("#customSvcInput")) {
    $("#customSvcInput").value = String(cheapestSvc.service);
  }
  if (!services.some((s) => s.service === cheapestSvc.service)) {
    services = [cheapestSvc, ...services];
  }
  selectedSvc = cheapestSvc;
  rateIsEstimate = false;
  ratePer1k = Number(cheapestSvc.rate);
  if (qty) selectPack(qty, { silent: true });
  else updateCostHint();
  showMsg($("#formMsg"), `Selected cheapest #${cheapestSvc.service} · $${cheapestSvc.rate}/1k`, "ok");
}

function renderServices(items, preferredId) {
  const sel = $("#serviceSelect");
  services = (items && items.length ? items : [HOUSE_DEFAULT]).slice();
  const prefer =
    Number(preferredId) ||
    Number(settings?.serviceId) ||
    900002;

  if (sel) {
    sel.innerHTML = services
      .map((s) => {
        const label = `${s.badge || "#" + s.service} · $${s.rate}/1k`;
        return `<option value="${s.service}">${escapeHtml(label)}</option>`;
      })
      .join("");
  }

  const pick =
    services.find((s) => s.service === prefer) ||
    services.find((s) => s.featured) ||
    services[0] ||
    HOUSE_DEFAULT;
  selectService(pick, { silent: true });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
  settings = await api("/api/fomo/settings");
  setLiveUi(settings.liveMode);
  renderSolidAccount(settings.account || SOLID);

  if (settings.ratePer1k != null) ratePer1k = Number(settings.ratePer1k) || 1.5;
  rateIsEstimate = false;

  $("#ctrlDefaultSvc").textContent = String(
    settings.defaultServiceId || settings.serviceId || 900002
  );

  if (settings.catalogNote && $("#catalogHint")) {
    $("#catalogHint").textContent = settings.catalogNote;
  }

  if (settings.houseServices?.length) {
    services = settings.houseServices;
  }
  if (settings.cheapest) renderCheapestDeal(settings.cheapest);
  else renderCheapestDeal(settings.service);

  const pick =
    settings.service ||
    settings.houseServices?.find((s) => s.featured) ||
    HOUSE_DEFAULT;
  selectService(pick, { silent: true });
  return settings;
}

async function loadServices() {
  try {
    const prefer =
      currentServiceId() ||
      settings?.serviceId ||
      settings?.defaultServiceId ||
      900002;
    const data = await api(`/api/fomo/services?id=${prefer}`);
    if (data.cheapest) renderCheapestDeal(data.cheapest);
    renderServices(
      data.items?.length ? data.items : settings?.houseServices,
      prefer
    );
  } catch (err) {
    renderServices(settings?.houseServices || [HOUSE_DEFAULT], 900002);
    showMsg($("#formMsg"), `Services: ${err.message}`, "err");
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
  const search = $("#orderSearch")?.value?.trim();
  if (mode) q.set("mode", mode);
  if (status) q.set("status", status);
  if (search) q.set("q", search);
  const data = await api("/api/fomo/orders?" + q.toString());
  const body = $("#ordersBody");
  const items = data.items || [];
  const sum = data.summary || {};

  $("#sOrders").textContent = String(sum.orders ?? items.length);
  $("#sFollowers").textContent = String(sum.followers ?? 0);
  $("#sLive").textContent = String(sum.live ?? 0);
  $("#sDry").textContent = String(sum.dry ?? 0);

  const active =
    Number(sum.active) ||
    items.filter((o) => {
      const ph = o.progress?.phase;
      return o.mode === "live" && (ph === "pending" || ph === "filling");
    }).length;
  ensureProgressPolling(active > 0);

  if (!items.length) {
    body.innerHTML = `<tr><td colspan="8" class="muted-sm">No orders yet for @${SOLID.handle}</td></tr>`;
    $("#ordersFooter").textContent = `No FOMO follower orders yet · solid @${SOLID.handle}`;
    return;
  }

  body.innerHTML = items
    .map((o) => {
      const modeCls = o.mode === "live" ? "live" : "";
      return `<tr>
        <td>${escapeHtml(fmtTime(o.at))}</td>
        <td><span class="pill ${modeCls}" style="padding:0.2rem 0.45rem;font-size:0.65rem">${escapeHtml(o.mode || "—")}</span></td>
        <td>${escapeHtml(o.status || "—")}</td>
        ${progressCell(o)}
        <td>+${escapeHtml(String(o.quantity || 0))}</td>
        <td title="${escapeHtml(o.serviceName || "")}">#${escapeHtml(String(o.serviceId || "—"))}</td>
        <td class="mono">${escapeHtml(o.japOrderId || "—")}</td>
        <td><a href="${escapeHtml(o.link || SOLID.profileUrl)}" target="_blank" rel="noopener">${escapeHtml(handleFromLink(o.link))}</a></td>
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
    await api("/api/fomo/orders/refresh-status", {
      method: "POST",
      timeoutMs: 60000,
      body: JSON.stringify({ limit: 20 }),
    });
    await loadOrders();
    try {
      const acc = await api("/api/fomo/account");
      if (acc?.account) renderSolidAccount(acc.account);
    } catch {
      /* ignore */
    }
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
    loadServices(),
    loadOrders().catch((err) => showMsg($("#formMsg"), err.message, "err")),
  ]);
}

$("#packGrid")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".fomo-pack[data-qty]");
  if (!btn || btn.disabled) return;
  const qty = Number(btn.dataset.qty);
  if (!Number.isFinite(qty) || qty <= 0) return;
  selectPack(qty);
});

$("#svcGrid")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".fomo-svc[data-svc]");
  if (!btn) return;
  const id = Number(btn.dataset.svc);
  const svc = services.find((s) => s.service === id) || null;
  if (svc) selectService(svc);
});

$("#serviceSelect")?.addEventListener("change", () => {
  selectedSvc =
    services.find((s) => s.service === Number($("#serviceSelect").value)) ||
    null;
  if (selectedSvc) selectService(selectedSvc, { silent: true });
});

$("#qtyInput")?.addEventListener("input", updateCostHint);

$("#useCheapBtn")?.addEventListener("click", () => useCheapestService());

$("#cheapDealPrices")?.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-cheap-qty]");
  if (!chip) return;
  const qty = Number(chip.dataset.cheapQty);
  useCheapestService(Number.isFinite(qty) ? qty : undefined);
});

$("#orderForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#orderBtn");
  const qty = Number($("#qtyInput")?.value) || 0;
  const serviceId = currentServiceId();
  if (!Number.isFinite(qty) || qty <= 0) {
    showMsg($("#formMsg"), "Pick a pack or enter a quantity", "err");
    return;
  }
  if (!Number.isFinite(serviceId) || serviceId <= 0) {
    showMsg($("#formMsg"), "Pick a FOMO service lane", "err");
    return;
  }
  if (btn) btn.disabled = true;
  try {
    const result = await api("/api/fomo/order", {
      method: "POST",
      timeoutMs: 60000,
      body: JSON.stringify({
        link: $("#profileInput")?.value || SOLID.profileUrl,
        serviceId,
        quantity: qty,
      }),
    });
    const o = result.order;
    const kind = o.house ? "HOUSE" : result.live ? "LIVE" : "DRY-RUN";
    showMsg(
      $("#formMsg"),
      `${kind} +${o.quantity} → @${SOLID.handle}` +
        (o.japOrderId ? ` · ${o.japOrderId}` : "") +
        (o.house ? " · filling now" : ""),
      "ok"
    );
    await loadOrders();
    await loadBalance();
    await loadSettings().catch(() => {});
    const acc = result.account || (await api("/api/fomo/account").catch(() => null));
    if (acc?.account) renderSolidAccount(acc.account);
  } catch (err) {
    showMsg($("#formMsg"), err.message, "err");
  } finally {
    if (btn) btn.disabled = false;
  }
});

$("#heroFireBtn")?.addEventListener("click", () => {
  const heat =
    services.find((s) => s.service === 900002) ||
    services.find((s) => s.featured) ||
    HOUSE_DEFAULT;
  selectService(heat, { silent: true });
  selectPack(100, { silent: true });
  $("#orderForm")?.requestSubmit();
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

$("#saveProfileBtn")?.addEventListener("click", async () => {
  try {
    const serviceId = currentServiceId() || undefined;
    await api("/api/fomo/settings", {
      method: "POST",
      body: JSON.stringify({ serviceId }),
    });
    await loadSettings();
    showMsg($("#ctrlMsg"), "Heat account locked · service saved", "ok");
  } catch (err) {
    showMsg($("#ctrlMsg"), err.message, "err");
  }
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

["orderModeFilter", "orderStatusFilter"].forEach((id) => {
  $(`#${id}`)?.addEventListener("change", () => loadOrders().catch(() => {}));
});
let searchTimer = null;
$("#orderSearch")?.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadOrders().catch(() => {}), 250);
});

renderSolidAccount(SOLID);
selectService(HOUSE_DEFAULT, { silent: true });
refreshAll().catch((err) => {
  showMsg($("#formMsg"), err.message, "err");
});
