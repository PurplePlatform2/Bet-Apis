import express from "express";
import cors from "cors";
import http from "http";
import BetwayAPI from "./BetwayApi.js";
import { spawn } from "child_process";


const app = express();

app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

const betway = new BetwayAPI();

// ───────────────── DEMO LOGIN ─────────────────

const DEMO_USERNAME = "08109995000";
const DEMO_PASSWORD = "password";

// ───────────────── LIVE STATE ─────────────────

let latestLiveData = null;
let lastUpdate = null;

let stream = null;
let liveClients = 0;

// ───────────────── AI STATE ─────────────────

let aiRunning = false;
let aiLoop = null;
let aiLastRun = null;
let liverProc=null;
const placedBets = new Set();
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
    liveClients,
    lastLiveUpdate: lastUpdate,
    lastAIExecution: aiLastRun,
    activeTrackedBets: placedBets.size,
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
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

    res.json({
      success: true,
      message: "Login successful",
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

// ───────────────── MATCHES ─────────────────

app.get("/matches", async (req, res) => {
  try {
    const take =
      parseInt(req.query.take) || 100;

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

// ───────────────── BALANCE ─────────────────

app.get("/balance", async (req, res) => {
  try {
    const data =
      await betway.getAccountBalance(
        req.query.userId || null
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

// ───────────────── LIVE STREAM ─────────────────

function startLiveStream() {
  if (stream) return;

  console.log("📡 Starting live polling...");

  stream = betway.liveStream({
    interval: 3000
  });

  stream.on("message", data => {
    latestLiveData = data;
    lastUpdate = Date.now();
  });

  stream.on("error", err => {
    console.error(
      "❌ Live stream error:",
      err.message
    );
  });

  stream.on("close", () => {
    console.log("📴 Live stream closed");
    stream = null;
  });
}

function stopLiveStream() {
  if (!stream) return;

  console.log("🛑 Stopping live polling...");

  stream.close();

  stream = null;
}

// ───────────────── LIVE ENDPOINT ─────────────────

app.get("/live", (req, res) => {
  liveClients++;

  if (!stream) {
    startLiveStream();
  }

  req.on("close", () => {
    liveClients--;

    if (liveClients <= 0) {
      liveClients = 0;
      stopLiveStream();
    }
  });

  res.json({
    success: true,
    lastUpdate,
    data: latestLiveData
  });
});


// ───────────────── AI LOOP ─────────────────

async function runAI(username, password, risk = 100) {
  console.log(
    "🤖 AI started... ##Attempting Login-->"
  );

  if (aiRunning) return;

  aiRunning = true;
  aiLastRun = Date.now();

  liverProc = spawn("./liver", {
    stdio: "inherit"
  });

  liverProc.on("error", err => {
    console.error(
      "❌ liver failed:",
      err.message
    );

    aiRunning = false;
    liverProc = null;
  });

  liverProc.on("exit", code => {
    console.log(
      "📴 liver exited:",
      code
    );

    aiRunning = false;
    liverProc = null;
  });
}
  

// ───────────────── START AI ─────────────────

app.post("/ai", async (req, res) => {
  try {
    const {
      username,
      password,
      risk = 100
    } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error:
          "username and password required"
      });
    }

    if (aiRunning) {
      return res.json({
        success: false,
        message: "AI already running"
      });
    }

    await runAI(
      username,
      password,
      risk
    );

    res.json({
      success: true,
      message: "AI started"
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
  }

  aiLoop = null;

  if (liverProc) {
    liverProc.kill("SIGTERM");
    liverProc = null;
  }

  res.json({
    success: true,
    message: "AI stopped"
  });
});

// ───────────────── AUTO START ─────────────────

server.listen(PORT, async () => {
  console.log(
    `🚀 Server running on port ${PORT}`
  );

  try {
    console.log(
      "🔐 Auto login starting..."
    );

    await runAI( DEMO_USERNAME, DEMO_PASSWORD,100  );

    console.log("🤖 AI auto-started"  );  }

  catch (e) {
    console.error(
      "❌ Auto start failed:",
      e.message
    );
  }
});
