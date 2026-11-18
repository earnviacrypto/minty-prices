// Market indexes, one pair per game category: the most valuable cards and the most valuable sealed products that
// actually trade, at TCGplayer market prices, each product weighing the same. Picked again on the 1st of each month and chain-linked (a product joining
// or leaving never makes the index jump). Each index starts at 1,000 on its first day.
// "Actually trades" = its market price changed on at least `bar` of the last 90 days (fewer while the history is young):
// a price that sits still for months is a listing nobody buys, and would skew the index. The bar is 20 days for busy
// games; a quieter game gets 10 or 5, whichever gives it the bigger index (the stricter bar when both give the same).
const IX_VERSION = 3; // 3: members (ids) listed, for the deal finder
// 2: the trading bar adapts to each game (quiet games get an index too); equal weight
const DAY_MS = 864e5;

// Size of an index from how many products qualify today (small games get smaller indexes; too few = no index).
function sizeFor(kind, eligible) {
  const steps = kind === 'card' ? [[400, 100], [150, 50], [30, 20]] : [[150, 50], [40, 15], [15, 10]];
  for (const [need, n] of steps) if (eligible >= need) return n;
  return 0;
}
// Daily price of each product in cents (the highest of its printings), filled forward over days with no price.
// Stored from the product's first day only, to keep memory near the history's own size.
function dailyPrices(hist, days) {
  const by = new Map();
  for (const [k, s] of hist.series) {
    const id = +k.split('|')[0], p = by.get(id);
    if (!p) by.set(id, { g: s.g, base: s.base, parts: [s] }); else { p.parts.push(s); p.base = Math.min(p.base, s.base); }
  }
  for (const p of by.values()) {
    const a = new Uint32Array(Math.max(0, days - p.base));
    for (const s of p.parts) for (let i = 0; i < s.a.length; i++) { const d = s.base + i - p.base, v = s.a[i]; if (v && d < a.length && v > a[d]) a[d] = v; }
    let last = 0; for (let d = 0; d < a.length; d++) { if (a[d]) last = a[d]; else a[d] = last; }
    p.a = a; delete p.parts;
  }
  return by;
}
const at = (p, d) => d < p.base ? 0 : p.a[d - p.base] || 0;
const BARS = [20, 10, 5];
function trades(p, d, bar) {
  if (!(at(p, d) > 0) || (d >= 30 && !(at(p, d - 30) > 0))) return false;
  let mv = 0; for (let i = Math.max(1, d - 89, p.base + 1); i <= d; i++) if (at(p, i) !== at(p, i - 1) && at(p, i - 1) > 0) mv++;
  return mv >= Math.min(bar, Math.max(3, Math.floor(d * 0.2)));
}
// One index. info: id → { kind: 'card' | 'sealed', name, g }. Returns null when the game has too few products.
function buildIndex(prices, info, kind, days, startIso) {
  const ids = [...prices.keys()].filter(id => info.has(id) && info.get(id).kind === kind);
  const last = days - 1;
  let n = 0, bar = BARS[0];
  for (const b of BARS) { const sz = sizeFor(kind, ids.filter(id => trades(prices.get(id), last, b)).length); if (sz > n) { n = sz; bar = b; } }
  if (!n || days < 2) return null;
  const vals = new Array(days).fill(null);
  let cons = null, base = [], level = 1000, first = -1;
  for (let d = 0; d < days; d++) {
    const date = new Date(Date.parse(startIso + 'T12:00:00Z') + d * DAY_MS);
    if (!cons || date.getUTCDate() === 1) {
      const live = ids.filter(id => trades(prices.get(id), d, bar)).sort((a, b) => at(prices.get(b), d) - at(prices.get(a), d)).slice(0, n);
      if (live.length < n * 0.8) { if (cons) { /* keep the old pick */ } else continue; }
      else { if (cons) level = vals[d - 1]; cons = live; base = cons.map(id => at(prices.get(id), d)); if (first < 0) first = d; }
    }
    // equal weight: the average of each product's move since the month's pick (one $5,000 card cannot swing it alone)
    // and each move counts at most ×3 or ÷3 – a mistyped price on one card is not a market move
    const avg = cons.reduce((s, id, i) => s + Math.min(3, Math.max(1 / 3, at(prices.get(id), d) / base[i])), 0) / cons.length;
    vals[d] = Math.round(level * avg * 100) / 100;
  }
  if (first < 0) return null;
  const row = id => { const p = prices.get(id), x = info.get(id), now = at(p, last), was = at(p, last - 30); return { id, g: x.g, name: x.name, set: x.set, price: now / 100, ch: was > 0 && last - 30 >= first ? Math.round((now - was) / was * 1000) / 10 : null }; };
  const rows = cons.map(row).filter(r => r.ch !== null && r.ch !== 0).sort((a, b) => b.ch - a.ch);
  return { n, bar, first, ids: cons.slice(), values: vals.slice(first), up: rows.filter(r => r.ch > 0).slice(0, 5), down: rows.filter(r => r.ch < 0).reverse().slice(0, 5) };
}
// Both indexes of one category from its history and its product file (prices-<cat>.json).
function categoryIndexes(hist, productFile, startIso) {
  const info = new Map();
  const setName = new Map((productFile.groups || []).map(g => [String(g.groupId), g.name]));
  for (const [g, list] of Object.entries(productFile.products || {})) for (const p of list) info.set(p[0], { kind: p[5] ? 'card' : 'sealed', name: p[1], g: +g, set: setName.get(String(g)) || '' });
  const days = hist.days();
  const prices = dailyPrices(hist, days);
  return { days, cards: buildIndex(prices, info, 'card', days, startIso), sealed: buildIndex(prices, info, 'sealed', days, startIso) };
}
module.exports = { IX_VERSION, categoryIndexes, buildIndex, dailyPrices, sizeFor };
