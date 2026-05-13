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

// ───────────────── LIVE STATE ─────────────────

let latestLiveData = null;
let lastUpdate = null;

let stream = null;
let liveClients = 0;

// ───────────────── AI STATE ─────────────────

let aiRunning = false;
let aiLoop = null;
let aiLastRun = null;

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

async function runAI(username,password, risk = 100) {
  if (aiRunning) return; aiRunning = true;
console.log("🤖 AI started... ##Attempting Login-->");
//Login
try{const loginResults=  await betway.login( username,   password  );
 console.log(loginResults); } catch(e){ console.error(e);}

  

  const loop = async () => {
    if (!aiRunning) return;
    aiLastRun = Date.now();
    console.log(   "🤖 AI checking:",  aiLastRun);

  try {
  const now = Date.now();

  for (const game of await betway.list(50)) {    
  //API CHECK
      if(!game.id || (!game.win && !game.loss) || !game.datetime) continue;
    //  {console.error("Api error at checking a particular game:: ",game.match); continue;}
     
    //CHECKING PEVIOUS   BETS
    const key = `${game.id}:${game.datetime}`;
    if(placedBets.has(key))continue;
    const diff = new Date(game.datetime) - now;
    if(isNaN(diff)){console.error("DateTime conversion error"); continue;}
    

let matchVal=null;
    if (game.win <1.10 && game.win>1.0) matchVal="home";
    else if( game.loss <1.10 && game.loss>1.0) matchVal="away";
    else continue;
    console.log("\nPotential Oppurtunity📊", game.match, "\nODD:", Math.min(game.win,game.loss), "Time Left= ", diff);

      
    if (matchVal!=null &&  diff >=0 && diff <= 1800000) {
      try {
        const result = await betway.placeBetWithId(risk, game.id, matchVal);
        placedBets.add(key);
        console.log("⚡ BET PLACED:", game.match);
        console.log("API RESULT:: ", result);

      } catch (e) {
        console.error("❌ Bet failed:", e.message);
      }
    }
  }

  

} catch (e) {
  console.error("❌ AI loop error:", e.message);
}

aiLoop = setTimeout(loop, AI_INTERVAL);

};

loop();  
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
