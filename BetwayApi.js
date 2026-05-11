class BetwayAPI {
  constructor(options = {}) {
    this.urls = {
      live: "https://feeds-roa2.betwayafrica.com/br/_apis/sport/v1/BetBook/LiveInPlay/",
      auth: "https://www.betway.com.ng/appsynapse/auth/users/authenticate",
      strike: "https://www.betway.com.ng/appsynapse/bet-api-sr02/v2/Betting/Strike",
      upcoming: "https://feeds-roa2.betwayafrica.com/br/_apis/sport/v1/BetBook/Upcoming/",
      balance: "https://www.betway.com.ng/appsynapse/auth/users/accountbalance",
    };

    this.defaults = {
      countryCode: "NG",
      sportId: "soccer",
      Skip: 0,
      Take: 20,
      cultureCode: "en-US",
      isEsport: false,
      boostedOnly: false,
      marketTypes: ["[Win/Draw/Win]"],
      ...options,
    };

    this.cache = new Map();
    this.ttl = 5000;

    this.validMarkets = new Set([
      "win-draw-win",
      "Win/Draw/Win",
      "1X2",
    ]);

    this.accessToken = null;
    this.refreshToken = null;
  }

  // ───────────────── UTILITIES ─────────────────

  _uuid() {
    return globalThis.crypto?.randomUUID?.()
      || Math.random().toString(36).slice(2) + Date.now();
  }

  _decodeJWT(token = this.accessToken) {
    try {
      const b64 = token.split(".")[1]
        .replace(/-/g, "+")
        .replace(/_/g, "/");

      const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);

      return JSON.parse(
        typeof atob !== "undefined"
          ? atob(padded)
          : Buffer.from(padded, "base64").toString("utf8")
      );
    } catch {
      return {};
    }
  }

_qs(base, params = {}) {
  const s = new URLSearchParams();

  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;

    if (Array.isArray(v)) {
      for (const x of v) {
        s.append(k, x);
      }
    }

    else if (typeof v === "boolean") {
      s.append(k, String(v));
    }

    else {
      s.append(k, v);
    }
  }

  return `${base}?${s}`;
}


  _headers(extra = {}) {
    return {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Origin": "https://www.betway.com.ng",
      "User-Agent": "Mozilla/5.0",
      ...(this.accessToken && {
        Authorization: `Bearer ${this.accessToken}`,
      }),
      ...extra,
    };
  }

  async _request(url, options = {}) {
    const {
      method = "GET",
      body,
      headers = {},
      ttl = this.ttl,
      timeout = 15000,
      retries = 1,
      useCache = method === "GET",
    } = options;

    const cacheKey = method + url + (body || "");

    if (useCache) {
      const cached = this.cache.get(cacheKey);

      if (cached && Date.now() - cached.time < ttl) {
        return cached.data;
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      let lastError;

      for (let i = 0; i <= retries; i++) {
        try {
          const res = await fetch(url, {
            method,
            headers: this._headers(headers),
            body,
            signal: controller.signal,
          });

          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            throw new Error(`HTTP ${res.status}: ${txt}`);
          }

          const type = res.headers.get("content-type") || "";

          const data = type.includes("application/json")
            ? await res.json()
            : await res.text();

          if (useCache) {
            this.cache.set(cacheKey, {
              data,
              time: Date.now(),
            });
          }

          return data;
        } catch (e) {
          lastError = e;
          if (i < retries) {
            await new Promise(r => setTimeout(r, 500 * (i + 1)));
          }
        }
      }

      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  _buildIndexes(data = {}) {
    return {
      prices: Object.fromEntries(
        (data.prices || []).map(x => [x.outcomeId, x])
      ),

      outcomes: Object.fromEntries(
        (data.outcomes || []).map(x => [x.outcomeId, x])
      ),

      markets: Object.fromEntries(
        (data.markets || []).map(x => [x.marketId, x])
      ),

      events: Object.fromEntries(
        (data.events || []).map(x => [x.eventId, x])
      ),

      scores: Object.fromEntries(
        (data.scores || []).map(x => [x.eventId, x])
      ),
    };
  }

  _selection(event, market, outcome, priceObj) {
    return {
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

      publicHubPublishedTime:
        priceObj.publicHubPublishedTime || null,

      serverEmopSource:
        priceObj.emopSource || 1,
    };
  }

  // ───────────────── AUTH ─────────────────

  async login(username, password) {
    const data = await this._request(this.urls.auth, {
      method: "POST",
      useCache: false,
      body: JSON.stringify({
        username,
        password,
        countryCode: this.defaults.countryCode,
        sessionMetadata: {},
      }),
    });

    if (!data?.access_token) {
      throw new Error("Invalid login response");
    }

    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token || null;

    return data;
  }

  logout() {
    this.accessToken = null;
    this.refreshToken = null;
  }

  _getBrandId() {
    return this._decodeJWT()?.[
      "http://schemas.ragingriver.io/ws/2021/05/identity/claims/brand"
    ] || "f8a8d16a-d619-4b49-aa8c-f21211403c92";
  }

  // ───────────────── LIVE DATA ─────────────────

  async getLiveData(take = this.defaults.Take) {
    return this._request(
      this._qs(this.urls.live, {
        ...this.defaults,
        Take: take,
      })
    );
  }

  getBestSelection(data, eventId = null) {
    const idx = this._buildIndexes(data);

    let best = null;

    for (const outcome of Object.values(idx.outcomes)) {
      if (eventId && outcome.eventId !== eventId) continue;

      const priceObj = idx.prices[outcome.outcomeId];
      const market = idx.markets[outcome.marketId];
      const event = idx.events[outcome.eventId];

      if (
        !priceObj ||
        !market ||
        !event ||
        priceObj.priceDecimal == null
      ) continue;

      const sel = this._selection(
        event,
        market,
        outcome,
        priceObj
      );

      if (!best || sel.price < best.price) {
        best = sel;
      }
    }

    return best;
  }

  // ───────────────── BETTING ─────────────────

  _buildBetPayload(selection, wagerAmount = 100) {
    return {
      currencyCode:
        this.defaults.countryCode === "NG"
          ? "NGN"
          : "USD",

      countryCode: this.defaults.countryCode,

      betRequests: [{
        requestId: this._uuid(),
        paymentType: 1,
        betSelectionType: "Normal",
        numberOfLines: 1,
        acceptPriceChange: "None",
        isEachWay: false,
        channel: "web",
        handicap: 0,
        priceNum: selection.priceNum,
        priceDen: selection.priceDen,
        referringBookingCode: "",
        wagerAmount,

        bets: [{
          priceType: "Normal",
          handicap: 0,
          priceDen: selection.priceDen,
          priceNum: selection.priceNum,
          priceDec: selection.price,

          isEachWayActive: false,

          eventId: selection.eventId,
          marketId: selection.marketId,
          displayMarketId: selection.marketId,
          outcomeId: [selection.outcomeId],

          eventVersion: selection.eventVersion,
          marketVersion: selection.marketVersion,
          outcomeVersion: selection.outcomeVersion,
          priceVersion: selection.priceVersion,

          serverEmopSource:
            selection.serverEmopSource,

          publicHubPublishedTime:
            selection.publicHubPublishedTime,
        }],
      }],
    };
  }

  async _placeBetPayload(payload) {
    if (!this.accessToken) {
      throw new Error("Not authenticated");
    }

    return this._request(this.urls.strike, {
      method: "POST",
      useCache: false,
      headers: {
        "X-Brand-Id": this._getBrandId(),
      },
      body: JSON.stringify(payload),
    });
  }

  async placeBet(selection, wagerAmount = 100) {
    return this._placeBetPayload(
      this._buildBetPayload(selection, wagerAmount)
    );
  }

  async placeBetWithId(amount = 100, betID) {
    const data = await this.getLiveData(100);
    const idx = this._buildIndexes(data);

    let selection;

    if (typeof betID === "string") {
      selection = this.getBestSelection(data, betID);

      if (!selection) {
        throw new Error(
          `No valid selection for event ${betID}`
        );
      }
    }

    else if (
      betID &&
      typeof betID === "object" &&
      !Array.isArray(betID)
    ) {
      const {
        eventId,
        marketId,
        outcomeId,
      } = betID;

      const event = idx.events[eventId];
      const market = idx.markets[marketId];
      const outcome = idx.outcomes[outcomeId];
      const priceObj = idx.prices[outcomeId];

      if (!event || !market || !outcome || !priceObj) {
        throw new Error("Bet selection not found");
      }

      selection = this._selection(
        event,
        market,
        outcome,
        priceObj
      );
    }

    else {
      throw new Error(
        "betID must be eventId string or object"
      );
    }

    return this.placeBet(selection, amount);
  }

  // ───────────────── ACCOUNT ─────────────────

  async getAccountBalance(userId = null) {
    if (!this.accessToken) {
      throw new Error("Not authenticated");
    }

    userId ||= this._decodeJWT()?.[
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"
    ];

    if (!userId) {
      throw new Error("UserId not found");
    }

    return this._request(
      this._qs(this.urls.balance, {
        t: 3,
        v: 2,
        nogeoredirect: 1,
        userId,
      })
    );
  }

  // ───────────────── LIST ─────────────────

  async list(take = 10) {
    const raw = await this.getLiveData(take);

    const prices = Object.fromEntries(
      (raw.prices || []).map(p => [
        p.outcomeId,
        p.priceDecimal,
      ])
    );

    const outcomes = (raw.outcomes || []).reduce((a, o) => {
      (a[o.marketId] ??= []).push(o);
      return a;
    }, {});

    const events = Object.fromEntries(
      (raw.events || []).map(e => [e.eventId, e])
    );

    return (raw.markets || [])
      .filter(m =>
        this.validMarkets.has(m.marketTypeCName)
      )

      .map(m => {
        const e = events[m.eventId];
        if (!e) return null;

        let win = null,
            draw = null,
            loss = null;

        for (const o of outcomes[m.marketId] || []) {
          const v = prices[o.outcomeId];
          if (!v) continue;

          if (o.name === "Draw") {
            draw = v;
          }

          else if (o.name === e.homeTeam) {
            win = v;
          }

          else if (o.name === e.awayTeam) {
            loss = v;
          }
        }

        return {
          id: e.eventId,
          match: `${e.homeTeam} vs ${e.awayTeam}`,
          win,
          draw,
          loss,

          datetime: new Date(
            e.expectedStartEpoch < 1e12
              ? e.expectedStartEpoch * 1000
              : e.expectedStartEpoch
          ),
        };
      })

      .filter(Boolean);
  }

  // ───────────────── LIVE STREAM ─────────────────

  liveStream(options = {}) {
    const listeners = {
      open: [],
      close: [],
      error: [],
      message: [],
    };

    const emit = (t, d) =>
      listeners[t].forEach(fn => fn(d));

    const interval = options.interval || 3000;

    let closed = false;

    const loop = async () => {
      emit("open");

      while (!closed) {
        try {
          const raw = await this.getLiveData(
            this.defaults.Take
          );

          emit(
            "message",
            this.transformLiveData(raw)
          );
        }

        catch (e) {
          emit("error", e);
        }

        await new Promise(r =>
          setTimeout(r, interval)
        );
      }

      emit("close");
    };

    loop();

    return {
      on: (e, fn) => {
        listeners[e]?.push(fn);
        return this;
      },

      close: () => {
        closed = true;
      },
    };
  }

  // ───────────────── TRANSFORM ─────────────────

  transformLiveData(raw) {
    const prices = Object.fromEntries(
      (raw.prices || []).map(p => [
        p.outcomeId,
        p.priceDecimal,
      ])
    );

    const outcomes = (raw.outcomes || []).reduce((a, o) => {
      (a[o.marketId] ??= []).push(o);
      return a;
    }, {});

    const events = Object.fromEntries(
      (raw.events || []).map(e => [e.eventId, e])
    );

    const scores = Object.fromEntries(
      (raw.scores || []).map(s => [s.eventId, s])
    );

    const prob = o => o ? 1 / o : null;

    const map = new Map();

    for (const m of raw.markets || []) {
      if (!this.validMarkets.has(m.marketTypeCName)) {
        continue;
      }

      const e = events[m.eventId];
      if (!e) continue;

      let homeOdds = null,
          drawOdds = null,
          awayOdds = null;

      for (const o of outcomes[m.marketId] || []) {
        const v = prices[o.outcomeId];
        if (!v) continue;

        if (o.name === "Draw") {
          drawOdds = v;
        }

        else if (o.name === e.homeTeam) {
          homeOdds = v;
        }

        else if (o.name === e.awayTeam) {
          awayOdds = v;
        }
      }

      const s = scores[e.eventId] || {};

      const item = {
        id: e.eventId,
        match: `${e.homeTeam} vs ${e.awayTeam}`,

        homeTeam: e.homeTeam,
        awayTeam: e.awayTeam,

        homeScore:
          s.score?.[0] != null
            ? +s.score[0]
            : null,

        awayScore:
          s.score?.[1] != null
            ? +s.score[1]
            : null,

        state: s.state || null,
        minute: s.time || null,

        isLive: !!e.isLive,
        isFinished: !!e.isFinished,

        status:
          e.isFinished
            ? "FINISHED"
            : s.state === "Halftime"
            ? "HALF_TIME"
            : e.isLive
            ? "LIVE"
            : "NOT_STARTED",

        startTime: e.expectedStartEpoch
          ? new Date(
              e.expectedStartEpoch < 1e12
                ? e.expectedStartEpoch * 1000
                : e.expectedStartEpoch
            )
          : null,

        homeOdds,
        drawOdds,
        awayOdds,

        homeProb: prob(homeOdds),
        drawProb: prob(drawOdds),
        awayProb: prob(awayOdds),
      };

      if (
        item.homeOdds != null ||
        item.drawOdds != null ||
        item.awayOdds != null
      ) {
        map.set(e.eventId, item);
      }
    }

    return [...map.values()];
  }
}

export default BetwayAPI;
