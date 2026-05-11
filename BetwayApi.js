class BetwayAPI {
  constructor(options = {}) {
    this.urls = {
      upcoming:
        "https://feeds-roa2.betwayafrica.com/br/_apis/sport/v1/BetBook/Upcoming/",

      live:
        "https://feeds-roa2.betwayafrica.com/br/_apis/sport/v1/BetBook/LiveInPlay/",

      auth:
        "https://www.betway.com.ng/appsynapse/auth/users/authenticate",

      strike:
        "https://www.betway.com.ng/appsynapse/bet-api-sr02/v2/Betting/Strike",

      balance:
        "https://www.betway.com.ng/appsynapse/auth/users/accountbalance",

      booking:
        "wss://streams.betwayafrica.com/ws?access_token=..."
    };

    this.defaults = {
      countryCode: "NG",
      sportId: "soccer",
      Skip: 0,
      Take: 20,
      cultureCode: "en-US",
      isEsport: false,
      boostedOnly: false,

      marketTypes: [
        "[Win/Draw/Win]",
        "1X2 (1Up)",
        "1X2 (2Up)",
        "[Double Chance]"
      ],

      ...options
    };

    this.cache = new Map();

    this.ttl = 5000;

    this.validMarkets = new Set([
      "win-draw-win",
      "Win/Draw/Win",
      "1X2"
    ]);

    this.accessToken = null;
    this.refreshToken = null;
  }

  // ───────────────── HELPERS ─────────────────

  _uuid() {
    return globalThis.crypto?.randomUUID?.()
      || Math.random().toString(36).slice(2)
      + Date.now();
  }

  _decodeJWT(token = this.accessToken) {
    try {
      const b64 = token.split(".")[1]
        .replace(/-/g, "+")
        .replace(/_/g, "/");

      const padded =
        b64 + "=".repeat(
          (4 - b64.length % 4) % 4
        );

      return JSON.parse(
        typeof atob !== "undefined"
          ? atob(padded)
          : Buffer.from(
              padded,
              "base64"
            ).toString("utf8")
      );
    }

    catch {
      return {};
    }
  }

  _getBrandId() {
    return this._decodeJWT()?.[
      "http://schemas.ragingriver.io/ws/2021/05/identity/claims/brand"
    ] || "f8a8d16a-d619-4b49-aa8c-f21211403c92";
  }

  // ───────────────── QUERY ─────────────────

  q(base, params) {
    const s = new URLSearchParams();

    Object.entries(params).forEach(([k, v]) => {
      if (v == null) return;

      if (Array.isArray(v)) {
        v.forEach(x => s.append(k, x));
      }

      else {
        s.append(k, v);
      }
    });

    return `${base}?${s}`;
  }

  // ───────────────── FETCH ─────────────────

  async fetch(url, options = {}) {
    const {
      method = "GET",
      body,
      headers = {},
      timeout = 15000,
      retries = 1,
      useCache = method === "GET"
    } = options;

    const cacheKey =
      method + url + (body || "");

    if (useCache) {
      const c = this.cache.get(cacheKey);

      if (c && Date.now() - c.t < this.ttl) {
        return c.d;
      }
    }

    const controller =
      new AbortController();

    const timer = setTimeout(() => {
      controller.abort();
    }, timeout);

    try {
      let lastError;

      for (let i = 0; i <= retries; i++) {
        try {
          const finalHeaders = {
            "User-Agent": "Mozilla/5.0",

            "Accept": "application/json",

            "Origin":
              "https://www.betway.com.ng",

            ...(this.accessToken && {
              Authorization:
                `Bearer ${this.accessToken}`
            }),

            ...headers
          };

          const res = await fetch(url, {
            method,
            headers: finalHeaders,
            body,
            signal: controller.signal
          });

          if (!res.ok) {
            const txt =
              await res.text().catch(() => "");

            throw new Error(
              `HTTP ${res.status}: ${txt}`
            );
          }

          const type =
            res.headers.get("content-type")
            || "";

          const data =
            type.includes("application/json")
              ? await res.json()
              : await res.text();

          if (useCache) {
            this.cache.set(cacheKey, {
              d: data,
              t: Date.now()
            });
          }

          return data;
        }

        catch (e) {
          lastError = e;

          if (i < retries) {
            await new Promise(r =>
              setTimeout(r, 500 * (i + 1))
            );
          }
        }
      }

      throw lastError;
    }

    finally {
      clearTimeout(timer);
    }
  }

  // ───────────────── AUTH ─────────────────

  async login(
    username,
    password,
    sessionMetadata = {}
  ) {
    const body = JSON.stringify({
      username,
      password,

      countryCode:
        this.defaults.countryCode,

      sessionMetadata
    });

    const data = await this.fetch(
      this.urls.auth,
      {
        method: "POST",

        useCache: false,

        headers: {
          "Content-Type":
            "application/json"
        },

        body
      }
    );

    if (!data?.access_token) {
      throw new Error(
        "Invalid login response"
      );
    }

    this.accessToken =
      data.access_token;

    this.refreshToken =
      data.refresh_token || null;

    return data;
  }

  logout() {
    this.accessToken = null;
    this.refreshToken = null;
  }

  // ───────────────── ACCOUNT ─────────────────

  async getAccountBalance(userId = null) {
    if (!this.accessToken) {
      throw new Error(
        "Not authenticated"
      );
    }

    userId ||= this._decodeJWT()?.[
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"
    ];

    if (!userId) {
      throw new Error(
        "UserId not found"
      );
    }

    return this.fetch(
      this.q(this.urls.balance, {
        t: 3,
        v: 2,
        nogeoredirect: 1,
        userId
      })
    );
  }

  // ───────────────── UPDATES ─────────────────

  getUpdates(custom = {}) {
    return this.fetch(
      this.q(
        this.urls.upcoming,
        {
          ...this.defaults,
          ...custom
        }
      )
    );
  }

  // ───────────────── LIST ─────────────────

  async list(take = 10) {
    const d = await this.getUpdates({
      Take: take
    });

    const price = Object.fromEntries(
      (d.prices || []).map(p => [
        p.outcomeId,
        p.priceDecimal
      ])
    );

    const outcomes =
      (d.outcomes || []).reduce(
        (a, o) => (
          (a[o.marketId] ??= []).push(o),
          a
        ),
        {}
      );

    const events =
      Object.fromEntries(
        (d.events || []).map(e => [
          e.eventId,
          e
        ])
      );

    return (d.markets || [])
      .filter(m =>
        this.validMarkets.has(
          m.marketTypeCName
        )
      )

      .map(m => {
        const e = events[m.eventId];

        if (!e) return;

        let win,
            draw,
            loss;

        (outcomes[m.marketId] || [])
          .forEach(o => {

          const v =
            price[o.outcomeId];

          if (!v) return;

          if (o.name === "Draw") {
            draw = v;
          }

          else if (
            o.name === e.homeTeam
          ) {
            win = v;
          }

          else if (
            o.name === e.awayTeam
          ) {
            loss = v;
          }
        });

        return {
          match:
            `${e.homeTeam} vs ${e.awayTeam}`,

          win,
          draw,
          loss,

          datetime:
            new Date(
              e.expectedStartEpoch < 1e12
                ? e.expectedStartEpoch * 1000
                : e.expectedStartEpoch
            ),

          id: e.eventId
        };
      })

      .filter(Boolean);
  }

  // ───────────────── LIVE STREAM ─────────────────

  liveStream(options = {}) {
    const listeners = {
      message: [],
      error: [],
      open: [],
      close: []
    };

    const emit = (t, d) =>
      listeners[t].forEach(
        f => f(d)
      );

    const interval =
      options.interval || 3000;

    let closed = false;

    const poll = async () => {
      try {
        const raw = await this.fetch(
          this.q(
            this.urls.live,
            {
              ...this.defaults,
              ...options
            }
          )
        );

        emit(
          "message",
          this.transformLiveData(raw)
        );
      }

      catch (e) {
        emit("error", e);
      }
    };

    emit("open");

    const loop = async () => {
      while (!closed) {
        await poll();

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
      }
    };
  }

  // ───────────────── TRANSFORM ─────────────────

  transformLiveData(raw) {
    const price = Object.fromEntries(
      (raw.prices || []).map(p => [
        p.outcomeId,
        p.priceDecimal
      ])
    );

    const outcomes =
      (raw.outcomes || []).reduce(
        (a, o) => (
          (a[o.marketId] ??= []).push(o),
          a
        ),
        {}
      );

    const events =
      Object.fromEntries(
        (raw.events || []).map(e => [
          e.eventId,
          e
        ])
      );

    const scores =
      Object.fromEntries(
        (raw.scores || []).map(s => [
          s.eventId,
          s
        ])
      );

    const prob = o =>
      o ? 1 / o : null;

    const map = new Map();

    (raw.markets || []).forEach(m => {

      if (
        !this.validMarkets.has(
          m.marketTypeCName
        )
      ) return;

      const e = events[m.eventId];

      if (!e) return;

      let homeOdds = null,
          drawOdds = null,
          awayOdds = null;

      (outcomes[m.marketId] || [])
        .forEach(o => {

        const v =
          price[o.outcomeId];

        if (!v) return;

        if (o.name === "Draw") {
          drawOdds = v;
        }

        else if (
          o.name === e.homeTeam
        ) {
          homeOdds = v;
        }

        else if (
          o.name === e.awayTeam
        ) {
          awayOdds = v;
        }
      });

      const s =
        scores[e.eventId] ?? {};

      const homeScore =
        s.score?.[0] != null
          ? +s.score[0]
          : null;

      const awayScore =
        s.score?.[1] != null
          ? +s.score[1]
          : null;

      const state =
        s.state || null;

      const minute =
        s.time || null;

      let status =
        "NOT_STARTED";

      if (e.isFinished) {
        status = "FINISHED";
      }

      else if (
        state === "Halftime"
      ) {
        status = "HALF_TIME";
      }

      else if (e.isLive) {
        status = "LIVE";
      }

      if (!map.has(e.eventId)) {
        map.set(e.eventId, {
          id: e.eventId,

          match:
            `${e.homeTeam} vs ${e.awayTeam}`,

          homeTeam:
            e.homeTeam,

          awayTeam:
            e.awayTeam,

          homeScore,
          awayScore,

          status,
          minute,
          state,

          isLive:
            !!e.isLive,

          isFinished:
            !!e.isFinished,

          startTime:
            e.expectedStartEpoch
              ? new Date(
                  e.expectedStartEpoch < 1e12
                    ? e.expectedStartEpoch * 1000
                    : e.expectedStartEpoch
                )
              : null,

          homeOdds,
          drawOdds,
          awayOdds,

          homeProb:
            prob(homeOdds),

          drawProb:
            prob(drawOdds),

          awayProb:
            prob(awayOdds)
        });
      }
    });

    return [...map.values()]
      .filter(e =>
        e.homeOdds != null
        || e.drawOdds != null
        || e.awayOdds != null
      );
  }

  // ───────────────── SAFE SELECTION ─────────────────

  buildSelection(
    raw,
    eventId,
    pick = "home"
  ) {
    const prices = Object.fromEntries(
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

    for (const market of raw.markets || []) {

      if (
        market.eventId !== eventId
      ) {
        continue;
      }

      if (
        !this.validMarkets.has(
          market.marketTypeCName
        )
      ) {
        continue;
      }

      const event =
        events[eventId];

      if (!event) continue;

      for (
        const outcome of
        outcomes[market.marketId] || []
      ) {

        let matched = false;

        if (
          pick === "draw"
          && outcome.name === "Draw"
        ) {
          matched = true;
        }

        else if (
          pick === "home"
          && outcome.name === event.homeTeam
        ) {
          matched = true;
        }

        else if (
          pick === "away"
          && outcome.name === event.awayTeam
        ) {
          matched = true;
        }

        if (!matched) {
          continue;
        }

        const priceObj =
          prices[outcome.outcomeId];

        if (!priceObj) {
          continue;
        }

        return {
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
      }
    }

    return null;
  }

  // ───────────────── BET PAYLOAD ─────────────────

  _buildBetPayload(
    selection,
    wagerAmount = 100
  ) {
    return {
      currencyCode: "NGN",

      countryCode:
        this.defaults.countryCode,

      betRequests: [{
        requestId:
          this._uuid(),

        paymentType: 1,

        betSelectionType:
          "Normal",

        numberOfLines: 1,

        acceptPriceChange:
          "None",

        isEachWay: false,

        channel: "web",

        handicap: 0,

        priceNum:
          selection.priceNum,

        priceDen:
          selection.priceDen,

        referringBookingCode: "",

        wagerAmount,

        bets: [{
          priceType: "Normal",

          handicap: 0,

          priceDen:
            selection.priceDen,

          priceNum:
            selection.priceNum,

          priceDec:
            selection.price,

          isEachWayActive: false,

          eventId:
            selection.eventId,

          marketId:
            selection.marketId,

          displayMarketId:
            selection.marketId,

          outcomeId: [
            selection.outcomeId
          ],

          eventVersion:
            selection.eventVersion,

          marketVersion:
            selection.marketVersion,

          outcomeVersion:
            selection.outcomeVersion,

          priceVersion:
            selection.priceVersion,

          serverEmopSource:
            selection.serverEmopSource,

          publicHubPublishedTime:
            selection.publicHubPublishedTime
        }]
      }]
    };
  }

  // ───────────────── STRIKE ─────────────────

  async _placeBetPayload(payload) {
    if (!this.accessToken) {
      throw new Error(
        "Not authenticated"
      );
    }

    return this.fetch(
      this.urls.strike,
      {
        method: "POST",

        useCache: false,

        headers: {
          "Content-Type":
            "application/json",

          "X-Brand-Id":
            this._getBrandId()
        },

        body:
          JSON.stringify(payload)
      }
    );
  }

  async placeBet(
    selection,
    wagerAmount = 100
  ) {
    return this._placeBetPayload(
      this._buildBetPayload(
        selection,
        wagerAmount
      )
    );
  }

  async placeBetWithId(
    amount = 100,
    eventId,
    pick = "home"
  ) {
    const raw =
      await this.getUpdates({
        Take: 100
      });

    const selection =
      this.buildSelection(
        raw,
        eventId,
        pick
      );

    if (!selection) {
      throw new Error(
        "Selection not found"
      );
    }

    return this.placeBet(
      selection,
      amount
    );
  }
}

export default BetwayAPI;
