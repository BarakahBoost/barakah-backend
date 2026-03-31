const express  = require("express");
const cors     = require("cors");
const fs       = require("fs");
const path     = require("path");
const fetch    = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const cron     = require("node-cron");

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: "*", methods: ["GET","POST","PUT","DELETE","OPTIONS"], allowedHeaders: ["Content-Type"] }));
app.use(express.json({ limit: "10mb" }));

// ─── OPSLAG ──────────────────────────────────────────────────
const DATA_DIR  = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "portal.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch(e) { console.error("Load error:", e.message); }
  return {
    agency:   { password: "barakah2026", name: "BarakahPortal", whatsapp: "31685546310" },
    clients:  [],
    bookings: []
  };
}

function saveData(d) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }
  catch(e) { console.error("Save error:", e.message); }
}

let db = loadData();

// ─── TIKTOK API via ScrapeCreators ───────────────────────────
// Gratis account: 20 credits bij aanmaken, geen creditcard
// https://scrapecreators.com — signup, kopieer je x-api-key
const SCRAPECREATORS_KEY = process.env.SCRAPECREATORS_KEY || "";
// Backup: RapidAPI key (TokInsight)
const RAPIDAPI_KEY       = process.env.RAPIDAPI_KEY || "";

async function fetchProfile(username) {
  const clean = username.replace(/^@/, "").split("?")[0].split("/")[0].trim();
  console.log(`Fetching profile: @${clean}`);

  // Methode 1: ScrapeCreators (makkelijkste)
  if (SCRAPECREATORS_KEY) {
    try {
      const res = await fetch(
        `https://api.scrapecreators.com/v1/tiktok/profile?handle=${encodeURIComponent(clean)}`,
        { headers: { "x-api-key": SCRAPECREATORS_KEY } }
      );
      if (res.ok) {
        const d = await res.json();
        console.log(`✅ Profile via ScrapeCreators`);
        // ScrapeCreators returns: { success, credits_remaining, user: { id, uniqueId, nickname, stats: { followers, ... } } }
        const u = d?.user || d?.data?.user || d;
        const stats = u?.stats || u?.userStats || {};
        return {
          username:    clean,
          displayName: u?.nickname || u?.uniqueId || clean,
          avatar:      u?.avatarLarger || u?.avatarMedium || u?.avatarThumb || null,
          verified:    u?.verified || false,
          followers:   stats?.followerCount || u?.followerCount || u?.followers || 0,
          following:   stats?.followingCount || u?.followingCount || u?.following || 0,
          totalLikes:  stats?.heartCount || stats?.heart || u?.heartCount || u?.likes || 0,
          videoCount:  stats?.videoCount || u?.videoCount || u?.videos || 0,
        };
      }
    } catch(e) { console.log(`ScrapeCreators profile failed:`, e.message); }
  }

  // Methode 2: TikTok Scraper via RapidAPI (tiktok-scraper7)
  if (RAPIDAPI_KEY) {
    try {
      const res = await fetch(
        `https://tiktok-scraper7.p.rapidapi.com/user/info?unique_id=${encodeURIComponent(clean)}`,
        { headers: { "x-rapidapi-key": RAPIDAPI_KEY, "x-rapidapi-host": "tiktok-scraper7.p.rapidapi.com" } }
      );
      if (res.ok) {
        const d = await res.json();
        const u = d?.data?.user?.user || d?.data?.user || {};
        const s = d?.data?.user?.stats || d?.data?.stats || {};
        console.log(`✅ Profile via tiktok-scraper7`);
        return {
          username:    clean,
          displayName: u?.nickname || clean,
          avatar:      u?.avatarMedium || null,
          verified:    u?.verified || false,
          followers:   s?.followerCount || 0,
          following:   s?.followingCount || 0,
          totalLikes:  s?.heartCount || 0,
          videoCount:  s?.videoCount || 0,
        };
      }
    } catch(e) { console.log(`tiktok-scraper7 profile failed:`, e.message); }
  }

  throw new Error("Geen werkende API gevonden. Stel SCRAPECREATORS_KEY in op Render.");
}

async function fetchVideos(username) {
  const clean = username.replace(/^@/, "").split("?")[0].split("/")[0].trim();
  console.log(`Fetching videos: @${clean}`);

  // Methode 1: ScrapeCreators
  if (SCRAPECREATORS_KEY) {
    try {
      const res = await fetch(
        `https://api.scrapecreators.com/v1/tiktok/user/posts?handle=${encodeURIComponent(clean)}&limit=30`,
        { headers: { "x-api-key": SCRAPECREATORS_KEY } }
      );
      if (res.ok) {
        const d = await res.json();
        const items = d?.posts || d?.videos || d?.data || [];
        console.log(`✅ ${items.length} videos via ScrapeCreators:`, items[0] ? JSON.stringify(items[0]).slice(0,200) : "no items");
        return items.map(v => ({
          id:       v?.id || v?.videoId || v?.video_id || String(Date.now()),
          url:      v?.url || v?.videoUrl || v?.video_url || `https://www.tiktok.com/@${clean}/video/${v?.id || v?.videoId}`,
          title:    v?.description || v?.desc || v?.title || v?.text || "",
          thumb:    v?.coverUrl || v?.thumbnail || v?.cover || v?.cover_url || null,
          views:    v?.views || v?.playCount || v?.viewCount || v?.play_count || v?.view_count || 0,
          likes:    v?.likes || v?.diggCount || v?.likeCount || v?.digg_count || v?.like_count || 0,
          comments: v?.comments || v?.commentCount || v?.comment_count || 0,
          shares:   v?.shares || v?.shareCount || v?.share_count || 0,
          date:     v?.createTime || v?.create_time ? new Date((v.createTime || v.create_time) * 1000).toISOString().split("T")[0] : new Date().toISOString().split("T")[0],
        }));
      }
    } catch(e) { console.log(`ScrapeCreators videos failed:`, e.message); }
  }

  // Methode 2: tiktok-scraper7
  if (RAPIDAPI_KEY) {
    try {
      const res = await fetch(
        `https://tiktok-scraper7.p.rapidapi.com/user/posts?unique_id=${encodeURIComponent(clean)}&count=30`,
        { headers: { "x-rapidapi-key": RAPIDAPI_KEY, "x-rapidapi-host": "tiktok-scraper7.p.rapidapi.com" } }
      );
      if (res.ok) {
        const d = await res.json();
        const items = d?.data?.videos || d?.data?.items || [];
        console.log(`✅ ${items.length} videos via tiktok-scraper7`);
        return items.map(item => {
          const st = item?.statistics || item?.stats || {};
          return {
            id:       item?.video_id || item?.id || String(Date.now()),
            url:      `https://www.tiktok.com/@${clean}/video/${item?.video_id || item?.id}`,
            title:    item?.title || item?.desc || "",
            thumb:    item?.cover || null,
            views:    st?.play_count || st?.playCount || 0,
            likes:    st?.digg_count || st?.likeCount || 0,
            comments: st?.comment_count || st?.commentCount || 0,
            shares:   st?.share_count || st?.shareCount || 0,
            date:     item?.create_time ? new Date(item.create_time * 1000).toISOString().split("T")[0] : new Date().toISOString().split("T")[0],
          };
        });
      }
    } catch(e) { console.log(`tiktok-scraper7 videos failed:`, e.message); }
  }

  throw new Error("Geen werkende API voor videos. Stel SCRAPECREATORS_KEY in op Render.");
}

async function syncClient(clientId) {
  const client = db.clients.find(c => c.id === clientId);
  if (!client?.tiktokProfile) throw new Error("Geen TikTok profiel ingesteld");
  const username = client.tiktokProfile.replace(/.*@/, "").split("?")[0].split("/")[0].trim();
  console.log(`🔄 Sync ${clientId} (@${username})`);
  const [profile, videos] = await Promise.all([fetchProfile(username), fetchVideos(username)]);
  const idx = db.clients.findIndex(c => c.id === clientId);
  if (idx >= 0) {
    const month  = new Date().toISOString().slice(0,7);
    const totalV = videos.reduce((s,v) => s + (v.views||0), 0);
    const totalL = videos.reduce((s,v) => s + (v.likes||0), 0);
    const entry  = { month, views: totalV, likes: totalL, followers: profile.followers, videos: videos.length };
    if (!db.clients[idx].history) db.clients[idx].history = [];
    const hi = db.clients[idx].history.findIndex(h => h.month === month);
    if (hi >= 0) db.clients[idx].history[hi] = entry; else db.clients[idx].history.push(entry);
    db.clients[idx].tiktokStats = profile;
    db.clients[idx].videos      = videos;
    db.clients[idx].lastSync    = new Date().toISOString();
    db.clients[idx].package     = { ...db.clients[idx].package, used: Math.min(videos.length, db.clients[idx].package?.total || 8) };
    saveData(db);
  }
  console.log(`✅ ${clientId}: ${videos.length} videos, ${profile.followers} volgers`);
  return { profile, videos };
}

// ═══ ROUTES ═══════════════════════════════════════════════════
app.get("/", (req, res) => res.json({
  status:  "ok", service: "BarakahPortal",
  clients: db.clients.length,
  scrapeCreators: SCRAPECREATORS_KEY ? "✅" : "❌ niet ingesteld",
  rapidApi: RAPIDAPI_KEY ? "✅" : "❌ niet ingesteld"
}));

app.get("/portal-data", (req, res) => res.json({ success: true, data: db }));

app.post("/portal-data", (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming) return res.status(400).json({ error: "Geen data" });
    if (incoming.clients && db.clients.length > 0) {
      incoming.clients = incoming.clients.map(ic => {
        const sc = db.clients.find(s => s.id === ic.id);
        if (sc) return { ...ic, tiktokStats: ic.tiktokStats || sc.tiktokStats, videos: ic.videos?.length ? ic.videos : (sc.videos || []), history: ic.history?.length ? ic.history : (sc.history || []), lastSync: sc.lastSync };
        return ic;
      });
    }
    db = { ...db, ...incoming };
    saveData(db);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/sync/:clientId", async (req, res) => {
  try {
    const result = await syncClient(req.params.clientId);
    res.json({ success: true, ...result, data: db });
  } catch(e) {
    console.error("Sync error:", e.message);
    res.status(502).json({ success: false, error: e.message });
  }
});

app.get("/test/:username", async (req, res) => {
  try {
    const profile = await fetchProfile(req.params.username);
    res.json({ success: true, profile });
  } catch(e) { res.status(502).json({ success: false, error: e.message }); }
});

cron.schedule("0 6 * * *", async () => {
  for (const client of db.clients.filter(c => c.tiktokProfile)) {
    try { await syncClient(client.id); } catch(e) { console.error(e.message); }
    await new Promise(r => setTimeout(r, 4000));
  }
}, { timezone: "Europe/Amsterdam" });

app.listen(PORT, () => console.log(`🌿 BarakahPortal op poort ${PORT}`));
