const $ = (s) => document.querySelector(s);

const CHANNELS = {
  bansyndicate: {
    handle: "bansyndicate",
    flowId: "4",
    label: "Ban’s Syndicate",
    url: "https://t.me/bansyndicate",
    locked: true,
  },
  robogems: {
    handle: "robogems",
    flowId: "6",
    label: "Robo Calls",
    url: "https://t.me/robogems",
    locked: true,
  },
  other: {
    handle: "",
    flowId: "1",
    label: "Other channel",
    url: "",
    locked: false,
  },
};

function cfg() {
  const c = window.ROBO_MOBILE || {};
  return {
    url: String(c.supabaseUrl || "").replace(/\/$/, ""),
    key: String(c.anonKey || ""),
  };
}

function headers() {
  const { key } = cfg();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

function selectedChannel() {
  const key = $("#channelInput")?.value || "bansyndicate";
  return CHANNELS[key] || CHANNELS.bansyndicate;
}

function setChannel(key) {
  const ch = CHANNELS[key];
  if (!ch) return;
  $("#channelInput").value = key;
  $("#flowInput").value = ch.flowId;
  document.querySelectorAll(".ch-btn").forEach((btn) => {
    btn.classList.toggle("is-on", btn.dataset.channel === key);
  });
  const flowWrap = $("#flowPickWrap");
  const flowSelect = $("#flowSelect");
  if (flowWrap && flowSelect) {
    const show = key === "other";
    flowWrap.hidden = !show;
    if (show) flowSelect.value = ch.flowId || "1";
    else $("#flowInput").value = ch.flowId;
  }
  const ta = $("#linksInput");
  if (ta) {
    ta.placeholder =
      key === "other"
        ? "https://t.me/anychannel/123\n(full post link required)"
        : `https://t.me/${ch.handle}/123\nor just 123`;
  }
}

function parseLinks(raw, channel) {
  return String(raw || "")
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((rawLink) => expandLink(rawLink, channel));
}

function expandLink(raw, channel) {
  let u = String(raw || "").trim();
  if (!u) return u;
  if (/^\d+$/.test(u)) {
    if (!channel.handle) return u;
    return `https://t.me/${channel.handle}/${u}`;
  }
  if (/^@?[a-zA-Z0-9_]+\/\d+$/.test(u)) {
    const cleaned = u.replace(/^@/, "");
    return `https://t.me/${cleaned}`;
  }
  if (u.startsWith("t.me/")) u = "https://" + u;
  u = u.replace(/^https?:\/\/(www\.)?telegram\.me\//i, "https://t.me/");
  u = u.replace(/^(https:\/\/t\.me)\/s\//i, "$1/");
  return u.split("?")[0].split("#")[0].replace(/\/$/, "");
}

function looksLikePost(link) {
  return /t\.me\/[^/\s]+\/\d+/i.test(String(link || ""));
}

function channelOk(link, channel) {
  if (!channel.handle) return looksLikePost(link);
  const m = String(link || "").match(/t\.me\/([^/?#]+)/i);
  if (!m) return false;
  return m[1].toLowerCase() === channel.handle.toLowerCase();
}

function channelLabelFromLink(link) {
  const m = String(link || "").match(/t\.me\/([^/?#]+)/i);
  return m ? m[1] : "channel";
}

async function sb(path, opts = {}) {
  const { url, key } = cfg();
  if (!url || !key) {
    throw new Error("Set supabaseUrl + anonKey in mobile/config.js (Vercel), or desktop .env for /m");
  }
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...opts,
    headers: { ...headers(), ...(opts.headers || {}) },
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const msg =
      (data && (data.message || data.details || data.hint)) ||
      (typeof data === "string" ? data.slice(0, 180) : res.statusText);
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return data;
}

function setMsg(text, err = false) {
  const el = $("#formMsg");
  el.hidden = !text;
  el.className = err ? "msg err" : "msg";
  el.textContent = text || "";
}

function fmtTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return String(iso);
  }
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sourceBadge(source) {
  const s = String(source || "mobile").toLowerCase();
  if (s === "auto" || s === "sniffer") {
    return { cls: "badge-auto", label: "AUTO" };
  }
  if (s === "mobile") return { cls: "badge-mobile", label: "PHONE" };
  return { cls: "badge-mobile", label: s.toUpperCase() };
}

async function loadQueue() {
  const list = $("#queueList");
  if (!list) return;
  try {
    const rows = await sb(
      "telegram_posts?select=id,link,title,status,source,error,created_at,imported_at&order=created_at.desc&limit=40"
    );
    if (!Array.isArray(rows) || !rows.length) {
      list.innerHTML = `<p class="empty">Nothing yet — paste a t.me post.</p>`;
      return;
    }
    list.innerHTML = rows
      .map((r) => {
        const st = r.status || "pending";
        const badge = sourceBadge(r.source);
        const err = r.error ? ` · ${escapeHtml(r.error)}` : "";
        return `<article class="q-item">
          <div class="top">
            <a href="${escapeHtml(r.link)}" target="_blank" rel="noopener">${escapeHtml(r.link)}</a>
            <span class="badge ${badge.cls}">${escapeHtml(badge.label)}</span>
          </div>
          <div class="meta">
            <span class="st-${escapeHtml(st)}">${escapeHtml(st)}${err}</span>
            <span>${fmtTime(r.imported_at || r.created_at)}</span>
          </div>
        </article>`;
      })
      .join("");
  } catch (e) {
    list.innerHTML = `<p class="empty">${escapeHtml(e.message)}</p>`;
  }
}

async function queueLinks(links, title, flowId) {
  const payload = links.map((link) => ({
    link,
    title: title || null,
    flow_id: flowId || null,
    source: "mobile",
    status: "pending",
  }));
  return sb("telegram_posts", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(payload),
  });
}

function bootWarn() {
  const { url, key } = cfg();
  const el = $("#cfgWarn");
  if (!url || !key) {
    el.hidden = false;
    el.textContent =
      "Add SUPABASE_URL + anon key to mobile/config.js before Vercel deploy (or desktop .env for local /m). Run supabase/telegram_posts.sql first.";
    return false;
  }
  el.hidden = true;
  return true;
}

document.querySelector(".channel-pick")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".ch-btn");
  if (!btn) return;
  setChannel(btn.dataset.channel);
});

$("#flowSelect")?.addEventListener("change", (e) => {
  $("#flowInput").value = e.target.value;
});

$("#queueForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!bootWarn()) {
    setMsg("Supabase keys missing on this deploy — config.js has no URL/key.", true);
    return;
  }
  const ch = selectedChannel();
  const fd = new FormData(e.target);
  const links = parseLinks(fd.get("links"), ch);
  const title = String(fd.get("title") || "").trim();
  let flowId = String(fd.get("flowId") || ch.flowId).trim();
  if ($("#channelInput").value === "other" && $("#flowSelect")) {
    flowId = String($("#flowSelect").value || flowId).trim();
    $("#flowInput").value = flowId;
  }

  if (!links.length) {
    setMsg("Paste a post link or message id", true);
    return;
  }
  const bad = links.filter((l) => !looksLikePost(l));
  if (bad.length) {
    setMsg(
      ch.handle
        ? "Need a post like https://t.me/" + ch.handle + "/123"
        : "Need a full post link like https://t.me/channel/123",
      true
    );
    return;
  }
  if (ch.handle) {
    const wrongCh = links.filter((l) => !channelOk(l, ch));
    if (wrongCh.length) {
      setMsg(`This picker is for @${ch.handle} — switch channel or fix the link`, true);
      return;
    }
  }

  const btn = $("#goBtn");
  btn.disabled = true;
  try {
    await queueLinks(links, title, flowId);
    const label =
      ch.handle ||
      (links.length === 1 ? channelLabelFromLink(links[0]) : "other");
    setMsg(
      links.length === 1
        ? `Queued @${label} — desktop starts views now.`
        : `Queued ${links.length} posts — desktop starts views.`
    );
    e.target.querySelector("textarea").value = "";
    await loadQueue();
  } catch (err) {
    const dup = /duplicate|unique|telegram_posts_link/i.test(err.message || "");
    setMsg(dup ? "That link is already in the queue." : err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$("#refreshBtn").addEventListener("click", () => loadQueue().catch(console.error));

setChannel("bansyndicate");
bootWarn();
if (cfg().url && cfg().key) loadQueue().catch(console.error);
setInterval(() => {
  if (cfg().url && cfg().key) loadQueue().catch(() => {});
}, 3500);
