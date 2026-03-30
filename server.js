const express = require("express");
const cors    = require("cors");
const fetch   = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const cron    = require("node-cron");

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: [
    "http://localhost:5173",
    "http://localhost:3000",
    /\.vercel\.app$/,
    /\.netlify\.app$/,
    process.env.FRONTEND_URL
  ].filter(Boolean)
}));
app.use(express.json());

const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY || "JOUW_RAPIDAPI_KEY_HIER";
const RAPIDAPI_HOST = "free-tiktok-api-scraper-mobile-version.p.rapidapi.com";

let cache = {}; // { clientId: { profile, videos, lastSync, error } }

async function tiktokGet(path) {
  const res = await fetch(`https://${RAPIDAPI_HOST}${path}`, {
    headers: {
      "x-rapidapi-key":  RAPIDAPI_KEY,
      "x-rapidapi-host": RAPIDAPI_HOST
    }
  });
  if (!res.ok) throw new Error(`TikTok API ${res.status}`);
  return res.json();
}

async function fetchProfile(username) {
  const clean = username.replace(/^@/, "").split("?")[0].split("/")[0];
  // Try multiple endpoints
  let data;
  try {
    data = await tiktokGet(`/getUserInfo?username=${encodeURIComponent(clean)}`);
  } catch(e) {
    try {
      data = await tiktokGet(`/user/info?username=${encodeURIComponent(clean)}`);
    } catch(e2) {
      data = await tiktokGet(`/getUserInfoByUniqueId?uniqueId=${encodeURIComponent(clean)}`);
    }
  }
  const u = data?.userInfo?.user || data?.user || data?.data?.user || data || {};
  const s = data?.userInfo?.stats || data?.stats || data?.data?.stats || {};
  return {
    username:    clean,
    displayName: u?.nickname || u?.name || clean,
    avatar:      u?.avatarMedium || u?.avatarThumb || u?.avatar || null,
    verified:    u?.verified || false,
    followers:   s?.followerCount || s?.fans || 0,
    following:   s?.followingCount || s?.following || 0,
    totalLikes:  s?.heartCount || s?.heart || s?.digg || 0,
    videoCount:  s?.videoCount || s?.video || 0,
  };
}

async function fetchVideos(username) {
  const clean = username.replace(/^@/, "").split("?")[0].split("/")[0];
  let data;
  try {
    data = await tiktokGet(`/getUserVideos?username=${encodeURIComponent(clean)}&count=30`);
  } catch(e) {
    try {
      data = await tiktokGet(`/user/posts?username=${encodeURIComponent(clean)}&count=30`);
    } catch(e2) {
      data = await tiktokGet(`/getVideosByUniqueId?uniqueId=${encodeURIComponent(clean)}&count=30`);
    }
  }
  const items = data?.items || data?.aweme_list || data?.data?.items || data?.videoList || [];
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

async function syncClient(clientId, tiktokUsername) {
  console.log(`🔄 Sync ${clientId} (@${tiktokUsername})`);
  const [profile, videos] = await Promise.all([
    fetchProfile(tiktokUsername),
    fetchVideos(tiktokUsername)
  ]);
  cache[clientId] = { profile, videos, lastSync: new Date().toISOString(), error: null };
  console.log(`✅ ${clientId}: ${videos.length} videos, ${profile.followers} volgers`);
  return cache[clientId];
}

// Health
app.get("/", (req, res) => res.json({
  status: "ok", service: "BarakahPortal Sync",
  synced: Object.keys(cache).length,
  apiKey: RAPIDAPI_KEY !== "JOUW_RAPIDAPI_KEY_HIER" ? "✅ ingesteld" : "❌ niet ingesteld"
}));

// Sync één klant
app.post("/sync/:clientId", async (req, res) => {
  const { tiktokUsername } = req.body;
  if (!tiktokUsername) return res.status(400).json({ error: "tiktokUsername verplicht" });
  try {
    const result = await syncClient(req.params.clientId, tiktokUsername);
    res.json({ success: true, ...result });
  } catch (e) {
    cache[req.params.clientId] = { ...(cache[req.params.clientId]||{}), error: e.message, lastSync: new Date().toISOString() };
    res.status(502).json({ success: false, error: e.message });
  }
});

// Sync alle klanten tegelijk
app.post("/sync-all", async (req, res) => {
  const { clients } = req.body;
  if (!Array.isArray(clients)) return res.status(400).json({ error: "clients[] verplicht" });
  const results = {};
  for (const { clientId, tiktokUsername } of clients) {
    try {
      results[clientId] = await syncClient(clientId, tiktokUsername);
    } catch (e) {
      results[clientId] = { error: e.message };
    }
    await new Promise(r => setTimeout(r, 3500)); // rate limit buffer
  }
  res.json({ success: true, results });
});

// Data ophalen
app.get("/data/:clientId", (req, res) => {
  const d = cache[req.params.clientId];
  if (!d) return res.status(404).json({ error: "Nog niet gesyncht" });
  res.json({ success: true, ...d });
});

app.get("/data", (req, res) => res.json({ success: true, clients: cache }));

// Preview profiel (bij klant toevoegen)
app.get("/preview/:username", async (req, res) => {
  try {
    const profile = await fetchProfile(req.params.username);
    res.json({ success: true, profile });
  } catch (e) {
    res.status(502).json({ success: false, error: e.message });
  }
});

// Dagelijkse auto-sync om 06:00
cron.schedule("0 6 * * *", async () => {
  const pairs = (process.env.CRON_CLIENTS || "").split(",").filter(Boolean);
  if (!pairs.length) return;
  console.log("⏰ Auto-sync gestart voor", pairs.length, "klanten");
  for (const pair of pairs) {
    const [id, un] = pair.split(":").map(s => s.trim());
    if (id && un) {
      try { await syncClient(id, un); } catch {}
      await new Promise(r => setTimeout(r, 4000));
    }
  }
}, { timezone: "Europe/Amsterdam" });

app.listen(PORT, () => {
  console.log(`🌿 BarakahPortal draait op poort ${PORT}`);
  if (RAPIDAPI_KEY === "JOUW_RAPIDAPI_KEY_HIER")
    console.log("⚠️  Stel RAPIDAPI_KEY in als environment variable!");
});
