import express from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer } from "ws";
import BetwayAPI from "./BetwayApi.js";

const app = express();
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const betway = new BetwayAPI();

const clients = new Set();

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

// ================= WEBSOCKET =================
wss.on("connection", (ws) => {
  clients.add(ws);

  ws.send(JSON.stringify({ type: "connected" }));

  ws.on("close", () => clients.delete(ws));
});

// ================= BROADCAST =================
const broadcast = (data) => {
  const msg = JSON.stringify({
    type: "live",
    timestamp: Date.now(),
    data
  });

  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
};

// ================= LIVE STREAM ENGINE =================
let stream;

const startStream = () => {
  stream = betway.liveStream({
    interval: 3000,
    useCache: false // 🔥 ensure real-time
  });

  stream.on("open", () => {
    console.log("🟢 Live stream started");
  });

  stream.on("message", (data) => {
    broadcast(data);
  });

  stream.on("error", (err) => {
    console.error("🔴 Stream error:", err.message);
  });

  stream.on("close", () => {
    console.log("🟡 Stream closed");
  });
};

// auto-restart safety (optional but smart)
const restartStream = () => {
  try {
    stream?.close();
  } catch {}
  startStream();
};

// start immediately
startStream();

// restart every 5 mins to avoid stale connections
setInterval(restartStream, 5 * 60 * 1000);

// ================= START =================
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
