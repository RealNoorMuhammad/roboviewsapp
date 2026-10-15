/**
 * Tiny realtime bus for dashboard (Server-Sent Events).
 * Push post hits / orders so the website updates without polling wait.
 */

const clients = new Set();
const recent = [];
const MAX_RECENT = 80;

function attach(req, res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const client = { res, id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}` };
  clients.add(client);

  // Hello + last few hits so a late tab still sees recent activity
  write(client, "hello", {
    at: new Date().toISOString(),
    clients: clients.size,
    message: "live stream connected",
  });
  for (const hit of recent.slice(-15)) {
    write(client, hit.type || "hit", hit);
  }

  // Keepalive every 15s
  const ping = setInterval(() => {
    try {
      res.write(`:ping ${Date.now()}\n\n`);
    } catch {
      cleanup(client, ping);
    }
  }, 15_000);

  req.on("close", () => cleanup(client, ping));
}

function cleanup(client, ping) {
  clearInterval(ping);
  clients.delete(client);
  try {
    client.res.end();
  } catch (_) {}
}

function write(client, type, data) {
  try {
    client.res.write(`event: ${type}\n`);
    client.res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    clients.delete(client);
  }
}

/**
 * Broadcast to every open dashboard tab.
 * @param {string} type  e.g. post_hit | order | status | sync
 * @param {object} payload
 */
function broadcast(type, payload = {}) {
  const event = {
    type,
    at: new Date().toISOString(),
    ...payload,
  };
  if (type === "post_hit" || type === "order") {
    recent.push(event);
    if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);
  }
  for (const client of [...clients]) {
    write(client, type, event);
  }
  return event;
}

function clientCount() {
  return clients.size;
}

module.exports = { attach, broadcast, clientCount };
