class BetwayAPI {
  constructor(options = {}) {
    this.baseUrl = "https://feeds-roa2.betwayafrica.com/br/_apis/sport/v1/BetBook/Upcoming/";
    
    // 🔧 Default params (editable)
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
        "[Double Chance]",
        "1X2 (3Up)",
        "[Total Goals]",
        "1st Goal",
        "Booking 1X2",
        "Last Goal"
      ],
      ...options
    };
  }

  // 🔥 Build query string
  buildQuery(params) {
    const q = new URLSearchParams();

    for (const key in params) {
      if (key === "marketTypes") {
        params.marketTypes.forEach(v => q.append("marketTypes", v));
      } else {
        q.append(key, params[key]);
      }
    }

    return `${this.baseUrl}?${q.toString()}`;
  }

  // 📡 Fetch raw data
  async getUpdates(custom = {}) {
    const url = this.buildQuery({ ...this.defaults, ...custom });
    const res = await fetch(url);
    return res.json();
  }

  // ⚡ Format into clean match odds
  async list(take = 10) {
    const d = await this.getUpdates({ Take: take });

    const priceMap = Object.fromEntries(d.prices.map(p => [p.outcomeId, p.priceDecimal]));
    const outcomesMap = d.outcomes.reduce((a, o) => ((a[o.marketId] ??= []).push(o), a), {});

    return d.markets
      .filter(m => m.marketTypeCName === "win-draw-win")
      .map(m => {
        const e = d.events.find(e => e.eventId === m.eventId);
        let win, draw, loss;

        (outcomesMap[m.marketId] || []).forEach(o => {
          const v = priceMap[o.outcomeId];
          o.name === "Draw"
            ? (draw = v)
            : o.name === e.homeTeam
            ? (win = v)
            : (loss = v);
        });

        return {
          match: `${e.homeTeam} Vs ${e.awayTeam}`,
          win,
          draw,
          loss,
          datetime: new Date(e.expectedStartEpoch * 1000),
          Id: e.eventId
        };
      });
  }
}
