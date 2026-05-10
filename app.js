import express from "express";
import cors from "cors";
import http from "http";
import BetwayAPI from "./BetwayApi.js";

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ───────────────── SINGLETON ─────────────────
// NOTE:
// still single-user auth architecture
// preserves your frontend API exactly

const betway = new BetwayAPI();

// ───────────────── LIVE CACHE ─────────────────

let latestLiveData = null;
let lastUpdate = 0;

// ───────────────── AI STATE ─────────────────

let aiRunning = false;

// duplicate protection
const placedBets = new Map();

const alreadyPlaced = (
  key,
  cooldown = 10 * 60 * 1000
) => {
  const now = Date.now();

  // cleanup expired
  for (const [k, t] of placedBets) {
    if (now - t > cooldown) {
      placedBets.delete(k);
    }
  }

  // already exists
  if (placedBets.has(key)) {
    return true;
  }

  // store
  placedBets.set(key, now);

  return false;
};

// ───────────────── HOME ─────────────────

app.get("/", (_, res) => {
  res.send("Betway API Running 🚀");
});

// ───────────────── MATCHES ─────────────────

app.get("/matches", async (req, res) => {
  try {
    const take =
      parseInt(req.query.take) || 100;

    const data = await betway.list(take);

    res.json({
      success: true,
      count: data.length,
      data,
    });
  }

  catch (e) {
    res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

// ───────────────── LOGIN ─────────────────

app.post("/login", async (req, res) => {
  try {
    const {
      username,
      password,
      sessionMetadata,
    } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error:
          "username and password are required",
      });
    }

    const data = await betway.login(
      username,
      password,
      sessionMetadata || {}
    );

    res.json({
      success: true,
      message: "Login successful",
      data,
    });
  }

  catch (e) {
    res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

// ───────────────── BALANCE ─────────────────

app.get("/balance", async (req, res) => {
  try {
    const { userId } = req.query;

    const data =
      await betway.getAccountBalance(
        userId || null
      );

    res.json({
      success: true,
      data,
    });
  }

  catch (e) {
    res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

// ───────────────── LIVE DATA ─────────────────

app.get("/live", (req, res) => {
  if (!latestLiveData) {
    return res.status(503).json({
      success: false,
      error:
        "Live data not yet available",
    });
  }

  // stale protection
  if (Date.now() - lastUpdate > 15000) {
    return res.status(503).json({
      success: false,
      error:
        "Live stream temporarily stale",
    });
  }

  res.json({
    success: true,
    data: latestLiveData,
    lastUpdate,
  });
});

// ───────────────── STREAM ENGINE ─────────────────

let stream = null;
let restarting = false;

const startStream = () => {
  stream = betway.liveStream({
    interval: 3000,
  });

  stream.on("open", () => {
    console.log(
      "🟢 Live stream started"
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
      "🟡 Stream closed → restarting..."
    );

    restart();
  });
};

const restart = () => {
  if (restarting) return;

  restarting = true;

  try {
    stream?.close?.();
  }

  catch (e) {
    console.error(
      "Stream cleanup error:",
      e.message
    );
  }

  setTimeout(() => {
    startStream();
    restarting = false;
  }, 2000);
};

// ───────────────── INIT ─────────────────

startStream();

// safety restart
setInterval(
  restart,
  5 * 60 * 1000
);

// ───────────────── AI ENGINE ─────────────────

app.post("/ai", async (req, res) => {
  try {
    const {
      username,
      password,
      risk = 100,
    } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error:
          "username and password required",
      });
    }

    if (aiRunning) {
      return res.json({
        success: false,
        message: "AI already running",
      });
    }

    await betway.login(
      username,
      password
    );

    aiRunning = true;

    console.log("🤖 AI started...");

    const loop = async () => {
      if (!aiRunning) return;

      try {
        const raw =
          await betway.getLiveData(100);

        const now = Date.now();

        const prices =
          Object.fromEntries(
            (raw.prices || []).map(p => [
              p.outcomeId,
              p,
            ])
          );

        const outcomes =
          (raw.outcomes || []).reduce(
            (a, o) => {
              (a[o.marketId] ||= []).push(o);
              return a;
            },
            {}
          );

        const events =
          Object.fromEntries(
            (raw.events || []).map(e => [
              e.eventId,
              e,
            ])
          );

        for (const market of raw.markets || []) {
          if (
            ![
              "Win/Draw/Win",
              "1X2",
            ].includes(
              market.marketTypeCName
            )
          ) continue;

          const event =
            events[market.eventId];

          if (!event) continue;

          const startTime =
            event.expectedStartEpoch < 1e12
              ? event.expectedStartEpoch * 1000
              : event.expectedStartEpoch;

          const timeDiff =
            startTime - now;

          // only within 30 mins
          if (
            timeDiff >
              30 * 60 * 1000 ||
            timeDiff < 0
          ) continue;

          for (
            const outcome of
            outcomes[market.marketId] || []
          ) {
            const price =
              prices[outcome.outcomeId];

            if (!price) continue;

            // odds below 1.10
            if (
              price.priceDecimal >=
              1.1
            ) continue;

            const selection = {
              price:
                price.priceDecimal,

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
                price.version,

              priceNum:
                price.numerator,

              priceDen:
                price.denominator,

              publicHubPublishedTime:
                price.publicHubPublishedTime ||
                null,

              serverEmopSource:
                price.emopSource || 1,
            };

            // duplicate prevention
            const betKey = [
              event.eventId,
              market.marketId,
              outcome.outcomeId,
              price.version,
            ].join(":");

            if (
              alreadyPlaced(betKey)
            ) {
              console.log(
                "⏭ Duplicate skipped:",
                betKey
              );

              continue;
            }

            console.log(
              "🎯 AI SIGNAL:",
              {
                match:
                  `${event.homeTeam} vs ${event.awayTeam}`,

                team:
                  outcome.name,

                odds:
                  price.priceDecimal,

                startsInMin:
                  Math.floor(
                    timeDiff / 60000
                  ),
              }
            );

            try {
              const result =
                await betway.placeBet(
                  selection,
                  risk
                );

              console.log(
                "✅ Bet placed:",
                {
                  betKey,
                  result,
                }
              );
            }

            catch (e) {
              console.error(
                "❌ Bet failed:",
                e.message
              );
            }
          }
        }
      }

      catch (e) {
        console.error(
          "AI loop error:",
          e.message
        );
      }

      setTimeout(loop, 5000);
    };

    loop();

    res.json({
      success: true,
      message: "AI started",
    });
  }

  catch (e) {
    res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

// ───────────────── OPTIONAL STOP AI ─────────────────
// added without changing frontend API

app.post("/ai/stop", (req, res) => {
  aiRunning = false;

  res.json({
    success: true,
    message: "AI stopped",
  });
});

// ───────────────── SERVER ─────────────────

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `🚀 Server running on port ${PORT}`
  );
});
