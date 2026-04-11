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
  }

  q(base, params) {
    const s = new URLSearchParams();
    for (const k in params)
      k === "marketTypes"
        ? params[k].forEach(v => s.append(k, v))
        : s.append(k, params[k]);
    return `${base}?${s}`;
  }

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

  getUpdates(custom = {}) {
    return this.fetch(this.q(this.urls.upcoming, { ...this.defaults, ...custom }));
  }

  async list(take = 10) {
    const d = await this.getUpdates({ Take: take });
    const pm = Object.fromEntries((d.prices || []).map(p => [p.outcomeId, p.priceDecimal]));
    const om = (d.outcomes || []).reduce((a, o) => ((a[o.marketId] ??= []).push(o), a), {});

    return (d.markets || [])
      .filter(m => ["win-draw-win", "Win/Draw/Win", "1X2"].includes(m.marketTypeCName))
      .map(m => {
        const e = (d.events || []).find(x => x.eventId === m.eventId);
        if (!e) return;

        let win, draw, loss;
        (om[m.marketId] || []).forEach(o => {
          const v = pm[o.outcomeId];
          o.name === "Draw" ? draw = v : o.name === e.homeTeam ? win = v : loss = v;
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

  liveStream(options = {}) {
    const listeners = { message: [], error: [], open: [], close: [] };
    const emit = (t, d) => listeners[t].forEach(f => f(d));
    const interval = options.interval || 3000;

    const poll = async () => {
      try {
        const data = await this.fetch(this.q(this.urls.live, { ...this.defaults, ...options }));
        emit("message", data);
      } catch (e) {
        emit("error", e);
      }
    };

    emit("open");
    const timer = setInterval(poll, interval);
    poll();

    return {
      on: (e, fn) => listeners[e]?.push(fn),
      close: () => (clearInterval(timer), emit("close"))
    };
  }
}

module.exports = BetwayAPI;
