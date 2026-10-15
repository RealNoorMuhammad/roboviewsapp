/**
 * One-off: generate Robo-Views-System-Analytic.pdf in project root.
 * Run: node scripts/generate-analytic-pdf.js
 */
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const out = path.join(__dirname, "..", "Robo-Views-System-Analytic.pdf");
const doc = new PDFDocument({
  margin: 50,
  size: "A4",
  info: {
    Title: "Robo Views Bot — Full System Analytic",
    Author: "Robo Views Bot",
    Subject: "System architecture and drip logic documentation",
  },
});
const stream = fs.createWriteStream(out);
doc.pipe(stream);

const W = doc.page.width - 100;

function ensureSpace(h) {
  if (doc.y + h > doc.page.height - 55) doc.addPage();
}

function h1(t) {
  ensureSpace(40);
  doc.moveDown(0.3);
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#0f172a").text(t, { width: W });
  doc.moveDown(0.25);
  doc
    .moveTo(doc.x, doc.y)
    .lineTo(doc.x + W, doc.y)
    .strokeColor("#94a3b8")
    .lineWidth(0.8)
    .stroke();
  doc.moveDown(0.45);
  doc.fillColor("#1e293b");
}

function h2(t) {
  ensureSpace(28);
  doc.moveDown(0.35);
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#0f172a").text(t, { width: W });
  doc.moveDown(0.2);
  doc.font("Helvetica").fontSize(10).fillColor("#334155");
}

function p(t) {
  ensureSpace(20);
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#334155")
    .text(t, { width: W, align: "left", lineGap: 2 });
  doc.moveDown(0.35);
}

function bullet(t) {
  ensureSpace(16);
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#334155")
    .text("•  " + t, { width: W, indent: 8, lineGap: 1 });
  doc.moveDown(0.15);
}

function codeBlock(lines) {
  ensureSpace(30);
  const startY = doc.y;
  const body = Array.isArray(lines) ? lines.join("\n") : String(lines);
  const h = doc.heightOfString(body, { width: W - 16, lineGap: 1 }) + 12;
  ensureSpace(h + 4);
  doc.rect(doc.x - 2, doc.y - 2, W + 4, h).fill("#f1f5f9");
  doc
    .fillColor("#0f172a")
    .font("Courier")
    .fontSize(8)
    .text(body, doc.x + 6, doc.y + 4, { width: W - 12, lineGap: 1 });
  doc.y = Math.max(doc.y, startY + h) + 6;
  doc.x = 50;
  doc.fillColor("#334155");
}

function table(headers, rows, colWeights) {
  const total = colWeights.reduce((a, b) => a + b, 0);
  const cols = colWeights.map((w) => (w / total) * W);
  const rowH = 16;
  ensureSpace(rowH * (rows.length + 2));

  let x = 50;
  doc.rect(50, doc.y, W, rowH).fill("#0f172a");
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8.5);
  headers.forEach((h, i) => {
    doc.text(h, x + 4, doc.y + 4, { width: cols[i] - 8, ellipsis: true });
    x += cols[i];
  });
  doc.y += rowH;

  rows.forEach((row, ri) => {
    ensureSpace(rowH + 2);
    x = 50;
    const bg = ri % 2 === 0 ? "#f8fafc" : "#ffffff";
    doc.rect(50, doc.y, W, rowH).fill(bg);
    doc.fillColor("#334155").font("Helvetica").fontSize(8.5);
    const rowY = doc.y;
    row.forEach((cell, i) => {
      doc.text(String(cell), x + 4, rowY + 4, { width: cols[i] - 8, ellipsis: true });
      x += cols[i];
    });
    doc.y = rowY + rowH;
  });
  doc.moveDown(0.5);
  doc.x = 50;
}

// ── Cover ──
doc.font("Helvetica-Bold").fontSize(26).fillColor("#0f172a").text("Robo Views Bot", { width: W });
doc.moveDown(0.3);
doc.font("Helvetica").fontSize(14).fillColor("#475569").text("Full System Analytic", { width: W });
doc.moveDown(0.5);
doc
  .fontSize(10)
  .fillColor("#64748b")
  .text("Organic-style Telegram post views drip via JustAnotherPanel", { width: W });
doc.moveDown(0.3);
doc.text("Generated: " + new Date().toLocaleString(), { width: W });
doc.moveDown(0.2);
doc.text("Local stack: Node.js · Express · JAP API · JSON store · Dashboard :3847", {
  width: W,
});
doc.moveDown(1);

h1("1. What is this system?");
p(
  "Robo Views Bot is a local Node.js drip engine that buys Telegram post views from JustAnotherPanel (JAP) on a timed schedule so growth looks organic (~1,200 views over ~4.5 hours). It includes a web dashboard and optional channel auto-discover."
);
p(
  "It is NOT a Telegram bot and does not use the Bot API for views. It places SMM panel view orders. Channel scrape is only for discovery; the core product is the drip scheduler + JAP."
);

h1("2. Architecture");
p("High-level components and data flow:");
codeBlock([
  "Dashboard UI (public/*)  <── REST :3847 ──>  Express server (index.js)",
  "                                                    |",
  "         +------------------------+-----------------+------------------+",
  "         v                        v                                    v",
  "   worker.js (every 2s)     logic/curve.js                     telegram.js",
  "   drip timer / fire        schedule builder                   scrape t.me",
  "         |",
  "         v",
  "   jap.js  ──>  JAP API service 7394  (+20 views)",
  "         |",
  "         v",
  "   db.js  →  data/db.json  (posts · drops · orders · events · settings)",
]);

table(
  ["Piece", "Role"],
  [
    ["server/logic/curve.js", "Builds full timed schedule of +20 drops"],
    ["server/worker.js", "Every 2s: due drops → place orders"],
    ["server/jap.js", "JustAnotherPanel API client"],
    ["server/telegram.js", "Optional scrape of public channel posts"],
    ["server/db.js", "JSON file store (data/db.json)"],
    ["public/*", "Control panel (status, posts, curve, live)"],
  ],
  [2, 4]
);

h1("3. Core goal (per post)");
table(
  ["Metric", "Value"],
  [
    ["Total paid views", "~1,200"],
    ["Duration", "~4.5 hours (4–5h band)"],
    ["Order size", "Always 20 (JAP service 7394)"],
    ["Instant open", "~76 → 4×20 every 2s at start"],
    ["Multi-post", "Each link runs its own schedule"],
  ],
  [2, 3]
);
p(
  "Approx milestones: 5 min → ~240 · 20 min → ~440 · 1h → ~660 · 2.5h → ~900 · 4.5h → ~1,200"
);

h1("4. Curve engine (curve.js) — full logic");
p(
  "Views are not one big order. They are many small +20 orders timed like real readership: fast at open, slower later."
);

h2("4.1 Phases");
table(
  ["Phase", "Duration", "Target views", "Spacing"],
  [
    ["instant", "8s", "76 → 4 orders", "Every 2s (notify pop)"],
    ["notify", "~5m", "160", "Max gap 30s"],
    ["hot", "15m", "200", "Max gap 70s"],
    ["open", "40m", "220", "Wider gaps"],
    ["mid", "90m", "240", "Up to ~5 min"],
    ["finish", "2h", "300", "Up to ~6 min"],
  ],
  [1.5, 1.2, 1.5, 2.5]
);

h2("4.2 How a schedule is built");
bullet("For each phase: orders = ceil(phase.views / 20)");
bullet(
  "intervalSec = duration / orders (early phases may force denser timing via maxGapSec / fillGaps)"
);
bullet("Instant is special: always ceil(76/20)=4 orders every 2 seconds");
bullet("Each drop: { at: startTime + age, qty: 20, phaseId, seq }");
p("Result: dozens of timed +20 drops summing to ~1,200 over ~4.5h.");

h1("5. Lifecycle of one post");
codeBlock([
  "You paste link  →  normalize URL  →  buildSchedule(startAt)",
  "    → each drop = pending | skipped (if >45s late)",
  "    → save post in db.json  →  status = active",
  "",
  "Worker every 2 seconds:",
  "  for each active post (round-robin fairness):",
  "    take up to 4 due pending drops",
  "    if LIVE → jap.addOrder(service, link, 20)",
  "    if DRY  → fake order id DRY_...",
  "    mark drop sent, log order",
  "",
  "When no pending left → status = completed",
]);
bullet(
  "Late tracking: drops more than 45s past due become skipped; fresh adds still get the instant pack."
);
bullet(
  "Multi-post: independent curves; round-robin + max 4 drops/post/tick prevents starvation."
);
bullet("Failures: live errors retry up to 3 times (~20s delay), then mark failed.");

h1("6. Dry-run vs Live");
table(
  ["Mode", "Behavior"],
  [
    ["DRY-RUN (default)", "Full schedule + logs + fake IDs — no spend"],
    ["LIVE", "Real JAP add orders — uses balance"],
  ],
  [2, 4]
);
p(
  "Toggle: UI switch → POST /api/settings → settings.liveMode (or LIVE_MODE in .env on boot)."
);

h1("7. How posts enter the system");
bullet("Manual — paste one or many https://t.me/... links in the dashboard.");
bullet("Sync channel — scrape t.me/s/{CHANNEL_USERNAME}; only posts from last 6 hours.");
bullet("Auto-discover — same scrape every 2 minutes if enabled.");
p(
  "If Telegram is blocked, auto-discover turns off; paste links manually — drip still works."
);

h1("8. Data model (data/db.json)");
codeBlock([
  "posts[]:",
  "  id, link, title, startAt, status (active|paused|completed)",
  "  totalPlanned, totalOrdered",
  "  drops[]: { at, qty:20, status, japOrderId, phaseId, seq, ... }",
  "",
  "orders[]: history of each +20 submission",
  "events[]: activity log",
  "settings: liveMode, autoDiscover, channelUsername, serviceId, orderQty",
]);

h1("9. Worker execution params");
table(
  ["Parameter", "Value"],
  [
    ["Tick interval", "Every 2 seconds"],
    ["Max drops per post / tick", "4"],
    ["Live gap between API calls", "200ms"],
    ["Miss window (late skip)", "45 seconds"],
    ["Retry delay / max attempts", "20s / 3"],
  ],
  [2.5, 2]
);

h1("10. External dependency: JustAnotherPanel");
codeBlock([
  "POST https://justanotherpanel.com/api/v2",
  "  key + action=add + service=7394 + link + quantity=20",
  "",
  "Also: action=balance | services | status",
  "Credential: JAP_API_KEY in .env",
]);

h1("11. End-to-end flow");
bullet("Start app → Express + worker timer + optional cron sync.");
bullet("Link in → schedule of many +20 timed drops.");
bullet("Worker fires each drop when now >= drop.at.");
bullet("LIVE → JAP buys 20 views on that post URL.");
bullet("UI polls every ~8s: progress, balance, event log, curve preview.");

h1("12. Formula summary");
codeBlock([
  "per post:",
  "  instant:  4 × 20 every 2s          ≈  80 views",
  "  + notify / hot / open / mid / finish phases",
  "  ─────────────────────────────────────────────",
  "  total ≈ 1,200 views over ~4.5 hours",
  "  every order size locked = 20",
]);
p(
  "That is the whole system: curve builder → JSON schedule per post → 2s worker → JAP +20 → dashboard control."
);

h1("13. Environment (.env)");
table(
  ["Key", "Meaning"],
  [
    ["JAP_API_KEY", "Panel API key"],
    ["JAP_API_URL", "https://justanotherpanel.com/api/v2"],
    ["JAP_SERVICE_ID", "7394"],
    ["ORDER_QTY", "20 (locked)"],
    ["LIVE_MODE", "false = dry-run (safe)"],
    ["PORT", "3847"],
    ["CHANNEL_USERNAME", "e.g. robogems"],
    ["AUTO_DISCOVER_POSTS", "true/false"],
  ],
  [2, 3.5]
);

h1("14. Setup");
codeBlock([
  'cd "d:\\Robo Views Bot"',
  "npm install",
  "npm start",
  "",
  "Open http://localhost:3847",
  "Paste post links (one per line). Leave start time empty for now.",
]);

h1("15. What this system is not");
bullet("Not a Telegram Bot API client for artificially counting views.");
bullet("Does not hack Telegram — only places SMM panel orders.");
bullet("Channel scrape is optional; core product is drip + JAP.");

doc.moveDown(1.2);
doc
  .font("Helvetica-Oblique")
  .fontSize(9)
  .fillColor("#64748b")
  .text("End of document — Robo Views Bot system analytic", {
    width: W,
    align: "center",
  });

doc.end();

stream.on("finish", () => {
  console.log("Wrote:", out);
  console.log("Bytes:", fs.statSync(out).size);
});
