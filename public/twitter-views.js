/* X / Twitter post views page — separate from likes & comments */

const $ = (sel) => document.querySelector(sel);

let settings = null;
let services = [];
let selectedSvc = null;
let cheapestSvc = null;
let instantSvc = null;

const CHEAP_QTYS = [500, 1000, 2500, 5000, 10000];

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

const COST_QTYS = [100, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];

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
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return String(n);
}

function qtyAllowed(svc, qty) {
  if (!svc) return false;
  const min = Number(svc.min) || 1;
  const max = Number(svc.max) || Infinity;
  return qty >= min && qty <= max;
}

function shortPost(link) {
  const s = String(link || "");
  const m = s.match(/x\.com\/([^/]+)\/status\/(\d+)/i);
  if (m) return `@${m[1]}/…${m[2].slice(-6)}`;
  return s.replace(/^https:\/\/x\.com\//, "") || "—";
}

function renderCostTable() {
  const body = $("#costBody");
  const rateLabel = $("#costRateLabel");
  const footer = $("#costFooter");
  if (!body) return;

  if (!selectedSvc) {
    body.innerHTML = `<tr><td colspan="2" class="muted-sm">Pick a service…</td></tr>`;
    if (rateLabel) rateLabel.textContent = "$— / 1k";
    if (footer) footer.textContent = "Click a row to set quantity";
    return;
  }

  const rate = Number(selectedSvc.rate);
  if (rateLabel) {
    rateLabel.textContent = Number.isFinite(rate)
      ? `$${rate}/1k`
      : "$— / 1k";
  }

  const currentQty = Number($("#qtyInput")?.value) || 0;
  let rows = COST_QTYS.filter((q) => qtyAllowed(selectedSvc, q));
  if (!rows.length) {
    const min = Number(selectedSvc.min) || 1;
    const max = Number(selectedSvc.max) || min;
    rows = [min, Math.min(max, min * 2), Math.min(max, 1000), Math.min(max, 5000)]
      .filter((q, i, a) => a.indexOf(q) === i && qtyAllowed(selectedSvc, q));
  }

  body.innerHTML = rows
    .map((q) => {
      const cost = estCost(selectedSvc, q);
      const active = q === currentQty ? " class=\"tw-cost-active\"" : "";
      const disabled = !qtyAllowed(selectedSvc, q);
      return `<tr data-qty="${q}"${active}${disabled ? " data-disabled=\"1\"" : ""}>
        <td>+${fmtQty(q)}</td>
        <td><strong>${fmtMoney(cost)}</strong></td>
      </tr>`;
    })
    .join("");

  if (footer) {
    const min = selectedSvc.min || 1;
    const max = selectedSvc.max || "∞";
    footer.textContent = `Service min ${min} · max ${max} · click a row to set qty`;
  }
}

function updateCostHint() {
  const qty = Number($("#qtyInput")?.value) || 0;
  const cost = estCost(selectedSvc, qty);
  $("#ctrlCost").textContent =
    cost == null ? "—" : `~${fmtMoney(cost)}`;
  if (selectedSvc) {
    const min = selectedSvc.min || 1;
    const max = selectedSvc.max || "∞";
    $("#svcMeta").textContent = `min ${min} · max ${max} · $${selectedSvc.rate}/1k`;
    $("#svcPill").textContent = `svc ${selectedSvc.service}`;
  } else {
    $("#svcMeta").textContent = "—";
  }
  renderCostTable();
}

function renderCheapestDeal(svc) {
  cheapestSvc = svc || null;
  const rateEl = $("#cheapDealRate");
  const metaEl = $("#cheapDealMeta");
  const pricesEl = $("#cheapDealPrices");
  const hintEl = $("#cheapDealHint");
  if (!rateEl || !metaEl || !pricesEl) return;

  if (!cheapestSvc) {
    rateEl.innerHTML = `$— <span>/ 1k</span>`;
    metaEl.textContent = "Loading…";
    pricesEl.innerHTML = "";
    return;
  }

  rateEl.innerHTML = `$${escapeHtml(String(cheapestSvc.rate))} <span>/ 1k</span>`;
  metaEl.textContent = `#${cheapestSvc.service} · min ${cheapestSvc.min} · max ${cheapestSvc.max} · ${String(cheapestSvc.name || "").slice(0, 70)}`;
  if (hintEl) {
    hintEl.textContent = "Lowest $/1k X post views service from JAP right now";
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
  if (!cheapestSvc) return;
  selectService(cheapestSvc, qty, `Selected cheapest #${cheapestSvc.service} · $${cheapestSvc.rate}/1k`);
}

function parseSpeedLabel(name) {
  const n = String(name || "");
  const m =
    n.match(/speed:\s*up to\s*([\d.]+)\s*k/i) ||
    n.match(/speed:\s*([\d.]+)\s*k\/?d/i) ||
    n.match(/speed:\s*([\d.]+)\s*k/i);
  if (m) return `⚡ up to ${m[1]}k/day`;
  return "⚡ fast fill";
}

function renderInstantDeal(svc) {
  instantSvc = svc || null;
  const rateEl = $("#instantDealRate");
  const metaEl = $("#instantDealMeta");
  const pricesEl = $("#instantDealPrices");
  const hintEl = $("#instantDealHint");
  const statsEl = $("#instantStats");
  const tagEl = $("#instantSvcTag");
  if (!rateEl || !metaEl || !pricesEl) return;

  if (!instantSvc) {
    rateEl.innerHTML = `$— <span>/ 1k</span>`;
    metaEl.textContent = "Loading best instant service…";
    pricesEl.innerHTML = "";
    if (tagEl) tagEl.textContent = "svc —";
    return;
  }

  rateEl.innerHTML = `$${escapeHtml(String(instantSvc.rate))} <span>/ 1k</span>`;
  metaEl.textContent = `#${instantSvc.service} · min ${instantSvc.min} · max ${fmtQty(instantSvc.max)} · ${String(instantSvc.name || "").slice(0, 72)}`;
  if (hintEl) {
    hintEl.textContent =
      "Fast-start lane — begins within ~1 hour, cheapest among instant view services.";
  }
  if (tagEl) tagEl.textContent = `svc #${instantSvc.service}`;
  if (statsEl) {
    statsEl.innerHTML = `
      <span>⏱ 0–1h start</span>
      <span>${escapeHtml(parseSpeedLabel(instantSvc.name))}</span>
      <span>💵 $${escapeHtml(String(instantSvc.rate))}/1k</span>
    `;
  }

  const qtys = CHEAP_QTYS.filter((q) => qtyAllowed(instantSvc, q));
  pricesEl.innerHTML = qtys
    .map((q) => {
      const cost = estCost(instantSvc, q);
      return `<button type="button" class="tw-instant-pack" data-instant-qty="${q}">
        <span class="q">+${fmtQty(q)} views</span>
        <span class="c">${fmtMoney(cost)}</span>
        <span class="t">instant lane · est.</span>
      </button>`;
    })
    .join("");
}

function armInstantPanel() {
  const panel = $("#instantDealPanel");
  if (!panel) return;
  panel.classList.remove("is-armed");
  void panel.offsetWidth;
  panel.classList.add("is-armed");
}

function useInstantService(qty) {
  if (!instantSvc) return;
  selectService(
    instantSvc,
    qty,
    `Instant Views armed · #${instantSvc.service} · $${instantSvc.rate}/1k`
  );
  armInstantPanel();
}

function scrollToOrderForm() {
  const form = $("#orderForm");
  if (!form) return;
  form.scrollIntoView({ behavior: "smooth", block: "center" });
  const btn = $("#orderBtn");
  if (btn) {
    btn.focus({ preventScroll: true });
  }
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
    if (cur < min) $("#qtyInput").value = String(Math.max(min, 1000));
  }
  updateCostHint();
  if (msg) showMsg($("#formMsg"), msg, "ok");
}

function renderServices(items, preferredId) {
  const sel = $("#serviceSelect");
  services = items || [];
  if (!services.length) {
    sel.innerHTML = `<option value="">No X view services found</option>`;
    selectedSvc = null;
    updateCostHint();
    return;
  }
  const prefer = Number(preferredId) || Number(settings?.serviceId) || services[0].service;
  sel.innerHTML = services
    .map((s) => {
      const label = `#${s.service} · $${s.rate}/1k · ${String(s.name).slice(0, 72)}`;
      return `<option value="${s.service}">${escapeHtml(label)}</option>`;
    })
    .join("");
  const has = services.some((s) => s.service === prefer);
  sel.value = String(has ? prefer : services[0].service);
  selectedSvc = services.find((s) => s.service === Number(sel.value)) || services[0];
  updateCostHint();
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
  settings = await api("/api/twitter-views/settings");
  setLiveUi(settings.liveMode);
  if (settings.postUrl) {
    $("#postInput").value = settings.postUrl;
    $("#ctrlPost").textContent = shortPost(settings.postUrl);
  }
  $("#ctrlDefaultSvc").textContent = String(settings.defaultServiceId || "—");

  if (settings.cheapest) renderCheapestDeal(settings.cheapest);
  if (settings.instantCheap) renderInstantDeal(settings.instantCheap);
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

async function loadServices() {
  const sel = $("#serviceSelect");
  try {
    if (sel && !services.length) {
      sel.innerHTML = `<option value="">Loading services…</option>`;
    }
    const data = await api("/api/twitter-views/services");
    if (data.cheapest) renderCheapestDeal(data.cheapest);
    if (data.instantCheap) renderInstantDeal(data.instantCheap);
    renderServices(data.items, settings?.serviceId || data.defaultServiceId);
    if (data.partial) {
      setTimeout(() => {
        api("/api/twitter-views/services")
          .then((full) => {
            if (full.cheapest) renderCheapestDeal(full.cheapest);
            if (full.instantCheap) renderInstantDeal(full.instantCheap);
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
  const search = $("#orderSearch")?.value?.trim();
  if (mode) q.set("mode", mode);
  if (status) q.set("status", status);
  if (search) q.set("q", search);
  const data = await api("/api/twitter-views/orders?" + q.toString());
  const body = $("#ordersBody");
  const items = data.items || [];
  const sum = data.summary || {};

  $("#sOrders").textContent = String(sum.orders ?? items.length);
  $("#sViews").textContent = String(sum.views ?? 0);
  $("#sLive").textContent = String(sum.live ?? 0);
  $("#sDry").textContent = String(sum.dry ?? 0);

  const active = Number(sum.active) || items.filter((o) => {
    const ph = o.progress?.phase;
    return o.mode === "live" && (ph === "pending" || ph === "filling");
  }).length;
  ensureProgressPolling(active > 0);

  if (!items.length) {
    body.innerHTML = `<tr><td colspan="8" class="muted-sm">No orders yet</td></tr>`;
    $("#ordersFooter").textContent = "No X post view orders yet";
    showMsg($("#mismatchBanner"), "");
    return;
  }

  const bad = items.find((o) => o.mismatch);
  if (bad) {
    showMsg(
      $("#mismatchBanner"),
      `JAP marked #${bad.japOrderId || bad.id} completed, but it used ${bad.serviceName || "a non-views service"} — that does not add the public view count on X. Re-order with Tweet Views (default #8413).`,
      "err"
    );
  } else {
    showMsg($("#mismatchBanner"), "");
  }

  body.innerHTML = items
    .map((o) => {
      const modeCls = o.mode === "live" ? "live" : "";
      const statusCell = o.mismatch
        ? `<td><span class="pill" style="padding:0.2rem 0.45rem;font-size:0.65rem;color:#f87171;border-color:rgba(248,113,113,.4)">wrong svc</span> ${escapeHtml(o.status || "—")}</td>`
        : `<td>${escapeHtml(o.status || "—")}</td>`;
      const svcTitle = o.mismatch
        ? `${o.serviceName || ""} — NOT tweet views`
        : o.serviceName || "";
      return `<tr${o.mismatch ? " style=\"opacity:.85\"" : ""}>
        <td>${escapeHtml(fmtTime(o.at))}</td>
        <td><span class="pill ${modeCls}" style="padding:0.2rem 0.45rem;font-size:0.65rem">${escapeHtml(o.mode || "—")}</span></td>
        ${statusCell}
        ${progressCell(o)}
        <td>+${escapeHtml(String(o.quantity || 0))}</td>
        <td title="${escapeHtml(svcTitle)}">#${escapeHtml(String(o.serviceId || "—"))}</td>
        <td class="mono">${escapeHtml(o.japOrderId || "—")}</td>
        <td><a href="${escapeHtml(o.link || "#")}" target="_blank" rel="noopener">${escapeHtml(shortPost(o.link))}</a></td>
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
    await api("/api/twitter-views/orders/refresh-status", {
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
    loadServices(),
    loadOrders().catch((err) => showMsg($("#formMsg"), err.message, "err")),
  ]);
}

$("#serviceSelect")?.addEventListener("change", () => {
  selectedSvc = services.find((s) => s.service === Number($("#serviceSelect").value)) || null;
  updateCostHint();
});

$("#qtyInput")?.addEventListener("input", updateCostHint);

$("#costBody")?.addEventListener("click", (e) => {
  const row = e.target.closest("tr[data-qty]");
  if (!row || row.dataset.disabled === "1") return;
  const qty = Number(row.dataset.qty);
  if (!Number.isFinite(qty) || qty <= 0) return;
  const input = $("#qtyInput");
  if (input) {
    input.value = String(qty);
    updateCostHint();
  }
});

$("#useCheapBtn")?.addEventListener("click", () => useCheapestService());

$("#cheapDealPrices")?.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-cheap-qty]");
  if (!chip) return;
  const qty = Number(chip.dataset.cheapQty);
  useCheapestService(Number.isFinite(qty) ? qty : undefined);
});

$("#useInstantBtn")?.addEventListener("click", () => useInstantService());

$("#orderInstantBtn")?.addEventListener("click", () => {
  useInstantService();
  scrollToOrderForm();
});

$("#instantDealPrices")?.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-instant-qty]");
  if (!chip) return;
  const qty = Number(chip.dataset.instantQty);
  useInstantService(Number.isFinite(qty) ? qty : undefined);
  scrollToOrderForm();
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
    const result = await api("/api/twitter-views/order", {
      method: "POST",
      timeoutMs: 60000,
      body: JSON.stringify({
        link: fd.get("link"),
        serviceId: Number(serviceId),
        quantity: Number(fd.get("quantity")),
        note: fd.get("note") || undefined,
      }),
    });
    const o = result.order;
    showMsg(
      $("#formMsg"),
      `${result.live ? "LIVE" : "DRY-RUN"} +${o.quantity} views → ${o.link}` +
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

$("#savePostBtn")?.addEventListener("click", async () => {
  try {
    const postUrl = $("#postInput").value;
    const serviceId = Number($("#serviceSelect").value) || undefined;
    await api("/api/twitter-views/settings", {
      method: "POST",
      body: JSON.stringify({ postUrl, serviceId }),
    });
    await loadSettings();
    showMsg($("#ctrlMsg"), "Post URL & service saved", "ok");
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

refreshAll().catch((err) => {
  showMsg($("#formMsg"), err.message, "err");
});
