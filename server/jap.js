/**
 * JustAnotherPanel API client (api/v2, form POST).
 */

const SERVICES_TTL_MS = Math.max(
  60_000,
  Number(process.env.JAP_SERVICES_CACHE_MS || 10 * 60 * 1000)
);

let servicesCache = { at: 0, list: null, inflight: null };

async function japRequest(action, params = {}) {
  const key = process.env.JAP_API_KEY;
  const url = process.env.JAP_API_URL || "https://justanotherpanel.com/api/v2";
  if (!key) throw new Error("JAP_API_KEY missing");

  const body = new URLSearchParams({ key, action, ...params });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`JAP non-JSON response: ${text.slice(0, 200)}`);
  }
  if (data && data.error) {
    const err = new Error(String(data.error));
    err.jap = data;
    throw err;
  }
  return data;
}

async function getBalance() {
  return japRequest("balance");
}

/** Cached services list — full catalog is large/slow. */
async function getServices({ force = false } = {}) {
  const fresh =
    !force &&
    servicesCache.list &&
    Date.now() - servicesCache.at < SERVICES_TTL_MS;
  if (fresh) return servicesCache.list;

  if (!force && servicesCache.inflight) return servicesCache.inflight;

  servicesCache.inflight = japRequest("services")
    .then((list) => {
      servicesCache.list = Array.isArray(list) ? list : [];
      servicesCache.at = Date.now();
      servicesCache.inflight = null;
      return servicesCache.list;
    })
    .catch((err) => {
      servicesCache.inflight = null;
      if (servicesCache.list) return servicesCache.list;
      throw err;
    });

  return servicesCache.inflight;
}

/** Sync peek — returns cached list or null (never waits on network). */
function peekServices() {
  return servicesCache.list;
}

async function getService(serviceId) {
  const list = await getServices();
  return list.find((s) => Number(s.service) === Number(serviceId)) || null;
}

/**
 * Place order — ONLY when allowLiveSpend is true.
 * Extra hard-guard against surprise balance drain.
 */
async function addOrder({
  service,
  link,
  quantity,
  comments,
  allowLiveSpend = false,
}) {
  if (!allowLiveSpend) {
    const err = new Error("JAP add blocked: live spend not confirmed");
    err.code = "LIVE_BLOCKED";
    throw err;
  }
  // Double env gate even if caller misbehaves
  if (String(process.env.LIVE_MODE || "false").toLowerCase() !== "true") {
    const err = new Error("JAP add blocked: LIVE_MODE is not true in .env");
    err.code = "LIVE_BLOCKED";
    throw err;
  }
  return japRequest("add", {
    service: String(service),
    link,
    quantity: String(quantity),
    ...(comments ? { comments: String(comments) } : {}),
  });
}

async function getOrderStatus(orderId) {
  return japRequest("status", { order: String(orderId) });
}

module.exports = {
  japRequest,
  getBalance,
  getServices,
  peekServices,
  getService,
  addOrder,
  getOrderStatus,
};
