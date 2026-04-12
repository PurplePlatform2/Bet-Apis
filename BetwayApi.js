class BetwayAPI {
  constructor(options = {}) {
    this.urls = {
      upcoming: "https://feeds-roa2.betwayafrica.com/br/_apis/sport/v1/BetBook/Upcoming/",
      live: "https://feeds-roa2.betwayafrica.com/br/_apis/sport/v1/BetBook/LiveInPlay/"
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
  }

  // 🔗 build query
  q(base, params) {
    const s = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) =>
      k === "marketTypes" ? v.forEach(x => s.append(k, x)) : s.append(k, v)
    );
    return `${base}?${s}`;
  }

  // 🌐 fetch with cache
  async fetch(url) {
    const c = this.cache.get(url);
    if (c && Date.now() - c.t < this.ttl) return c.d;

    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
        "Origin": "https://betway.com"
      }
    });

    if (!r.ok) throw Error(`HTTP ${r.status}`);
    const d = await r.json();

    this.cache.set(url, { d, t: Date.now() });
    return d;
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
