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

// duplicate protection
const placedBets = new Map();

// 10 mins
const BET_COOLDOWN =
  10 * 60 * 1000;

// 5 secs
const AI_INTERVAL = 5000;

// ───────────────── HOME ─────────────────

app.get("/", (_, res) => {

  res.send(
    "Betway API Running 🚀"
  );

});

// ───────────────── HEALTH ─────────────────

app.get("/health", (_, res) => {

  res.json({
    success: true,

    aiRunning,

    streamRunning: !!stream,

    lastLiveUpdate:
      lastUpdate,

    lastAIExecution:
      aiLastRun || null,

    activeTrackedBets:
      placedBets.size,

    uptime:
      process.uptime(),

    memory:
      process.memoryUsage()
  });

});

// ───────────────── MATCHES ─────────────────

app.get("/matches", async (req, res) => {

  try {

    const take =
      parseInt(req.query.take)
      || 100;

    const data =
      await betway.list(take);

    res.json({
      success: true,
      count: data.length,
      data
    });

  }

  catch (e) {

    res.status(500).json({
      success: false,
      error: e.message
    });

  }

});

// ───────────────── LOGIN ─────────────────

app.post("/login", async (req, res) => {

  try {

    const {
      username,
      password,
      sessionMetadata
    } = req.body;

    if (
      !username
      || !password
    ) {
      return res.status(400).json({
        success: false,
        error:
          "username and password required"
      });
    }

    const data =
      await betway.login(
        username,
        password,
        sessionMetadata || {}
      );

    res.json({
      success: true,
      message:
        "Login successful",
      data
    });

  }

  catch (e) {

    res.status(500).json({
      success: false,
      error: e.message
    });

  }

});

// ───────────────── BALANCE ─────────────────

app.get("/balance", async (req, res) => {

  try {

    const { userId } =
      req.query;

    const data =
      await betway.getAccountBalance(
        userId || null
      );

    res.json({
      success: true,
      data
    });

  }

  catch (e) {

    res.status(500).json({
      success: false,
      error: e.message
    });

  }

});

// ───────────────── LIVE ─────────────────

app.get("/live", (_, res) => {

  if (!latestLiveData) {

    return res.status(503).json({
      success: false,

      error:
        "Live data not ready"
    });

  }

  res.json({
    success: true,

    lastUpdate,

    data:
      latestLiveData
  });

});

// ───────────────── STREAM HELPERS ─────────────────

const startStream = () => {

  if (aiRunning) {
    console.log(
      "⚠️ Stream blocked because AI is running"
    );

    return;
  }

  if (stream) {
    return;
  }

  stream = betway.liveStream({
    interval: 3000,
    useCache: false
  });

  stream.on("open", () => {

    console.log(
      "🟢 Stream started"
    );

  });

  stream.on("message", data => {

    latestLiveData = data;

    lastUpdate = Date.now();

  });

  stream.on("error", e => {

    console.error(
      "🔴 Stream error:",
      e.message
    );

    restart();

  });

  stream.on("close", () => {

    console.log(
      "🟡 Stream closed"
    );

    restart();

  });

};

const stopStream = () => {

  try {

    stream?.close?.();

  }

  catch {}

  stream = null;

  console.log(
    "🛑 Stream stopped"
  );

};

const restart = () => {

  if (
    restarting
    || aiRunning
  ) {
    return;
  }

  restarting = true;

  try {

    stream?.close?.();

  }

  catch {}

  stream = null;

  setTimeout(() => {

    startStream();

    restarting = false;

  }, 2000);

};

const ensureStream = () => {

  if (
    !stream
    && !aiRunning
  ) {

    startStream();

  }

};

// ───────────────── START STREAM ─────────────────

startStream();

setInterval(() => {

  if (!aiRunning) {
    restart();
  }

}, 5 * 60 * 1000);

// ───────────────── AI STATUS ─────────────────

app.get("/ai/status", (_, res) => {

  res.json({
    success: true,

    aiRunning,

    streamRunning:
      !!stream,

    lastAIExecution:
      aiLastRun || null,

    activeTrackedBets:
      placedBets.size
  });

});

// ───────────────── AI START ─────────────────

app.post("/ai", async (req, res) => {

  try {

    const {
      username,
      password,
      risk = 100
    } = req.body;

    if (
      !username
      || !password
    ) {

      return res.status(400).json({
        success: false,

        error:
          "username and password required"
      });

    }

    if (aiRunning) {

      return res.json({
        success: false,

        message:
          "AI already running"
      });

    }

    await betway.login(
      username,
      password
    );

    aiRunning = true;

    stopStream();

    console.log(
      "🤖 AI started"
    );

    const loop = async () => {

      if (!aiRunning) {

        aiLoop = null;

        return;

      }

      aiLastRun = Date.now();

      try {

        const raw =
          await betway.getUpdates({
            Take: 100
          });

        const now = Date.now();

        const prices =
          Object.fromEntries(
            (raw.prices || []).map(p => [
              p.outcomeId,
              p
            ])
          );

        const outcomes =
          (raw.outcomes || []).reduce(
            (a, o) => {

              (a[o.marketId] ??= [])
                .push(o);

              return a;

            },
            {}
          );

        const events =
          Object.fromEntries(
            (raw.events || []).map(e => [
              e.eventId,
              e
            ])
          );

        for (
          const market
          of raw.markets || []
        ) {

          if (
            ![
              "Win/Draw/Win",
              "1X2"
            ].includes(
              market.marketTypeCName
            )
          ) {
            continue;
          }

          const event =
            events[market.eventId];

          if (!event) {
            continue;
          }

          // skip live
          if (
            event.isLive
            || event.isFinished
          ) {
            continue;
          }

          const startTime =
            event.expectedStartEpoch < 1e12
              ? event.expectedStartEpoch * 1000
              : event.expectedStartEpoch;

          const timeDiff =
            startTime - now;

          // within 30 mins
          if (
            timeDiff > 30 * 60 * 1000
            || timeDiff < 0
          ) {
            continue;
          }

          for (
            const outcome of
            outcomes[market.marketId]
            || []
          ) {

            const priceObj =
              prices[outcome.outcomeId];

            if (!priceObj) {
              continue;
            }

            const odds =
              priceObj.priceDecimal;

            // AI RULE
            if (
              odds == null
              || odds >= 1.10
            ) {
              continue;
            }

            // unique selection
            const betKey = [
              event.eventId,
              market.marketId,
              outcome.outcomeId
            ].join(":");

            const lastBet =
              placedBets.get(
                betKey
              );

            // prevent duplicates
            if (
              lastBet
              && Date.now() - lastBet
                < BET_COOLDOWN
            ) {
              continue;
            }

            console.log(
              "🎯 AI SIGNAL",
              {
                match:
                  `${event.homeTeam} vs ${event.awayTeam}`,

                team:
                  outcome.name,

                odds,

                startsIn:
                  Math.floor(
                    timeDiff / 60000
                  ) + " mins"
              }
            );

            // SAFE SELECTION
            const selection = {

              price:
                priceObj.priceDecimal,

              eventId:
                event.eventId,

              marketId:
                market.marketId,

              outcomeId:
                outcome.outcomeId,

              eventVersion:
                event.version,

              marketVersion:
                market.version,

              outcomeVersion:
                outcome.version,

              priceVersion:
                priceObj.version,

              priceNum:
                priceObj.numerator,

              priceDen:
                priceObj.denominator,

              publicHubPublishedTime:
                priceObj.publicHubPublishedTime
                || null,

              serverEmopSource:
                priceObj.emopSource || 1
            };

            try {

              const result =
                await betway.placeBet(
                  selection,
                  risk
                );

              placedBets.set(
                betKey,
                Date.now()
              );

              console.log(
                "✅ BET PLACED",
                {
                  match:
                    `${event.homeTeam} vs ${event.awayTeam}`,

                  team:
                    outcome.name,

                  odds
                }
              );

              console.log(result);

            }

            catch (betError) {

              console.error(
                "❌ Bet failed:",
                betError.message
              );

            }
          }
        }

        // cleanup
        for (
          const [key, time]
          of placedBets.entries()
        ) {

          if (
            Date.now() - time
            > BET_COOLDOWN
          ) {

            placedBets.delete(key);

          }
        }

      }

      catch (e) {

        console.error(
          "AI loop error:",
          e.message
        );

      }

      aiLoop = setTimeout(
        loop,
        AI_INTERVAL
      );

    };

    loop();

    res.json({
      success: true,
      message:
        "AI started"
    });

  }

  catch (e) {

    res.status(500).json({
      success: false,
      error: e.message
    });

  }

});

// ───────────────── STOP AI ─────────────────

app.post("/ai/stop", (_, res) => {

  aiRunning = false;

  if (aiLoop) {

    clearTimeout(aiLoop);

    aiLoop = null;

  }

  ensureStream();

  console.log(
    "🛑 AI stopped"
  );

  res.json({
    success: true,
    message:
      "AI stopped"
  });

});

// ───────────────── START SERVER ─────────────────

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `🚀 Server running on ${PORT}`
    );

  }
);
