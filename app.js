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
const clients = new Set();

wss.on("connection", ws => {
  ws.isAlive = true;
  clients.add(ws);

  ws.send(JSON.stringify({ type: "connected" }));

  ws.on("pong", () => ws.isAlive = true);
  ws.on("close", () => clients.delete(ws));
});

// ================= HEARTBEAT =================
setInterval(() => {
  clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate(), clients.delete(ws);
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ================= BROADCAST =================
const broadcast = data => {
  const msg = JSON.stringify({ type: "live", timestamp: Date.now(), data });

  clients.forEach(ws => {
    try {
      if (ws.readyState === 1 && ws.bufferedAmount < 1e6) ws.send(msg);
    } catch {
      clients.delete(ws);
    }
  });
};

// ================= STREAM ENGINE =================
let stream, restarting = false;

const startStream = () => {
  stream = betway.liveStream({ interval: 3000, useCache: false });

  stream.on("open", () => console.log("🟢 Live stream started"));
  stream.on("message", broadcast);
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
setInterval(restart, 5 * 60 * 1000);
setInterval(() => console.log(`👥 Clients: ${clients.size}`), 10000);

// ================= START =================
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
