/* Instagram organic follower drip page */

const $ = (sel) => document.querySelector(sel);

let settings = null;
let services = [];
let selectedSvc = null;
let plan = null;

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
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, "@")
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

function renderPlan() {
  const body = $("#planBody");
  const totalLabel = $("#planTotalLabel");
  const footer = $("#planFooter");
  if (!body) return;

  if (!plan?.steps?.length) {
    body.innerHTML = `<tr><td colspan="3" class="muted-sm">Loading plan…</td></tr>`;
    return;
  }

  if (totalLabel) totalLabel.textContent = `→ ${plan.total}`;

  let totalCost = 0;
  body.innerHTML = plan.steps
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
        <td><strong>+${s.qty}</strong></td>
        <td>${fmtMoney(cost)}</td>
      </tr>`;
    })
    .join("");

  if (footer) {
    const rateOk = selectedSvc && Number.isFinite(Number(selectedSvc.rate));
    footer.textContent = rateOk
      ? `Total ~${fmtMoney(totalCost)} · ${plan.steps.length} batches over ~${plan.durationLabel}`
      : `${plan.steps.length} batches over ~${plan.durationLabel} · pick a drip-friendly service (min ≤ 5)`;
  }

  $("#ctrlCost").textContent =
    selectedSvc && plan
      ? `~${fmtMoney(estCost(selectedSvc, plan.total))}`
      : "—";

  if (selectedSvc) {
    const min = selectedSvc.min || 1;
    const max = selectedSvc.max || "∞";
    const dripOk = plan.steps.every((s) => s.qty >= min && s.qty <= (Number(max) || Infinity));
    $("#svcMeta").textContent =
      `min ${min} · max ${max} · $${selectedSvc.rate}/1k` +
      (dripOk ? " · drip OK" : " · ⚠️ min too high for +5 batches");
    $("#svcPill").textContent = `svc ${selectedSvc.service}`;
  }
}

async function loadPlan() {
  const qty = Number($("#qtyInput")?.value) || 100;
  plan = await api(`/api/instagram/plan?total=${qty}`);
  renderPlan();
}

function renderServices(items, preferredId) {
  const sel = $("#serviceSelect");
  services = items || [];
  if (!services.length) {
    sel.innerHTML = `<option value="">No Instagram follower services found</option>`;
    selectedSvc = null;
    renderPlan();
    return;
  }

  // Prefer drip-friendly (min ≤ 5) at the top
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
  settings = await api("/api/instagram/settings");
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
      const drip = (settings.service.min || 1) <= 5 ? "✓ drip" : "min " + settings.service.min;
      sel.innerHTML = `<option value="${settings.service.service}">#${settings.service.service} · $${settings.service.rate}/1k · ${drip} · ${escapeHtml(String(settings.service.name || "Selected").slice(0, 56))}</option>`;
      services = [settings.service];
    }
  }
  return settings;
}

async function loadServices() {
  const sel = $("#serviceSelect");
  try {
    if (sel && !services.length) {
      sel.innerHTML = `<option value="">Loading services…</option>`;
    }
    const data = await api("/api/instagram/services");
    renderServices(data.items, settings?.serviceId || data.defaultServiceId);
    if (data.partial) {
      setTimeout(() => {
        api("/api/instagram/services")
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
  const data = await api("/api/instagram/drips");
  const body = $("#dripsBody");
  const items = data.items || [];
  const sum = data.summary || {};

  $("#sCampaigns").textContent = String(sum.campaigns ?? items.length);
  $("#sOrdered").textContent = String(sum.ordered ?? 0);
  $("#sPending").textContent = String(sum.pendingDrops ?? 0);
  $("#sActive").textContent = String(sum.active ?? 0);

  if (!items.length) {
    body.innerHTML = `<tr><td colspan="5" class="muted-sm">No drips yet — start one on the left</td></tr>`;
    $("#dripsFooter").textContent = "No organic drips yet";
    return;
  }

  body.innerHTML = items
    .map((d) => {
      const ordered = Number(d.totalOrdered) || 0;
      const planned = Number(d.totalPlanned) || 0;
      const pct = planned > 0 ? Math.min(100, Math.round((ordered / planned) * 100)) : 0;
      const done = planned > 0 && ordered >= planned;
      const actions = [];
      if (d.status === "active") {
        actions.push(`<button type="button" class="btn ghost sm" data-act="pause" data-id="${escapeHtml(d.id)}">Pause</button>`);
        actions.push(`<button type="button" class="btn ghost sm" data-act="cancel" data-id="${escapeHtml(d.id)}">Cancel</button>`);
      } else if (d.status === "paused") {
        actions.push(`<button type="button" class="btn ghost sm" data-act="resume" data-id="${escapeHtml(d.id)}">Resume</button>`);
        actions.push(`<button type="button" class="btn ghost sm" data-act="cancel" data-id="${escapeHtml(d.id)}">Cancel</button>`);
      }
      const next =
        d.status === "active" || d.status === "paused"
          ? nextDropLabel(d)
          : d.status;
      return `<tr>
        <td>${escapeHtml(fmtTime(d.createdAt || d.startAt))}</td>
        <td><span class="pill ${d.status === "active" ? "live" : ""}" style="padding:0.2rem 0.45rem;font-size:0.65rem">${escapeHtml(d.status || "—")}</span></td>
        <td>
          <div class="ig-progress" title="${pct}%">
            <div class="ig-progress-top">
              <span>${ordered} / ${planned}</span>
              <span class="ig-progress-pct">${pct}%</span>
            </div>
            <div class="ig-progress-track${d.status === "active" && !done ? " ig-progress-live" : ""}" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
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
  const data = await api("/api/instagram/orders?" + q.toString());
  const body = $("#ordersBody");
  const items = data.items || [];

  if (!items.length) {
    body.innerHTML = `<tr><td colspan="7" class="muted-sm">No batch orders yet</td></tr>`;
    $("#ordersFooter").textContent = "No Instagram batch orders yet";
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

$("#serviceSelect")?.addEventListener("change", () => {
  selectedSvc =
    services.find((s) => s.service === Number($("#serviceSelect").value)) || null;
  renderPlan();
});

let qtyTimer = null;
$("#qtyInput")?.addEventListener("input", () => {
  clearTimeout(qtyTimer);
  qtyTimer = setTimeout(() => loadPlan().catch(() => {}), 200);
});

$("#orderForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const btn = $("#orderBtn");
  btn.disabled = true;
  showMsg($("#formMsg"), "Starting organic drip…");
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
    const result = await api("/api/instagram/order", {
      method: "POST",
      timeoutMs: 60000,
      body: JSON.stringify({
        link: fd.get("link"),
        serviceId: Number(serviceId),
        quantity: Number(fd.get("quantity")) || 100,
        note: fd.get("note") || undefined,
      }),
    });
    const drip = result.drip;
    showMsg(
      $("#formMsg"),
      `${result.live ? "LIVE" : "DRY-RUN"} organic drip started · +${drip.totalPlanned} in ${drip.drops?.length || 0} batches → ${profileLabel(drip.link)}`,
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
    await api("/api/instagram/settings", {
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
    await api(`/api/instagram/drips/${id}/${act}`, {
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
    await api("/api/instagram/orders/refresh-status", {
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

refreshAll().catch((err) => {
  showMsg($("#formMsg"), err.message, "err");
});

// Keep drip progress fresh while page is open
setInterval(() => {
  loadDrips().catch(() => {});
  loadOrders().catch(() => {});
}, 15000);
