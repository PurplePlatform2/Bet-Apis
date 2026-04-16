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



/******AI ENDPOINT KEEP SACRED**********/
// ================= AI ENGINE =================
let aiRunning = false;

app.post("/ai", express.json(), async (req, res) => {
  try {
    const { username, password, risk = 100 } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: "username and password required"
      });
    }

    if (aiRunning) {
      return res.json({ success: false, message: "AI already running" });
    }

    await betway.login(username, password);
    aiRunning = true;

    console.log("🤖 AI started...");

    const loop = async () => {
      if (!aiRunning) return;

      try {
        const raw = await betway.getUpdates({ Take: 100 });

        const now = Date.now();

        const prices = Object.fromEntries(raw.prices.map(p => [p.outcomeId, p]));
        const outcomes = raw.outcomes.reduce((a, o) => {
          (a[o.marketId] ||= []).push(o);
          return a;
        }, {});
        const events = Object.fromEntries(raw.events.map(e => [e.eventId, e]));

        for (const market of raw.markets) {
          if (!["Win/Draw/Win", "1X2"].includes(market.marketTypeCName)) continue;

          const event = events[market.eventId];
          if (!event) continue;

          const startTime = event.expectedStartEpoch < 1e12
            ? event.expectedStartEpoch * 1000
            : event.expectedStartEpoch;

          const timeDiff = startTime - now;

          // ⏱ within 30 minutes
          if (timeDiff > 30 * 60 * 1000 || timeDiff < 0) continue;

          for (const o of outcomes[market.marketId] || []) {
            const price = prices[o.outcomeId];
            if (!price) continue;

            // 🎯 odds < 1.10
            if (price.priceDecimal >= 1.10) continue;

            const selection = {
              eventId: event.eventId,
              marketId: market.marketId,
              outcomeId: o.outcomeId,

              priceNum: price.priceNum,
              priceDen: price.priceDen,
              priceDec: price.priceDecimal,

              eventVersion: event.version,
              marketVersion: market.version,
              outcomeVersion: o.version,
              priceVersion: price.version,

              publicHubPublishedTime: price.publicHubPublishedTime
            };

            console.log("🎯 AI SIGNAL:", {
              match: `${event.homeTeam} vs ${event.awayTeam}`,
              team: o.name,
              odds: price.priceDecimal,
              startsInMin: Math.floor(timeDiff / 60000)
            });

            // 💡 BET PAYLOAD READY (safe mode)
            console.log("🧾 BET PAYLOAD:", {
              wagerAmount: risk,
              selections: [selection]
            });

            // auto-bet:
            await betway.placeBet({
              wagerAmount: risk,
              selections: [selection]
            });
          }
        }

      } catch (e) {
        console.error("AI loop error:", e.message);
      }

      setTimeout(loop, 5000); // run every 5s
    };

    loop();

    res.json({ success: true, message: "AI started" });

  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});



// ================= START SERVER =================
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
