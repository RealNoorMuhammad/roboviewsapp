const db = require("../server/db");

const SKIP = new Set([
  "https://t.me/testnoor123/77",
  "https://t.me/testnoor123/78",
]);

db.update((d) => {
  d.settings = d.settings || {};
  d.settings.discoverAfterMessageId = 78;
  d.settings.liveMode = true;
  d.settings.autoDiscover = true;

  for (const p of d.posts || []) {
    const link = String(p.link || "").replace(/\/$/, "");
    if (!SKIP.has(link) && !/testnoor123\/(77|78)$/.test(link)) continue;
    p.status = "skipped";
    p.source = "skipped";
    p.skipOrders = true;
    for (const drop of p.drops || []) {
      if (drop.status === "pending" || drop.status === "sending") {
        drop.status = "skipped";
        drop.error = "user skip — no drip on posts 77/78";
      }
    }
  }

  // Ensure placeholders exist so auto-discover won't treat as new if link reappears
  for (const link of SKIP) {
    if ((d.posts || []).some((p) => String(p.link).replace(/\/$/, "") === link)) {
      continue;
    }
    d.posts.unshift({
      id: `skip_${link.split("/").pop()}`,
      link,
      title: `skipped ${link}`,
      source: "skipped",
      startAt: new Date().toISOString(),
      status: "skipped",
      createdAt: new Date().toISOString(),
      totalPlanned: 0,
      totalOrdered: 0,
      skipOrders: true,
      drops: [],
    });
  }
});

db.logEvent(
  "post_skipped",
  "Posts 77 & 78 skipped (no +86). Next auto drip starts at message id 79+."
);

const d = db.read();
console.log(
  JSON.stringify(
    {
      discoverAfterMessageId: d.settings.discoverAfterMessageId,
      posts: d.posts.map((p) => ({
        link: p.link,
        status: p.status,
        pending: (p.drops || []).filter(
          (x) => x.status === "pending" || x.status === "sending"
        ).length,
        skipped: (p.drops || []).filter((x) => x.status === "skipped").length,
        sent: (p.drops || []).filter((x) => x.status === "sent").length,
      })),
    },
    null,
    2
  )
);
