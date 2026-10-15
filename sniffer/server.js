require("dotenv").config();
const path = require("path");
const express = require("express");
const engine = require("./engine");

const app = express();
const PORT = Number(process.env.SNIFFER_PORT || 3850);

app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

const sseClients = new Set();

app.get("/api/live", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  const client = { res };
  sseClients.add(client);
  res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  const ping = setInterval(() => {
    try {
      res.write(`:ping ${Date.now()}\n\n`);
    } catch {
      clearInterval(ping);
      sseClients.delete(client);
    }
  }, 12_000);
  req.on("close", () => {
    clearInterval(ping);
    sseClients.delete(client);
  });
});

engine.onEvent((event) => {
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const c of [...sseClients]) {
    try {
      c.res.write(payload);
    } catch {
      sseClients.delete(c);
    }
  }
});

app.get("/api/status", (_req, res) => {
  res.json({ ok: true, ...engine.getSnapshot(), liveClients: sseClients.size });
});

app.post("/api/channels", (req, res) => {
  try {
    const auto =
      req.body?.auto !== false &&
      String(req.body?.auto).toLowerCase() !== "false";
    const username = req.body?.username || req.body?.channel || "";
    const flowId = req.body?.flowId;
    const ch = engine.addChannel(username, { auto, flowId });
    res.json({ ok: true, channel: ch });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/channels/:username", (req, res) => {
  engine.removeChannel(req.params.username);
  res.json({ ok: true });
});

app.post("/api/channels/:username/hot", (req, res) => {
  const ch = engine.armHot(req.params.username);
  if (!ch) return res.status(404).json({ error: "Unknown channel" });
  res.json({ ok: true, channel: ch });
});

app.post("/api/channels/:username/auto", (req, res) => {
  try {
    const on = req.body?.auto !== false;
    res.json({ ok: true, channel: engine.setChannelAuto(req.params.username, on) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function applyFlow(req, res) {
  try {
    const username = req.params.username || req.body?.username || req.body?.channel;
    const flowId = req.body?.flowId ?? req.body?.flow;
    if (!username) return res.status(400).json({ error: "Channel required" });
    res.json({
      ok: true,
      channel: engine.setChannelFlow(username, flowId),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}

app.post("/api/set-flow", applyFlow);
app.post("/api/channels/:username/flow", applyFlow);
app.put("/api/channels/:username", applyFlow);

app.post("/api/auto", (req, res) => {
  res.json({ ok: true, ...engine.setAuto(req.body?.auto !== false) });
});

engine.startAll();

app.listen(PORT, "0.0.0.0", () => {
  const snap = engine.getSnapshot();
  console.log(`\n  Robo Sniffer (separate) → http://127.0.0.1:${PORT}`);
  console.log(`  HOT probe: ${snap.hotMs}ms · cruise: ${snap.cruiseMs}ms · ahead: ${snap.ahead} · concurrency: ${snap.concurrency}`);
  console.log(
    `  Forward to drip: ${snap.forwardUrl || "off (set SNIFFER_FORWARD_URL)"}`
  );
  console.log(
    `  Watching: ${
      snap.channels.map((c) => "@" + c.username).join(" + ") || "(none yet)"
    }\n`
  );
});
