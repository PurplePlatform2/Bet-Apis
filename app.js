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
let last = null;

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

// broadcast helper
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

// ================= SHARED LIVE ENGINE =================
setInterval(async () => {
  try {
    const raw = await betway.getUpdates({ Take: 20 });

    const pm = Object.fromEntries(
      (raw.prices || []).map(p => [p.outcomeId, p.priceDecimal])
    );

    const om = (raw.outcomes || []).reduce((a, o) => {
      (a[o.marketId] ??= []).push(o);
      return a;
    }, {});

    const data = (raw.markets || [])
      .map(m => {
        const e = raw.events?.find(x => x.eventId === m.eventId);
        if (!e) return;

        let h, d, a;

        (om[m.marketId] || []).forEach(o => {
          const v = pm[o.outcomeId];
          if (!v) return;

          o.name === "Draw" ? d = v :
          o.name === e.homeTeam ? h = v :
          o.name === e.awayTeam ? a = v : null;
        });

        return {
          id: e.eventId,
          match: `${e.homeTeam} vs ${e.awayTeam}`,
          home: h,
          draw: d,
          away: a,
          startTime: e.expectedStartEpoch
            ? new Date(e.expectedStartEpoch < 1e12
                ? e.expectedStartEpoch * 1000
                : e.expectedStartEpoch)
            : null
        };
      })
      .filter(Boolean);

    const payload = JSON.stringify(data);

    if (payload !== last) {
      last = payload;
      broadcast(data);
    }

  } catch (e) {
    broadcast({ error: e.message });
  }
}, 3000);

// ================= START =================
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
