class BetwayAPI {
  constructor(options = {}) {
    this.urls = {
      upcoming: "https://feeds-roa2.betwayafrica.com/br/_apis/sport/v1/BetBook/Upcoming/",
      live: "https://feeds-roa2.betwayafrica.com/br/_apis/sport/v1/BetBook/LiveInPlay/",
      auth: "https://www.betway.com.ng/appsynapse/auth/users/authenticate",
      balance: "https://www.betway.com.ng/appsynapse/auth/users/accountbalance",
      strike: "https://www.betway.com.ng/appsynapse/bet-api-sr02/v2/Betting/Strike",
      streams: "wss://streams.betwayafrica.com/ws?access_token=..."
    };

    this.defaults = {
      countryCode: "NG",
      sportId: "soccer",
      Skip: 0,
      Take: 20,
      cultureCode: "en-US",
      isEsport: false,
      boostedOnly: false,
      marketTypes: ["[Win/Draw/Win]", "1X2 (1Up)", "1X2 (2Up)", "[Double Chance]"],
      ...options
    };

    this.cache = new Map();
    this.ttl = 5000;
    this.validMarkets = new Set(["win-draw-win", "Win/Draw/Win", "1X2"]);

    // Authentication tokens
    this.accessToken = null;
    this.refreshToken = null;
  }

  // 🔗 build query
  q(base, params) {
    const s = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) =>
      k === "marketTypes" ? v.forEach(x => s.append(k, x)) : s.append(k, v)
    );
    return `${base}?${s}`;
  }

  // 🌐 fetch with cache (and optional auth)
  async fetch(url, options = {}) {
    const cacheKey = url + JSON.stringify(options);
    const c = this.cache.get(cacheKey);
    if (c && Date.now() - c.t < this.ttl) return c.d;

    const headers = {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json",
      "Origin": "https://betway.com",
      ...options.headers
    };

    // Add auth token if available
    if (this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`;
    }

    const res = await fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.body,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    this.cache.set(cacheKey, { d: data, t: Date.now() });
    return data;
  }

  // 🔐 Login – saves access_token and refresh_token
  async login(username, password, sessionMetadata = {}) {
    const body = JSON.stringify({
      username: username,
      password: password,
      countryCode: this.defaults.countryCode,
      sessionMetadata: sessionMetadata
    });

    const response = await fetch(this.urls.auth, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Origin": "https://betway.com.ng"
      },
      body: body
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Login failed (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    // Expected response: { access_token, refresh_token }
    if (!data.access_token || !data.refresh_token) {
      throw new Error("Invalid response: missing tokens");
    }

    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token;

    // Optional: store tokens for later use (e.g., localStorage)
    return {
      access_token: this.accessToken,
      refresh_token: this.refreshToken
    };
  }

  // 🚪 Logout – clear tokens
  logout() {
    this.accessToken = null;
    this.refreshToken = null;
  }

  // 💰 Get account balance
  // userId is optional; if not provided, tries to extract from accessToken (JWT) or uses the last known userId.
  async getAccountBalance(userId = null) {
    if (!this.accessToken) throw new Error("Not authenticated. Call login() first.");

    // If userId not provided, try to extract from JWT (nameidentifier claim)
    let targetUserId = userId;
    if (!targetUserId && this.accessToken) {
      try {
        const payload = JSON.parse(atob(this.accessToken.split('.')[1]));
        targetUserId = payload["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"];
      } catch (e) {
        throw new Error("Unable to extract userId from token. Please provide userId explicitly.");
      }
    }
    if (!targetUserId) throw new Error("userId is required.");

    const params = {
      t: 3,                   // timestamp? seems to be a version
      v: 2,                   // api version
      nogeoredirect: 1,
      userId: targetUserId
    };
    const url = this.q(this.urls.balance, params);
    const data = await this.fetch(url);
    return data; // { cashBalance, bonusBalance, ticketBalance, ... }
  }

  // 🎯 Place a bet
  // betRequest should contain:
  //   - selections: array of objects with eventId, marketId, outcomeId, price (decimal), priceVersion, etc.
  //   - wagerAmount: number
  //   - requestId: optional (will be generated if not provided)
  //   - acceptPriceChange: "None" | "Any" | "Upward" (default "None")
  //   - paymentType: 1 (default)
  //   - channel: "web" (default)
  async placeBet(betRequest) {
    if (!this.accessToken) throw new Error("Not authenticated. Call login() first.");

    const {
      selections,
      wagerAmount,
      requestId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2),
      acceptPriceChange = "None",
      paymentType = 1,
      channel = "web"
    } = betRequest;

    if (!selections || selections.length === 0) throw new Error("At least one selection required.");

    // Build bets array
    const bets = selections.map(sel => ({
      priceType: "Normal",
      handicap: sel.handicap ?? 0,
      priceDen: sel.priceDen,
      priceNum: sel.priceNum,
      priceDec: sel.priceDec,
      isEachWayActive: sel.isEachWayActive ?? false,
      eventId: sel.eventId,
      marketId: sel.marketId,
      displayMarketId: sel.marketId,
      outcomeId: [sel.outcomeId],
      eventVersion: sel.eventVersion,
      marketVersion: sel.marketVersion,
      outcomeVersion: sel.outcomeVersion,
      priceVersion: sel.priceVersion,
      serverEmopSource: sel.serverEmopSource ?? 1,
      publicHubPublishedTime: sel.publicHubPublishedTime
    }));

    const payload = {
      currencyCode: this.defaults.countryCode === "NG" ? "NGN" : "USD", // adjust as needed
      countryCode: this.defaults.countryCode,
      betRequests: [{
        requestId,
        paymentType,
        betSelectionType: "Normal",
        numberOfLines: 1,
        acceptPriceChange,
        isEachWay: false,
        channel,
        handicap: 0,
        priceNum: selections[0].priceNum, // main selection price (same for single)
        priceDen: selections[0].priceDen,
        referringBookingCode: "",
        wagerAmount,
        bets
      }]
    };

    const response = await fetch(this.urls.strike, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${this.accessToken}`,
        "Origin": "https://www.betway.com.ng",
        "X-Brand-Id": this.extractBrandIdFromToken() || "f8a8d16a-d619-4b49-aa8c-f21211403c92"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) throw new Error(`Place bet failed (${response.status})`);
    const data = await response.json();
    return data; // contains betResponses with success/error details
  }

  // Helper to extract brandId from accessToken (if needed)
  extractBrandIdFromToken() {
    if (!this.accessToken) return null;
    try {
      const payload = JSON.parse(atob(this.accessToken.split('.')[1]));
      return payload["http://schemas.ragingriver.io/ws/2021/05/identity/claims/brand"] || null;
    } catch {
      return null;
    }
  }

  // 📡 upcoming raw
  getUpdates(custom = {}) {
    return this.fetch(this.q(this.urls.upcoming, { ...this.defaults, ...custom }));
  }

  // 📋 simplified list
  async list(take = 10) {
    const d = await this.getUpdates({ Take: take });

    const price = Object.fromEntries((d.prices || []).map(p => [p.outcomeId, p.priceDecimal]));
    const outcomes = (d.outcomes || []).reduce((a, o) => ((a[o.marketId] ??= []).push(o), a), {});
    const events = Object.fromEntries((d.events || []).map(e => [e.eventId, e]));

    return (d.markets || [])
      .filter(m => this.validMarkets.has(m.marketTypeCName))
      .map(m => {
        const e = events[m.eventId];
        if (!e) return;

        let win, draw, loss;
        (outcomes[m.marketId] || []).forEach(o => {
          const v = price[o.outcomeId];
          if (!v) return;
          o.name === "Draw" ? draw = v :
          o.name === e.homeTeam ? win = v :
          loss = v;
        });

        return {
          match: `${e.homeTeam} vs ${e.awayTeam}`,
          win, draw, loss,
          datetime: new Date(e.expectedStartEpoch < 1e12 ? e.expectedStartEpoch * 1000 : e.expectedStartEpoch),
          id: e.eventId
        };
      })
      .filter(Boolean);
  }

  // 🔴 live polling stream
  liveStream(options = {}) {
    const listeners = { message: [], error: [], open: [], close: [] };
    const emit = (t, d) => listeners[t].forEach(f => f(d));
    const interval = options.interval || 3000;

    let closed = false, failCount = 0;

    const poll = async () => {
      try {
        const raw = await this.fetch(this.q(this.urls.live, { ...this.defaults, ...options }));
        failCount = 0;
        emit("message", this.transformLiveData(raw));
      } catch (e) {
        failCount++;
        emit("error", e);
      }
    };

    emit("open");
    const timer = setInterval(poll, interval);
    poll();

    return {
      on: (e, fn) => listeners[e]?.push(fn),
      close: () => {
        if (!closed) {
          clearInterval(timer);
          closed = true;
          emit("close");
        }
      }
    };
  }

  // 🧠 transform live data
  transformLiveData(raw) {
    const price = Object.fromEntries((raw.prices || []).map(p => [p.outcomeId, p.priceDecimal]));
    const outcomes = (raw.outcomes || []).reduce((a, o) => ((a[o.marketId] ??= []).push(o), a), {});
    const events = Object.fromEntries((raw.events || []).map(e => [e.eventId, e]));
    const scores = Object.fromEntries((raw.scores || []).map(s => [s.eventId, s]));

    const prob = o => o ? 1 / o : null;
    const map = new Map();

    (raw.markets || []).forEach(m => {
      if (!this.validMarkets.has(m.marketTypeCName)) return;

      const e = events[m.eventId];
      if (!e) return;

      let homeOdds = null, drawOdds = null, awayOdds = null;

      (outcomes[m.marketId] || []).forEach(o => {
        const v = price[o.outcomeId];
        if (!v) return;
        if (o.name === "Draw") drawOdds = v;
        else if (o.name === e.homeTeam) homeOdds = v;
        else if (o.name === e.awayTeam) awayOdds = v;
      });

      const s = scores[e.eventId] ?? {};
      const homeScore = s.score?.[0] != null ? +s.score[0] : null;
      const awayScore = s.score?.[1] != null ? +s.score[1] : null;
      const state = s.state || null;
      const minute = s.time || null;

      let status = "NOT_STARTED";
      if (e.isFinished) status = "FINISHED";
      else if (state === "Halftime") status = "HALF_TIME";
      else if (e.isLive) status = "LIVE";

      if (!map.has(e.eventId)) {
        map.set(e.eventId, {
          id: e.eventId,
          match: `${e.homeTeam} vs ${e.awayTeam}`,
          homeTeam: e.homeTeam,
          awayTeam: e.awayTeam,
          homeScore, awayScore,
          status, minute, state,
          isLive: !!e.isLive,
          isFinished: !!e.isFinished,
          startTime: e.expectedStartEpoch
            ? new Date(e.expectedStartEpoch < 1e12 ? e.expectedStartEpoch * 1000 : e.expectedStartEpoch)
            : null,
          homeOdds: null,
          drawOdds: null,
          awayOdds: null,
          homeProb: null,
          drawProb: null,
          awayProb: null
        });
      }

      const ev = map.get(e.eventId);
      if (homeOdds != null) { ev.homeOdds = homeOdds; ev.homeProb = prob(homeOdds); }
      if (drawOdds != null) { ev.drawOdds = drawOdds; ev.drawProb = prob(drawOdds); }
      if (awayOdds != null) { ev.awayOdds = awayOdds; ev.awayProb = prob(awayOdds); }
    });

    return [...map.values()].filter(e =>
      e.homeOdds != null || e.drawOdds != null || e.awayOdds != null
    );
  }
}

export default BetwayAPI;
