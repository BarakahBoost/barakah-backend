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
 
// ─── TIKTOK ──────────────────────────────────────────────────
const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY || "";
const RAPIDAPI_HOST = "free-tiktok-api-scraper-mobile-version.p.rapidapi.com";
 
async function tiktokGet(path) {
  const res = await fetch(`https://${RAPIDAPI_HOST}${path}`, {
    headers: { "x-rapidapi-key": RAPIDAPI_KEY, "x-rapidapi-host": RAPIDAPI_HOST }
  });
  if (!res.ok) throw new Error(`TikTok API ${res.status}`);
  return res.json();
}
 
async function fetchProfile(username) {
  const clean = username.replace(/^@/, "").split("?")[0].split("/")[0];
  let data;
  for (const ep of [
    `/getUserInfo?username=${encodeURIComponent(clean)}`,
    `/user/info?username=${encodeURIComponent(clean)}`,
    `/getUserInfoByUniqueId?uniqueId=${encodeURIComponent(clean)}`
  ]) {
    try { data = await tiktokGet(ep); break; }
    catch(e) { console.log(`Profile endpoint ${ep} failed:`, e.message); }
  }
  if (!data) throw new Error("Alle profile endpoints mislukt");
  const u = data?.userInfo?.user || data?.user || data?.data?.user || {};
  const s = data?.userInfo?.stats || data?.stats || data?.data?.stats || {};
  return {
    username:    clean,
    displayName: u?.nickname || u?.name || clean,
    avatar:      u?.avatarMedium || u?.avatarThumb || null,
    verified:    u?.verified || false,
    followers:   s?.followerCount || s?.fans || 0,
    following:   s?.followingCount || 0,
    totalLikes:  s?.heartCount || 0,
    videoCount:  s?.videoCount || 0,
  };
}
 
async function fetchVideos(username) {
  const clean = username.replace(/^@/, "").split("?")[0].split("/")[0];
  let data;
  for (const ep of [
    `/getUserVideos?username=${encodeURIComponent(clean)}&count=30`,
    `/user/posts?username=${encodeURIComponent(clean)}&count=30`,
    `/getVideosByUniqueId?uniqueId=${encodeURIComponent(clean)}&count=30`
  ]) {
    try { data = await tiktokGet(ep); break; }
    catch(e) { console.log(`Videos endpoint ${ep} failed:`, e.message); }
  }
  const items = data?.items || data?.aweme_list || data?.data?.items || [];
  return items.map(item => {
    const st = item?.stats || item?.statistics || {};
    return {
      id:       item?.id || item?.aweme_id || String(Date.now()),
      url:      `https://www.tiktok.com/@${clean}/video/${item?.id || item?.aweme_id}`,
      title:    item?.desc || item?.description || "",
      thumb:    item?.video?.cover || item?.video?.originCover || null,
      views:    st?.playCount    || st?.play_count    || 0,
      likes:    st?.diggCount    || st?.digg_count    || 0,
      comments: st?.commentCount || st?.comment_count || 0,
      shares:   st?.shareCount   || st?.share_count   || 0,
      date: item?.createTime
        ? new Date(item.createTime * 1000).toISOString().split("T")[0]
        : new Date().toISOString().split("T")[0],
    };
  });
}
 
async function syncClient(clientId) {
  const client = db.clients.find(c => c.id === clientId);
  if (!client?.tiktokProfile) throw new Error("Geen TikTok profiel ingesteld");
  const username = client.tiktokProfile.replace(/.*@/, "").split("?")[0].split("/")[0];
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
 
// ═══════════════════════════════════════════════════════════
// ROUTES — Data sync tussen alle apparaten
// ═══════════════════════════════════════════════════════════
 
// Health
app.get("/", (req, res) => res.json({
  status: "ok", service: "BarakahPortal",
  clients: db.clients.length,
  apiKey: RAPIDAPI_KEY ? "✅ ingesteld" : "❌ niet ingesteld"
}));
 
// Volledige data ophalen (app laadt dit bij opstarten)
app.get("/portal-data", (req, res) => {
  res.json({ success: true, data: db });
});
 
// Volledige data opslaan (app pusht wijzigingen)
app.post("/portal-data", (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming) return res.status(400).json({ error: "Geen data" });
    // Behoud TikTok sync data van server bij merge
    if (incoming.clients && db.clients.length > 0) {
      incoming.clients = incoming.clients.map(ic => {
        const sc = db.clients.find(s => s.id === ic.id);
        if (sc) {
          return {
            ...ic,
            tiktokStats: ic.tiktokStats || sc.tiktokStats,
            videos:      ic.videos?.length ? ic.videos : (sc.videos || []),
            history:     ic.history?.length ? ic.history : (sc.history || []),
            lastSync:    sc.lastSync
          };
        }
        return ic;
      });
    }
    db = { ...db, ...incoming };
    saveData(db);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
 
// TikTok sync
app.post("/sync/:clientId", async (req, res) => {
  // Update client tiktokProfile from request if provided
  const { tiktokUsername } = req.body;
  if (tiktokUsername) {
    const idx = db.clients.findIndex(c => c.id === req.params.clientId);
    if (idx >= 0 && !db.clients[idx].tiktokProfile) {
      db.clients[idx].tiktokProfile = tiktokUsername;
      saveData(db);
    }
  }
  try {
    const result = await syncClient(req.params.clientId);
    res.json({ success: true, ...result, data: db });
  } catch(e) {
    res.status(502).json({ success: false, error: e.message });
  }
});
 
// Dagelijkse auto-sync
cron.schedule("0 6 * * *", async () => {
  console.log("⏰ Auto-sync...");
  for (const client of db.clients.filter(c => c.tiktokProfile)) {
    try { await syncClient(client.id); } catch {}
    await new Promise(r => setTimeout(r, 4000));
  }
}, { timezone: "Europe/Amsterdam" });
 
app.listen(PORT, () => console.log(`🌿 BarakahPortal op poort ${PORT}`));
 
