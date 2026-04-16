import express from "express";
import cors from "cors";
import http from "http";
import BetwayAPI from "./BetwayApi.js";

const app = express();
app.use(cors());

const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const betway = new BetwayAPI();

// ---------- Cache for live data ----------
let latestLiveData = null;     // stores the most recent data from the stream
let lastUpdate = null;         // timestamp of the last update

// ================= HOME =================
app.get("/", (_, res) => res.send("Betway API Running 🚀"));

// ================= MATCHES (STATIC API) =================
app.get("/matches", async (req, res) => {
  try {
    const data = await betway.list(parseInt(req.query.take) || 100);
    res.json({ success: true, count: data.length, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ================= AUTH LOGIN =================
app.post("/login", express.json(), async (req, res) => {
  try {
    const { username, password, sessionMetadata } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: "username and password are required"
      });
    }

    const data = await betway.login(username, password, sessionMetadata || {});

    res.json({
      success: true,
      message: "Login successful",
      data
    });
  } catch (e) {
    res.status(500).json({
      success: false,
      error: e.message
    });
  }
});


// ================= ACCOUNT BALANCE =================
app.get("/balance", async (req, res) => {
  try {
    const { userId } = req.query;

    const data = await betway.getAccountBalance(userId || null);

    res.json({
      success: true,
      data
    });
  } catch (e) {
    res.status(500).json({
      success: false,
      error: e.message
    });
  }
});


// ================= LIVE DATA (REST + CACHE) =================
app.get("/live", (req, res) => {
  if (latestLiveData === null) {
    return res.status(503).json({
      success: false,
      error: "Live data not yet available, please retry shortly"
    });
  }
  res.json({
    success: true,
    data: latestLiveData,
    lastUpdate: lastUpdate
  });
});

// ================= STREAM ENGINE (UPDATES CACHE) =================
let stream, restarting = false;

const startStream = () => {
  stream = betway.liveStream({ interval: 3000, useCache: false });

  stream.on("open", () => console.log("🟢 Live stream started"));
  stream.on("message", (data) => {
    // Update the cache on every new message
    latestLiveData = data;
    lastUpdate = Date.now();
  });
  stream.on("error", e => (console.error("🔴 Stream error:", e.message), restart()));
  stream.on("close", () => (console.log("🟡 Stream closed → restarting..."), restart()));
};

const restart = () => {
  if (restarting) return;
  restarting = true;

  try {
    stream?.removeAllListeners?.();
    stream?.close?.();
  } catch (e) {
    console.error("Stream cleanup error:", e.message);
  }

  setTimeout(() => (startStream(), restarting = false), 2000);
};

// ================= INIT =================
startStream();
setInterval(restart, 5 * 60 * 1000);   // safety restart every 5 minutes

// ================= START SERVER =================
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
