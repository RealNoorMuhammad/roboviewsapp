/* LinkedIn organic follower drip page — separate flows 100→500 */

const $ = (sel) => document.querySelector(sel);

const FLOW_TOTALS = [100, 200, 300, 400, 500];

let settings = null;
let services = [];
let selectedSvc = null;
let plan = null;
let selectedFlow = 100;

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

function profileLabel(link) {
  if (!link) return "—";
  return String(link)
    .replace(/^https?:\/\/(www\.)?linkedin\.com\//i, "")
    .replace(/\/$/, "");
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

function selectFlow(total) {
  selectedFlow = Number(total) || 100;
  const qty = $("#qtyInput");
  if (qty) qty.value = String(selectedFlow);
  renderFlowGrid();
  renderCostBoard();
  loadPlan().catch(() => {});
}

function renderFlowGrid() {
  const grid = $("#flowGrid");
  if (!grid) return;
  grid.innerHTML = FLOW_TOTALS.map((qty) => {
    const cost = estCost(selectedSvc, qty);
    const active = qty === selectedFlow ? " is-active" : "";
    return `<button type="button" class="li-flow-card${active}" data-flow="${qty}" role="option" aria-selected="${qty === selectedFlow}">
      <span class="li-flow-tag">Flow</span>
      <span class="li-flow-qty">+${qty}</span>
      <span class="li-flow-pulse">+10 / 5m · +5 / 3m</span>
      <span class="li-flow-cost">${fmtMoney(cost)}</span>
    </button>`;
  }).join("");
}

function renderCostBoard() {
  const board = $("#costBoard");
  if (!board) return;
  const rate = selectedSvc ? Number(selectedSvc.rate) : null;
  board.innerHTML = `
    <div class="li-cost-head">
      <h3>Cost by flow</h3>
      <span class="muted-sm">${rate != null && Number.isFinite(rate) ? `$${rate}/1k` : "pick a service"}</span>
    </div>
    <div class="table-wrap compact tw-cost-table">
      <table>
        <thead>
          <tr>
            <th>Flow</th>
            <th>Followers</th>
            <th>Est. cost</th>
          </tr>
        </thead>
        <tbody>
          ${FLOW_TOTALS.map((qty) => {
            const cost = estCost(selectedSvc, qty);
            const on = qty === selectedFlow ? ' class="is-selected"' : "";
            return `<tr data-flow="${qty}"${on} style="cursor:pointer">
              <td>Flow · ${qty}</td>
              <td>+${qty}</td>
              <td><strong>${fmtMoney(cost)}</strong></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
    <p class="footer-note">Tap a row or card to lock that separate flow</p>
  `;
}

function renderPlan() {
  const body = $("#planBody");
  const totalLabel = $("#planTotalLabel");
  const footer = $("#planFooter");
  if (!body) return;

  if (!plan?.steps?.length) {
    body.innerHTML = `<tr><td colspan="3" class="muted-sm">Loading plan…</td></tr>`;
    return;
  }

  if (totalLabel) totalLabel.textContent = `Flow · ${plan.total}`;

  let totalCost = 0;
  const preview = plan.steps.slice(0, 24);
  body.innerHTML =
    preview
      .map((s) => {
        const cost = estCost(selectedSvc, s.qty);
        if (cost != null) totalCost += cost;
        const when =
          s.afterMin < 60
            ? `${s.afterMin} min`
            : s.afterMin % 60 === 0
              ? `${s.afterMin / 60}h`
              : `${Math.floor(s.afterMin / 60)}h ${s.afterMin % 60}m`;
        return `<tr>
          <td>${escapeHtml(when)}</td>
          <td><strong>+${s.qty}</strong> <span class="muted-sm">/ ${s.gapMin || "—"}m</span></td>
          <td>${fmtMoney(cost)}</td>
        </tr>`;
      })
      .join("") +
    (plan.steps.length > preview.length
      ? `<tr><td colspan="3" class="muted-sm">… +${plan.steps.length - preview.length} more batches to ${plan.total}</td></tr>`
      : "");

  // Full cost still includes every batch
  totalCost = estCost(selectedSvc, plan.total) || totalCost;

  if (footer) {
    const rateOk = selectedSvc && Number.isFinite(Number(selectedSvc.rate));
    footer.textContent = rateOk
      ? `Total ~${fmtMoney(totalCost)} · ${plan.steps.length} batches over ~${plan.durationLabel} · ${plan.formula || "+10 / 5m · +5 / 3m"}`
      : `${plan.steps.length} batches over ~${plan.durationLabel} · pick a drip-friendly service (min ≤ 5)`;
  }

  $("#ctrlCost").textContent =
    selectedSvc && plan
      ? `~${fmtMoney(estCost(selectedSvc, plan.total))}`
      : "—";

  if (selectedSvc) {
    const min = selectedSvc.min || 1;
    const max = selectedSvc.max || "∞";
    const dripOk = plan.steps.every(
      (s) => s.qty >= min && s.qty <= (Number(max) || Infinity)
    );
    $("#svcMeta").textContent =
      `min ${min} · max ${max} · $${selectedSvc.rate}/1k` +
      (dripOk ? " · drip OK" : " · ⚠️ min too high for +5 batches");
    $("#svcPill").textContent = `svc ${selectedSvc.service}`;
  }
}

async function loadPlan() {
  const qty = Number($("#qtyInput")?.value) || selectedFlow || 100;
  selectedFlow = qty;
  plan = await api(`/api/linkedin/plan?total=${qty}`);
  renderFlowGrid();
  renderCostBoard();
  renderPlan();
}

function renderServices(items, preferredId) {
  const sel = $("#serviceSelect");
  services = items || [];
  if (!services.length) {
    sel.innerHTML = `<option value="">No LinkedIn follower services found</option>`;
    selectedSvc = null;
    renderFlowGrid();
    renderCostBoard();
    renderPlan();
    return;
  }

  const sorted = [...services].sort((a, b) => {
    const aOk = (a.min || 1) <= 5 ? 0 : 1;
    const bOk = (b.min || 1) <= 5 ? 0 : 1;
    if (aOk !== bOk) return aOk - bOk;
    return Number(a.rate) - Number(b.rate);
  });
  services = sorted;

  const prefer =
    Number(preferredId) || Number(settings?.serviceId) || services[0].service;
  sel.innerHTML = services
    .map((s) => {
      const drip = (s.min || 1) <= 5 ? "✓ drip" : "min " + s.min;
      const label = `#${s.service} · $${s.rate}/1k · ${drip} · ${String(s.name).slice(0, 56)}`;
      return `<option value="${s.service}">${escapeHtml(label)}</option>`;
    })
    .join("");
  const has = services.some((s) => s.service === prefer);
  sel.value = String(has ? prefer : services[0].service);
  selectedSvc = services.find((s) => s.service === Number(sel.value)) || services[0];
  renderFlowGrid();
  renderCostBoard();
  renderPlan();
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
  settings = await api("/api/linkedin/settings");
  setLiveUi(settings.liveMode);
  if (settings.profileUrl) {
    $("#profileInput").value = settings.profileUrl;
    $("#ctrlProfile").textContent = profileLabel(settings.profileUrl);
  }
  $("#ctrlDefaultSvc").textContent = String(settings.defaultServiceId || "—");

  if (settings.service) {
    selectedSvc = settings.service;
    const sel = $("#serviceSelect");
    if (sel && (!services.length || sel.options.length <= 1)) {
      const drip =
        (settings.service.min || 1) <= 5
          ? "✓ drip"
          : "min " + settings.service.min;
      sel.innerHTML = `<option value="${settings.service.service}">#${settings.service.service} · $${settings.service.rate}/1k · ${drip} · ${escapeHtml(String(settings.service.name || "Selected").slice(0, 56))}</option>`;
      services = [settings.service];
    }
  }
  renderFlowGrid();
  renderCostBoard();
  return settings;
}

async function loadServices() {
  const sel = $("#serviceSelect");
  try {
    if (sel && !services.length) {
      sel.innerHTML = `<option value="">Loading services…</option>`;
    }
    const data = await api("/api/linkedin/services");
    renderServices(data.items, settings?.serviceId || data.defaultServiceId);
    if (data.partial) {
      setTimeout(() => {
        api("/api/linkedin/services")
          .then((full) => {
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
  }
}

function nextDropLabel(drip) {
  const next = (drip.drops || []).find((d) => d.status === "pending");
  if (!next) return "—";
  return `${fmtTime(next.at)} · +${next.qty}`;
}

async function loadDrips() {
  const data = await api("/api/linkedin/drips");
  const body = $("#dripsBody");
  const items = data.items || [];
  const sum = data.summary || {};

  $("#sCampaigns").textContent = String(sum.campaigns ?? items.length);
  $("#sOrdered").textContent = String(sum.ordered ?? 0);
  $("#sPending").textContent = String(sum.pendingDrops ?? 0);
  $("#sActive").textContent = String(sum.active ?? 0);

  if (!items.length) {
    body.innerHTML = `<tr><td colspan="6" class="muted-sm">No drips yet — pick a flow and start one</td></tr>`;
    $("#dripsFooter").textContent = "No LinkedIn drips yet";
    return;
  }

  body.innerHTML = items
    .map((d) => {
      const ordered = Number(d.totalOrdered) || 0;
      const planned = Number(d.totalPlanned) || 0;
      const pct =
        planned > 0 ? Math.min(100, Math.round((ordered / planned) * 100)) : 0;
      const done = planned > 0 && ordered >= planned;
      const actions = [];
      if (d.status === "active") {
        actions.push(
          `<button type="button" class="btn ghost sm" data-act="pause" data-id="${escapeHtml(d.id)}">Pause</button>`
        );
        actions.push(
          `<button type="button" class="btn ghost sm" data-act="cancel" data-id="${escapeHtml(d.id)}">Cancel</button>`
        );
      } else if (d.status === "paused") {
        actions.push(
          `<button type="button" class="btn ghost sm" data-act="resume" data-id="${escapeHtml(d.id)}">Resume</button>`
        );
        actions.push(
          `<button type="button" class="btn ghost sm" data-act="cancel" data-id="${escapeHtml(d.id)}">Cancel</button>`
        );
      }
      const next =
        d.status === "active" || d.status === "paused"
          ? nextDropLabel(d)
          : d.status;
      return `<tr>
        <td>${escapeHtml(fmtTime(d.createdAt || d.startAt))}</td>
        <td><span class="muted-sm">${escapeHtml(d.flowName || "Flow · " + planned)}</span></td>
        <td><span class="pill ${d.status === "active" ? "live" : ""}" style="padding:0.2rem 0.45rem;font-size:0.65rem">${escapeHtml(d.status || "—")}</span></td>
        <td>
          <div class="ig-progress" title="${pct}%">
            <div class="ig-progress-top">
              <span>${ordered} / ${planned}</span>
              <span class="ig-progress-pct">${pct}%</span>
            </div>
            <div class="ig-progress-track${d.status === "active" && !done ? " ig-progress-live li-progress-live" : ""}" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
              <i style="width:${pct}%"></i>
            </div>
          </div>
        </td>
        <td><a href="${escapeHtml(d.link || "#")}" target="_blank" rel="noopener">${escapeHtml(profileLabel(d.link))}</a></td>
        <td>
          <div class="muted-sm" style="margin-bottom:0.35rem">${escapeHtml(next)}</div>
          <div class="btn-row">${actions.join(" ")}</div>
        </td>
      </tr>`;
    })
    .join("");
  $("#dripsFooter").textContent = `${items.length} drip${items.length === 1 ? "" : "s"}`;
}

async function loadOrders() {
  const q = new URLSearchParams();
  const mode = $("#orderModeFilter")?.value;
  const status = $("#orderStatusFilter")?.value;
  const search = $("#orderSearch")?.value?.trim();
  if (mode) q.set("mode", mode);
  if (status) q.set("status", status);
  if (search) q.set("q", search);
  const data = await api("/api/linkedin/orders?" + q.toString());
  const body = $("#ordersBody");
  const items = data.items || [];

  if (!items.length) {
    body.innerHTML = `<tr><td colspan="7" class="muted-sm">No batch orders yet</td></tr>`;
    $("#ordersFooter").textContent = "No LinkedIn batch orders yet";
    return;
  }

  body.innerHTML = items
    .map((o) => {
      const modeCls = o.mode === "live" ? "live" : "";
      return `<tr>
        <td>${escapeHtml(fmtTime(o.at))}</td>
        <td><span class="pill ${modeCls}" style="padding:0.2rem 0.45rem;font-size:0.65rem">${escapeHtml(o.mode || "—")}</span></td>
        <td>${escapeHtml(o.status || "—")}</td>
        <td>+${escapeHtml(String(o.quantity || 0))}</td>
        <td class="muted-sm">${escapeHtml(o.label || o.phaseId || "—")}</td>
        <td class="mono">${escapeHtml(o.japOrderId || "—")}</td>
        <td><a href="${escapeHtml(o.link || "#")}" target="_blank" rel="noopener">${escapeHtml(profileLabel(o.link))}</a></td>
      </tr>`;
    })
    .join("");
  $("#ordersFooter").textContent = `${items.length} batch${items.length === 1 ? "" : "es"}`;
}

async function refreshAll() {
  try {
    await loadSettings();
  } catch (err) {
    showMsg($("#formMsg"), err.message, "err");
  }
  await Promise.all([
    loadBalance().catch(() => {}),
    loadPlan().catch(() => {}),
    loadServices(),
    loadDrips().catch((err) => showMsg($("#formMsg"), err.message, "err")),
    loadOrders().catch(() => {}),
  ]);
}

$("#flowGrid")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-flow]");
  if (!btn) return;
  selectFlow(btn.dataset.flow);
});

$("#costBoard")?.addEventListener("click", (e) => {
  const row = e.target.closest("tr[data-flow]");
  if (!row) return;
  selectFlow(row.dataset.flow);
});

$("#serviceSelect")?.addEventListener("change", () => {
  selectedSvc =
    services.find((s) => s.service === Number($("#serviceSelect").value)) ||
    null;
  renderFlowGrid();
  renderCostBoard();
  renderPlan();
});

let qtyTimer = null;
$("#qtyInput")?.addEventListener("input", () => {
  clearTimeout(qtyTimer);
  qtyTimer = setTimeout(() => {
    const n = Number($("#qtyInput").value);
    if (Number.isFinite(n) && n >= 5) selectedFlow = n;
    renderFlowGrid();
    renderCostBoard();
    loadPlan().catch(() => {});
  }, 200);
});

$("#orderForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const btn = $("#orderBtn");
  btn.disabled = true;
  showMsg($("#formMsg"), "Starting LinkedIn drip…");
  try {
    let serviceId = Number(fd.get("serviceId"));
    if (!Number.isFinite(serviceId) || serviceId <= 0) {
      serviceId =
        selectedSvc?.service ||
        settings?.serviceId ||
        settings?.defaultServiceId;
    }
    if (!Number.isFinite(Number(serviceId)) || Number(serviceId) <= 0) {
      throw new Error("Pick a drip-friendly service first");
    }
    const quantity = Number(fd.get("quantity")) || selectedFlow || 100;
    const result = await api("/api/linkedin/order", {
      method: "POST",
      timeoutMs: 60000,
      body: JSON.stringify({
        link: fd.get("link"),
        serviceId: Number(serviceId),
        quantity,
        flowId: quantity,
        note: fd.get("note") || undefined,
      }),
    });
    const drip = result.drip;
    showMsg(
      $("#formMsg"),
      `${result.live ? "LIVE" : "DRY-RUN"} ${drip.flowName || "drip"} started · +${drip.totalPlanned} in ${drip.drops?.length || 0} batches → ${profileLabel(drip.link)}`,
      "ok"
    );
    await loadDrips();
    await loadOrders();
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

$("#saveProfileBtn")?.addEventListener("click", async () => {
  try {
    const profileUrl = $("#profileInput").value;
    const serviceId = Number($("#serviceSelect").value) || undefined;
    await api("/api/linkedin/settings", {
      method: "POST",
      body: JSON.stringify({ profileUrl, serviceId }),
    });
    await loadSettings();
    showMsg($("#ctrlMsg"), "Profile & service saved", "ok");
  } catch (err) {
    showMsg($("#ctrlMsg"), err.message, "err");
  }
});

$("#refreshBtn")?.addEventListener("click", () => refreshAll().catch(() => {}));
$("#dripsRefreshBtn")?.addEventListener("click", () =>
  Promise.all([loadDrips(), loadOrders()]).catch((err) =>
    showMsg($("#formMsg"), err.message, "err")
  )
);

$("#dripsBody")?.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  try {
    await api(`/api/linkedin/drips/${id}/${act}`, {
      method: "POST",
      body: "{}",
    });
    await loadDrips();
  } catch (err) {
    showMsg($("#formMsg"), err.message, "err");
  }
});

$("#ordersRefreshBtn")?.addEventListener("click", async () => {
  try {
    await api("/api/linkedin/orders/refresh-status", {
      method: "POST",
      body: JSON.stringify({ limit: 20 }),
    });
    await loadOrders();
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

renderFlowGrid();
renderCostBoard();

refreshAll().catch((err) => {
  showMsg($("#formMsg"), err.message, "err");
});

setInterval(() => {
  loadDrips().catch(() => {});
  loadOrders().catch(() => {});
}, 15000);
