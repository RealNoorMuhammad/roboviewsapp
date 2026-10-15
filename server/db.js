const fs = require("fs");
const path = require("path");

function resolveDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  // Railway volume mount (Settings → Volumes). Survives redeploys.
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    return process.env.RAILWAY_VOLUME_MOUNT_PATH;
  }
  const project = path.join(__dirname, "..", "data");
  const legacy = path.join(__dirname, "..", "..", "data");
  // Prefer existing DB so local history / skips survive path fix
  if (fs.existsSync(path.join(legacy, "db.json"))) return legacy;
  return project;
}

const DATA_DIR = resolveDataDir();
const DB_FILE = path.join(DATA_DIR, "db.json");
const LOCK_FILE = path.join(DATA_DIR, "instance.lock");

let mem = null;
let lockHeld = false;

function pidAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Only one desk process may drip against this DB.
 * A second instance (e.g. another PORT) used to share db.json with a stale
 * in-memory copy and double-order the same Telegram drops.
 */
function acquireInstanceLock() {
  ensure();
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const prev = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
      if (pidAlive(prev.pid)) {
        const err = new Error(
          `Another Robo View Machine instance is already running (pid ${prev.pid}${
            prev.port ? ` · port ${prev.port}` : ""
          }). Stop it first — two desks share one DB and duplicate view orders.`
        );
        err.code = "INSTANCE_LOCK";
        throw err;
      }
    } catch (e) {
      if (e.code === "INSTANCE_LOCK") throw e;
    }
  }
  const payload = {
    pid: process.pid,
    port: Number(process.env.PORT || 3847) || 3847,
    at: new Date().toISOString(),
  };
  fs.writeFileSync(LOCK_FILE, JSON.stringify(payload, null, 2));
  lockHeld = true;

  const release = () => {
    if (!lockHeld) return;
    lockHeld = false;
    try {
      if (!fs.existsSync(LOCK_FILE)) return;
      const cur = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
      if (cur.pid === process.pid) fs.unlinkSync(LOCK_FILE);
    } catch {
      /* ignore */
    }
  };
  process.once("exit", release);
  process.once("SIGINT", () => {
    release();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    release();
    process.exit(0);
  });
  return payload;
}

const empty = () => ({
  posts: [],
  orders: [],
  twitterOrders: [],
  twitterPostOrders: [],
  twitterViewOrders: [],
  instagramOrders: [],
  instagramLikeOrders: [],
  instagramDrips: [],
  fomoOrders: [],
  youtubeOrders: [],
  events: [],
  settings: {
    liveMode: false,
    autoDiscover: true,
    channelUsername: "bansyndicate",
    channelUsernames: ["bansyndicate", "robogems"],
    channelWaters: {},
    serviceId: 7394,
    orderQty: 20,
    twitterServiceId: Number(
      process.env.JAP_TWITTER_FOLLOWERS_SERVICE_ID || 9011
    ),
    twitterProfileUrl:
      process.env.TWITTER_PROFILE_URL || "https://x.com/wangchaionbnb",
    twitterPostTask: process.env.TWITTER_POST_DEFAULT_TASK || "likes",
    twitterPostServiceId: Number(
      process.env.JAP_TWITTER_LIKES_SERVICE_ID || 8847
    ),
    twitterPostUrl: process.env.TWITTER_POST_URL || "",
    twitterPostCommentStyle: process.env.TWITTER_POST_COMMENT_STYLE || "custom",
    twitterPostComments: "",
    twitterViewsServiceId: Number(
      process.env.JAP_TWITTER_VIEWS_SERVICE_ID || 8413
    ),
    twitterViewsPostUrl:
      process.env.TWITTER_VIEWS_POST_URL || process.env.TWITTER_POST_URL || "",
    instagramServiceId: Number(
      process.env.JAP_INSTAGRAM_FOLLOWERS_SERVICE_ID || 352
    ),
    instagramProfileUrl:
      process.env.INSTAGRAM_PROFILE_URL ||
      "https://www.instagram.com/Bancrypto__/",
    instagramLikesServiceId: Number(
      process.env.JAP_INSTAGRAM_LIKES_SERVICE_ID || 8216
    ),
    instagramLikesPostUrl: process.env.INSTAGRAM_LIKES_POST_URL || "",
    fomoServiceId: Number(process.env.JAP_FOMO_FOLLOWERS_SERVICE_ID || 900002),
    fomoProfileUrl:
      process.env.FOMO_PROFILE_URL ||
      "https://fomo.family/r/noormemewebdev",
    youtubeTask: process.env.YOUTUBE_DEFAULT_TASK || "subscribers",
    youtubeServiceId: Number(
      process.env.JAP_YOUTUBE_SUBS_SERVICE_ID ||
        process.env.JAP_YOUTUBE_VIEWS_SERVICE_ID ||
        3074
    ),
    youtubeLinkUrl:
      process.env.YOUTUBE_DEFAULT_URL ||
      "https://www.youtube.com/@ognoormuhammad8951",
    youtubeChannelUrl: "https://www.youtube.com/@ognoormuhammad8951",
  },
  meta: { updatedAt: null },
});

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const init = empty();
    init.meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2));
  }
}

function parseDbText(text) {
  return JSON.parse(text);
}

function migrate(db) {
  if (!db || typeof db !== "object") return db;
  if (!Array.isArray(db.twitterOrders)) db.twitterOrders = [];
  if (!Array.isArray(db.twitterPostOrders)) db.twitterPostOrders = [];
  if (!Array.isArray(db.twitterViewOrders)) db.twitterViewOrders = [];
  if (!Array.isArray(db.instagramOrders)) db.instagramOrders = [];
  if (!Array.isArray(db.instagramLikeOrders)) db.instagramLikeOrders = [];
  if (!Array.isArray(db.instagramDrips)) db.instagramDrips = [];
  if (!Array.isArray(db.fomoOrders)) db.fomoOrders = [];
  if (!Array.isArray(db.youtubeOrders)) db.youtubeOrders = [];
  if (!db.settings) db.settings = {};
  if (db.settings.youtubeTask == null) {
    db.settings.youtubeTask = process.env.YOUTUBE_DEFAULT_TASK || "subscribers";
  }
  if (db.settings.youtubeServiceId == null) {
    db.settings.youtubeServiceId = Number(
      process.env.JAP_YOUTUBE_SUBS_SERVICE_ID ||
        process.env.JAP_YOUTUBE_VIEWS_SERVICE_ID ||
        3074
    );
  }
  db.settings.youtubeChannelUrl = "https://www.youtube.com/@ognoormuhammad8951";
  if (
    db.settings.youtubeLinkUrl == null ||
    /dQw4w9WgXcQ/i.test(String(db.settings.youtubeLinkUrl))
  ) {
    db.settings.youtubeLinkUrl =
      process.env.YOUTUBE_DEFAULT_URL ||
      "https://www.youtube.com/@ognoormuhammad8951";
  }
  if (db.settings.twitterServiceId == null) {
    db.settings.twitterServiceId = Number(
      process.env.JAP_TWITTER_FOLLOWERS_SERVICE_ID || 9011
    );
  }
  if (db.settings.twitterProfileUrl == null) {
    db.settings.twitterProfileUrl =
      process.env.TWITTER_PROFILE_URL || "https://x.com/wangchaionbnb";
  }
  // Prefer WangChai X when still on legacy demo profiles
  if (
    /x\.com\/(Bancrypto__|noormemewebdev)\/?$/i.test(
      String(db.settings.twitterProfileUrl || "")
    )
  ) {
    db.settings.twitterProfileUrl =
      process.env.TWITTER_PROFILE_URL || "https://x.com/wangchaionbnb";
  }
  if (db.settings.twitterPostTask == null) {
    db.settings.twitterPostTask =
      process.env.TWITTER_POST_DEFAULT_TASK || "likes";
  }
  if (db.settings.twitterPostServiceId == null) {
    db.settings.twitterPostServiceId = Number(
      process.env.JAP_TWITTER_LIKES_SERVICE_ID || 8847
    );
  }
  if (db.settings.twitterPostUrl == null) {
    db.settings.twitterPostUrl = process.env.TWITTER_POST_URL || "";
  }
  if (db.settings.twitterPostCommentStyle == null) {
    db.settings.twitterPostCommentStyle =
      process.env.TWITTER_POST_COMMENT_STYLE || "custom";
  }
  if (db.settings.twitterPostComments == null) {
    db.settings.twitterPostComments = "";
  }
  if (
    db.settings.twitterViewsServiceId == null ||
    [1924, 8859, 8860].includes(Number(db.settings.twitterViewsServiceId))
  ) {
    db.settings.twitterViewsServiceId = Number(
      process.env.JAP_TWITTER_VIEWS_SERVICE_ID || 8413
    );
  }
  if (db.settings.twitterViewsPostUrl == null) {
    db.settings.twitterViewsPostUrl =
      process.env.TWITTER_VIEWS_POST_URL || process.env.TWITTER_POST_URL || "";
  }
  if (db.settings.instagramServiceId == null) {
    db.settings.instagramServiceId = Number(
      process.env.JAP_INSTAGRAM_FOLLOWERS_SERVICE_ID || 352
    );
  }
  if (db.settings.instagramProfileUrl == null) {
    db.settings.instagramProfileUrl =
      process.env.INSTAGRAM_PROFILE_URL ||
      "https://www.instagram.com/Bancrypto__/";
  }
  if (db.settings.instagramLikesServiceId == null) {
    db.settings.instagramLikesServiceId = Number(
      process.env.JAP_INSTAGRAM_LIKES_SERVICE_ID || 8216
    );
  }
  if (db.settings.instagramLikesPostUrl == null) {
    db.settings.instagramLikesPostUrl =
      process.env.INSTAGRAM_LIKES_POST_URL || "";
  }
  if (db.settings.fomoServiceId == null || Number(db.settings.fomoServiceId) <= 0) {
    db.settings.fomoServiceId = Number(
      process.env.JAP_FOMO_FOLLOWERS_SERVICE_ID || 900002
    );
  }
  if (db.settings.fomoProfileUrl == null || /\/r\/Bancrypto$/i.test(db.settings.fomoProfileUrl)) {
    db.settings.fomoProfileUrl =
      process.env.FOMO_PROFILE_URL ||
      "https://fomo.family/r/noormemewebdev";
  }
  return db;
}

function loadFromDisk() {
  ensure();
  try {
    mem = migrate(parseDbText(fs.readFileSync(DB_FILE, "utf8")));
    return mem;
  } catch (err) {
    const tmp = DB_FILE + ".tmp";
    if (fs.existsSync(tmp)) {
      try {
        mem = migrate(parseDbText(fs.readFileSync(tmp, "utf8")));
        return mem;
      } catch {
        /* fall through */
      }
    }
    if (mem) return mem;
    throw err;
  }
}

function atomicWriteFile(file, contents) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contents);
  let lastErr;
  for (let i = 0; i < 8; i++) {
    try {
      try {
        fs.renameSync(tmp, file);
      } catch {
        fs.copyFileSync(tmp, file);
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
      }
      return;
    } catch (err) {
      lastErr = err;
      // Windows often locks db.json briefly (AV / another handle)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 + i * 20);
    }
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  throw lastErr;
}

function read() {
  if (mem) return mem;
  return loadFromDisk();
}

function write(db) {
  ensure();
  db.meta = db.meta || {};
  db.meta.updatedAt = new Date().toISOString();
  mem = db;
  atomicWriteFile(DB_FILE, JSON.stringify(db, null, 2));
  return db;
}

function update(mutator) {
  const db = read();
  mutator(db);
  return write(db);
}

function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function logEvent(type, message, extra = {}) {
  return update((db) => {
    db.events.unshift({
      id: uid("evt"),
      type,
      message,
      ...extra,
      at: new Date().toISOString(),
    });
    db.events = db.events.slice(0, 500);
  });
}

module.exports = {
  read,
  write,
  update,
  uid,
  logEvent,
  DATA_DIR,
  DB_FILE,
  LOCK_FILE,
  acquireInstanceLock,
};
