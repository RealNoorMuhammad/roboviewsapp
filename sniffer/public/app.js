const $ = (s) => document.querySelector(s);

const FLOW_STORE_KEY = "roboSniffer.channelFlows.v1";
const SELECTED_STORE_KEY = "roboSniffer.selectedChannels.v1";
const FLOW_LABELS = {
  1: "Flow 1 · 396",
  2: "Flow 2 · 300",
  3: "Flow 3 · 746",
  4: "Flow 4 · 536",
  5: "Flow 5 · 456",
};

let lastFlows = [
  { id: "5", name: FLOW_LABELS[5], totalViews: 456 },
  { id: "4", name: FLOW_LABELS[4], totalViews: 536 },
  { id: "3", name: FLOW_LABELS[3], totalViews: 746 },
  { id: "1", name: FLOW_LABELS[1], totalViews: 396 },
  { id: "2", name: FLOW_LABELS[2], totalViews: 300 },
];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function readFlowStore() {
  try {
    const raw = localStorage.getItem(FLOW_STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeFlowStore(map) {
  localStorage.setItem(FLOW_STORE_KEY, JSON.stringify(map));
}

function storedFlow(username) {
  const id = readFlowStore()[String(username || "").toLowerCase()];
  return id ? String(id) : null;
}

function readSelected() {
  try {
    const raw = JSON.parse(localStorage.getItem(SELECTED_STORE_KEY) || "[]");
    return Array.isArray(raw) ? raw.map((s) => String(s).toLowerCase()) : [];
  } catch {
    return [];
  }
}

function writeSelected(list) {
  localStorage.setItem(SELECTED_STORE_KEY, JSON.stringify([...new Set(list)]));
}

function isSelected(username) {
  return readSelected().includes(
    String(username || "")
      .replace(/^@/, "")
      .toLowerCase()
  );
}

function setSelected(username, on) {
  const key = String(username || "")
    .replace(/^@/, "")
    .toLowerCase();
  if (!key) return;
  const next = readSelected().filter((u) => u !== key);
  if (on) next.push(key);
  writeSelected(next);
}

function saveFlowLocal(username, flowId) {
  const key = String(username || "")
    .replace(/^@/, "")
    .toLowerCase();
  if (!key) return;
  const map = readFlowStore();
  map[key] = String(flowId);
  writeFlowStore(map);
}

function flowName(id) {
  const hit = (lastFlows || []).find((f) => String(f.id) === String(id));
  return hit?.name || FLOW_LABELS[id] || `Flow ${id}`;
}

function fmtMs(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  if (v < 1) return `${Math.round(v * 1000)}µs`;
  return `${v.toFixed(v < 20 ? 1 : 0)}ms`;
}

function flowOptions(selected, flows) {
  const list = flows && flows.length ? flows : lastFlows;
  const sel = String(selected || "4");
  return list
    .map((f) => {
      const id = String(f.id);
      const label = f.totalViews
        ? `${f.name} · ${f.totalViews} / 24h`
        : f.name;
      return `<option value="${id}" ${id === sel ? "selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fillAddFlowSelect(flows, keepValue) {
  const sel = $("#flowSelect");
  if (!sel) return;
  const current = keepValue || sel.value || "4";
  sel.innerHTML = flowOptions(current, flows);
}

function withStoredFlows(channels) {
  return (channels || []).map((c) => {
    const flowId = storedFlow(c.username) || c.flowId || "4";
    return {
      ...c,
      flowId,
      flowName: flowName(flowId),
    };
  });
}

function render(snap) {
  if (Array.isArray(snap.flows) && snap.flows.length) lastFlows = snap.flows;
  $("#autoPill").textContent = snap.auto ? "AUTO 24/7" : "AUTO OFF";
  $("#autoPill").classList.toggle("on", !!snap.auto);
  $("#sProbes").textContent = snap.stats?.probes ?? 0;
  $("#sHits").textContent = snap.stats?.confirms ?? 0;
  $("#sFwd").textContent = snap.stats?.forwarded ?? 0;
  $("#sHot").textContent = `${snap.hotMs}ms`;
  if (snap.note) $("#truth").textContent = snap.note;

  const last = (snap.hits || [])[0];
  $("#lastMs").textContent = last ? fmtMs(last.latencyMs) : "—";

  const ae = document.activeElement;
  const editingFlow = ae && ae.getAttribute && ae.getAttribute("data-flow");
  if (!editingFlow && ae !== $("#flowSelect")) {
    fillAddFlowSelect(lastFlows, $("#flowSelect")?.value);
  }

  const box = $("#channels");
  const list = withStoredFlows(snap.channels || []);
  if (!readSelected().length && list.some((c) => c.auto)) {
    writeSelected(list.filter((c) => c.auto).map((c) => c.username));
  }
  if (!editingFlow) {
    if (!list.length) {
      box.innerHTML = `<p class="hint">No channels yet. Add one, pick a flow, leave AUTO on — it runs 24/7.</p>`;
    } else {
      box.innerHTML = list
        .map((c) => {
          const hot = c.hot;
          const picked = isSelected(c.username);
          return `<div class="ch ${hot ? "hot" : ""} ${picked ? "selected" : ""}" data-pick="${escapeHtml(c.username)}">
          <div>
            <div class="name">@${escapeHtml(c.username)}${picked ? `<span class="pick">SELECTED</span>` : ""}</div>
            <div class="meta">${escapeHtml(c.flowName)} · 24/7 · id ${c.lastId || "seeding"} · ${escapeHtml(c.status || "—")} · hits ${c.hits || 0}${
              c.lastLatencyMs != null ? ` · last ${fmtMs(c.lastLatencyMs)}` : ""
            }</div>
          </div>
          <select data-flow="${escapeHtml(c.username)}">${flowOptions(c.flowId, lastFlows)}</select>
          ${
            picked
              ? `<button class="tiny danger" type="button" data-unselect="${escapeHtml(c.username)}">REMOVE</button>`
              : `<button class="tiny on" type="button" data-select="${escapeHtml(c.username)}">SELECT</button>`
          }
          <button class="tiny sec" type="button" data-hot="${escapeHtml(c.username)}">BEAST</button>
          <button class="tiny danger" type="button" data-del="${escapeHtml(c.username)}">DELETE</button>
        </div>`;
        })
        .join("");
    }
  }

  const feed = $("#feed");
  const hits = snap.hits || [];
  if (!hits.length) {
    feed.innerHTML = `<p class="hint">Waiting for the next post…</p>`;
  } else {
    feed.innerHTML = hits
      .slice(0, 40)
      .map((h) => {
        const fid = storedFlow(h.username) || h.flowId;
        return `<div class="hit">
          <span class="ms">${fmtMs(h.latencyMs)}</span>
          <a href="${h.link}" target="_blank" rel="noopener">${escapeHtml(
            String(h.link || "").replace(/^https?:\/\//, "")
          )}</a>
          <span class="src">${escapeHtml(flowName(fid))} ${h.hot ? "HOT" : ""}</span>
        </div>`;
      })
      .join("");
  }
}

async function saveFlowRemote(username, flowId) {
  const body = JSON.stringify({ username, flowId });
  const attempts = [
    { path: "/api/set-flow", method: "POST", body },
    {
      path: `/api/channels/${encodeURIComponent(username)}/flow`,
      method: "POST",
      body: JSON.stringify({ flowId }),
    },
  ];
  for (const req of attempts) {
    try {
      await api(req.path, { method: req.method, body: req.body });
      return true;
    } catch {
      /* try next — localStorage already saved */
    }
  }
  return false;
}

async function refresh() {
  const snap = await api("/api/status");
  render(snap);
}

$("#addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#formMsg");
  msg.hidden = true;
  try {
    const flowId = $("#flowSelect").value;
    const username = $("#chInput").value;
    saveFlowLocal(username, flowId);
    setSelected(username, true);
    await api("/api/channels", {
      method: "POST",
      body: JSON.stringify({
        username,
        auto: $("#autoChk").checked,
        flowId,
      }),
    });
    $("#chInput").value = "";
    msg.hidden = false;
    msg.className = "msg";
    msg.textContent = $("#autoChk").checked
      ? `Armed 24/7 on Flow ${flowId}. Saved in this browser.`
      : `Channel added (auto off) · Flow ${flowId}.`;
    await refresh();
  } catch (err) {
    msg.hidden = false;
    msg.className = "msg err";
    msg.textContent = err.message;
  }
});

$("#channels").addEventListener("click", async (e) => {
  if (e.target.closest("select") || e.target.closest("a")) return;
  const btn = e.target.closest("button");
  const pick = btn?.getAttribute("data-select");
  const unselect = btn?.getAttribute("data-unselect");
  const hot = btn?.getAttribute("data-hot");
  const del = btn?.getAttribute("data-del");
  try {
    if (pick) {
      setSelected(pick, true);
      await refresh();
      return;
    }
    if (unselect) {
      setSelected(unselect, false);
      await refresh();
      return;
    }
    if (hot) {
      await api(`/api/channels/${encodeURIComponent(hot)}/hot`, { method: "POST" });
      await refresh();
      return;
    }
    if (del) {
      setSelected(del, false);
      await api(`/api/channels/${encodeURIComponent(del)}`, { method: "DELETE" });
      await refresh();
      return;
    }
  } catch (err) {
    const msg = $("#formMsg");
    msg.hidden = false;
    msg.className = "msg err";
    msg.textContent = err.message;
  }
});

$("#channels").addEventListener("change", async (e) => {
  const u = e.target.getAttribute("data-flow");
  if (!u) return;
  const flowId = e.target.value;
  saveFlowLocal(u, flowId);
  setSelected(u, true);
  const msg = $("#formMsg");
  msg.hidden = false;
  msg.className = "msg";
  msg.textContent = `@${u} → ${flowName(flowId)} · saved in this browser`;
  await saveFlowRemote(u, flowId);
  await refresh();
});

$("#globalAutoOn").addEventListener("click", async () => {
  await api("/api/auto", { method: "POST", body: JSON.stringify({ auto: true }) });
  await refresh();
});
$("#globalAutoOff").addEventListener("click", async () => {
  await api("/api/auto", { method: "POST", body: JSON.stringify({ auto: false }) });
  await refresh();
});

function connectLive() {
  const es = new EventSource("/api/live");
  const pill = $("#livePill");
  es.addEventListener("open", () => {
    pill.textContent = "SSE LIVE";
    pill.classList.remove("dim");
    pill.classList.add("on");
  });
  ["hit", "hot", "armed", "channel", "auto", "tick", "error", "forward"].forEach((type) => {
    es.addEventListener(type, () => {
      refresh().catch(() => {});
    });
  });
  es.onerror = () => {
    pill.textContent = "SSE RETRY";
    pill.classList.add("dim");
  };
}

refresh().catch((e) => {
  $("#formMsg").hidden = false;
  $("#formMsg").className = "msg err";
  $("#formMsg").textContent = e.message;
});
connectLive();
setInterval(() => refresh().catch(() => {}), 1500);
