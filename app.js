import express from "express";
import BetwayAPI from "./BetwayApi.js";

const app = express();

// ✅ Use Render dynamic port
const PORT = process.env.PORT || 3000;

const betway = new BetwayAPI();

// Home route
app.get("/", (req, res) => {
  res.send("Betway API Server Running 🚀");
});

// Matches endpoint
app.get("/matches", async (req, res) => {
  try {
    const take = parseInt(req.query.take) || 100;

    const matches = await betway.list(take);

    res.json({
      success: true,
      count: matches.length,
      data: matches
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ✅ Bind to 0.0.0.0 (important for Render)
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
