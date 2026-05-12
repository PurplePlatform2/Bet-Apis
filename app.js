import express from "express";
import cors from "cors";
import http from "http";
import BetwayAPI from "./BetwayApi.js";

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

const betway = new BetwayAPI();

// ───────────────── DEMO LOGIN ─────────────────

const DEMO_USERNAME = "08109995000";
const DEMO_PASSWORD = "password";

// ───────────────── LIVE CACHE ─────────────────

let latestLiveData = null;
let lastUpdate = null;

// ───────────────── STREAM STATE ─────────────────

let stream = null;
let restarting = false;

// ───────────────── AI STATE ─────────────────

let aiRunning = false;
let aiLoop = null;
let aiLastRun = 0;

const placedBets = new Map();

const BET_COOLDOWN = 10 * 60 * 1000;
const AI_INTERVAL = 60 * 1000;

// ───────────────── HOME ─────────────────

app.get("/", (_, res) => {
  res.send("Betway API Running 🚀");
});

// ───────────────── HEALTH ─────────────────

app.get("/health", (_, res) => {
  res.json({
    success: true,
    aiRunning,
    streamRunning: !!stream,
    lastLiveUpdate: lastUpdate,
    lastAIExecution: aiLastRun || null,
    activeTrackedBets: placedBets.size,
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

// ───────────────── MATCHES ─────────────────

app.get("/matches", async (req, res) => {
  try {
    const take = parseInt(req.query.take) || 100;
    const data = await betway.list(take);

    res.json({ success: true, count: data.length, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ───────────────── LOGIN ─────────────────

app.post("/login", async (req, res) => {
  try {
    const { username, password, sessionMetadata } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: "username and password required"
      });
    }

    const data = await betway.login(
      username,
      password,
      sessionMetadata || {}
    );

    res.json({ success: true, message: "Login successful", data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ───────────────── BALANCE ─────────────────

app.get("/balance", async (req, res) => {
  try {
    const data = await betway.getAccountBalance(req.query.userId || null);
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ───────────────── LIVE ─────────────────

app.get("/live", (_, res) => {
  if (!latestLiveData) {
    return res.status(503).json({
      success: false,
      error: "Live data not ready"
    });
  }

  res.json({
    success: true,
    lastUpdate,
    data: latestLiveData
  });
});

// ───────────────── STREAM HELPERS (RESTORED FULLY) ─────────────────

function stopStream() {
  try {
    if (stream) {
      if (typeof stream.close === "function") stream.close();
      if (typeof stream.terminate === "function") stream.terminate();
    }
  } catch (e) {
    console.error("stopStream error:", e.message);
  } finally {
    stream = null;
    restarting = false;
  }
}

function startStream() {
  try {
    if (stream) return;

    stream = betway.startStream?.({
      onData: (data) => {
        latestLiveData = data;
        lastUpdate = Date.now();
      },
      onError: (err) => {
        console.error("Stream error:", err);
        restartStream();
      }
    }) || null;
  } catch (e) {
    console.error("startStream error:", e.message);
  }
}

function restartStream() {
  if (restarting) return;
  restarting = true;

  setTimeout(() => {
    stopStream();
    startStream();
    restarting = false;
  }, 3000);
}

// ───────────────── AI CORE ─────────────────

async function runAI(username, password, risk = 100) {
  if (aiRunning) return;

  await betway.login(username, password);
  aiRunning = true;

  stopStream();

  console.log("🤖 AI started");

  const loop = async () => {
    if (!aiRunning) {
      aiLoop = null;
      return;
    }

    aiLastRun = Date.now();

    try {
      const raw = await betway.getUpdates({ Take: 100 });
      const now = Date.now();

      const prices = Object.fromEntries(
        (raw.prices || []).map(p => [p.outcomeId, p])
      );

      const outcomes = (raw.outcomes || []).reduce((a, o) => {
        (a[o.marketId] ??= []).push(o);
        return a;
      }, {});

      const events = Object.fromEntries(
        (raw.events || []).map(e => [e.eventId, e])
      );

      for (const market of raw.markets || []) {
        if (!["Win/Draw/Win", "1X2"].includes(market.marketTypeCName)) continue;

        const event = events[market.eventId];
        if (!event || event.isLive || event.isFinished) continue;

        const startTime =
          event.expectedStartEpoch < 1e12
            ? event.expectedStartEpoch * 1000
            : event.expectedStartEpoch;

        const timeDiff = startTime - now;

        for (const outcome of outcomes[market.marketId] || []) {
          const priceObj = prices[outcome.outcomeId];
          if (!priceObj) continue;

          const odds = priceObj.priceDecimal;

          if (odds != null && odds < 1.10) {
            console.log("📊 LOW ODDS DETECTED", {
              match: `${event.homeTeam} vs ${event.awayTeam}`,
              team: outcome.name,
              odds,
              startsInMin: Math.floor(timeDiff / 60000)
            });
          }

          if (odds == null || odds >= 1.10) continue;

          const betKey = [
            event.eventId,
            market.marketId,
            outcome.outcomeId
          ].join(":");

          const lastBet = placedBets.get(betKey);

          if (lastBet && Date.now() - lastBet < BET_COOLDOWN) continue;

          if (timeDiff <= 30 * 60 * 1000 && timeDiff > 0) {
            const selection = {
              price: priceObj.priceDecimal,
              eventId: event.eventId,
              marketId: market.marketId,
              outcomeId: outcome.outcomeId,
              eventVersion: event.version,
              marketVersion: market.version,
              outcomeVersion: outcome.version,
              priceVersion: priceObj.version,
              priceNum: priceObj.numerator,
              priceDen: priceObj.denominator,
              publicHubPublishedTime: priceObj.publicHubPublishedTime || null,
              serverEmopSource: priceObj.emopSource || 1
            };

            try {
              const result =
                typeof betway.strike === "function"
                  ? await betway.strike(selection, risk)
                  : await betway.placeBet(selection, risk);

              placedBets.set(betKey, Date.now());

              console.log("⚡ STRIKE EXECUTED", {
                match: `${event.homeTeam} vs ${event.awayTeam}`,
                team: outcome.name,
                odds
              });

              console.log(result);
            } catch (e) {
              console.error("❌ Strike failed:", e.message);
            }
          }
        }
      }

      for (const [key, time] of placedBets.entries()) {
        if (Date.now() - time > BET_COOLDOWN) {
          placedBets.delete(key);
        }
      }
    } catch (e) {
      console.error("AI loop error:", e.message);
    }

    aiLoop = setTimeout(loop, AI_INTERVAL);
  };

  loop();
}

// ───────────────── AI ENDPOINTS (RESTORED + SAFE) ─────────────────

app.post("/ai", async (req, res) => {
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

    await runAI(username, password, risk);

    res.json({ success: true, message: "AI started" });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ───────────────── STOP AI (RESTORED) ─────────────────

app.post("/ai/stop", (_, res) => {
  aiRunning = false;
  if (aiLoop) clearTimeout(aiLoop);
  aiLoop = null;

  stopStream();

  res.json({ success: true, message: "AI stopped" });
});

// ───────────────── AUTO START ON BOOT ─────────────────

server.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);

  try {
    console.log("🔐 Auto login starting...");
    await runAI(DEMO_USERNAME, DEMO_PASSWORD, 100);
    console.log("🤖 AI auto-started with demo account");
  } catch (e) {
    console.error("❌ Auto start failed:", e.message);
  }
});
