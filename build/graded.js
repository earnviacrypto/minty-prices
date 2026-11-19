// Graded prices and population (Pokémon): PokeInvest's median of real completed sales at every grade of PSA, CGC, BGS,
// TAG, SGC and ACE, plus the PSA population report and CGC's total. Read here once and shared as prices/graded.json.gz,
// so no copy of Minty has to ask PokeInvest itself – the box on a card page shows at once, and PokeInvest gets one
// visitor instead of hundreds. Credit wherever it is shown: "Prices by PokeInvest" (their condition).
//
// Budget: PokeInvest allows 300 calls a day without a key; 270 are used (PI_DAILY overrides; PI_KEY, if ever set as a
// repository secret, is sent as a Bearer token). The work is done once a day (UTC), at the first hourly run.
// Which cards: every English Pokémon card (TCGplayer category 3) worth $20+, dearest first, up to 4,000.
//  - a card not read yet: search (1) + population (1, also gives the TCGplayer number that proves the match) + prices (1) + sales (1)
//  - a card read before: population + prices + sales (3), the dearest 500 every 7 days, the rest every 21 days
// Sales ("Recent sales" on a card page) are read in the same visit as the prices, and only the sales behind each
// price are kept (same grade, same window: 90 days, or a year when a grade sold rarely) – so the list and the
// prices above it always agree. eBay withholds its sale links; other platforms' links are kept.
//  - no match on PokeInvest: tried again after 30 days
const zlib = require('zlib');
const { GitHub, sleep } = require('./gh');

const CFG = { daily: 270, minMarket: 20, pool: 4000, top: 500, freshTop: 7, freshRest: 21, missRetry: 30, gap: 1500, cat: '3' };
const DAY = 86400000;
const PI_URL = 'https://www.pokeinvest.io/mcp';
const VERSION = 1;
const SALES_PER_GRADE = 25; // newest kept per grade (the price's own sale count is shown either way)

// ---- matching a TCGplayer card to its PokeInvest card (same rules as Minty's lib/sources2.js) ----
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&amp;/g, '&').replace(/[^a-z0-9]+/g, ' ').trim();
const flat = s => norm(s).replace(/ /g, '');
const piName = n => String(n || '').replace(/\s*\[.*?\]\s*/g, ' ').replace(/\s*\([^)]*\)/g, ' ').replace(/\s+-\s+[\w-]+(?:\/[\w-]+)?\s*$/, '').replace(/\s+/g, ' ').trim();
const piSet = s => String(s || '').replace(/^[A-Z0-9&.]+\s*[:\-–]\s*/i, '').trim();
function piCandidates(cards, it) {
  const want = flat(piName(it.name)), no = String(it.number || '').split('/')[0].replace(/^0+/, '');
  const set = flat(piSet(it.set));
  const vm = String(it.name + ' ' + (it.set || '')).match(/1st edition|shadowless/i), vflag = vm ? flat(vm[0]) : '';
  const hit = (cards || []).filter(c => {
    const m = String(c.name).match(/^(.*?)\s*#\s*([\w-]+)\s*$/); if (!m) return false;
    const br = (m[1].match(/\[(.*?)\]/) || [])[1];
    if (br ? flat(br) !== vflag : vflag !== '') return false;
    if (flat(m[1].replace(/\s*\[.*?\]\s*/g, ' ')) !== want) return false;
    if (no && m[2].replace(/^0+/, '') !== no) return false;
    if (/^chinese\b/i.test(c.set)) return false;
    const cs = flat(c.set); return !set || cs === set || cs.includes(set) || set.includes(cs);
  });
  const exact = hit.filter(c => flat(c.set) === set);
  return exact.length ? exact : hit;
}
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };
// get_card_prices + get_population → what Minty's Graded box shows (same shape as Minty's gradedFromPi)
function gradedFromPi(p, pop) {
  if (!p || p.error) return null;
  const grades = (p.graded || []).filter(r => num(r.median_usd) > 0 && r.sales > 0).map(r => ({ grader: String(r.grader).toUpperCase(), grade: String(r.grade), value: num(r.median_usd), sales: r.sales, days: r.window_days, low: num(r.low_usd), high: num(r.high_usd), newest: r.newest_sale ? r.newest_sale.date : null }));
  const u = p.ungraded || {};
  const P = (pop && pop.population) || null, ps = p.population || {};
  return { source: 'pokeinvest', url: p.page_url || '', name: p.name || '', raw: num(u.median_usd) > 0 ? { value: num(u.median_usd), sales: u.sales || 0, days: u.window_days } : null, grades,
    pop: P ? { psa: Object.fromEntries(Object.entries(P).filter(([k]) => /^psa_\d/.test(k)).map(([k, n]) => [k.slice(4).replace('_', '.'), n])), total: P.total, gem: pop.gem_rate_pct, updated: pop.psa_last_updated || ps.psa_last_updated || null, cgcTotal: ps.cgc_total || null }
      : ps.psa_total ? { psa: ps.psa_10 ? { 10: ps.psa_10 } : {}, total: ps.psa_total, gem: ps.psa_10 && ps.psa_total ? Math.round(ps.psa_10 / ps.psa_total * 10000) / 100 : null, updated: ps.psa_last_updated || null, cgcTotal: ps.cgc_total || null } : null };
}

// get_sales → the sales behind each price: [date, price, grader ('RAW' when ungraded), grade, platform, url|0]
function salesFrom(res, d) {
  if (!res || !Array.isArray(res.sales) || !d) return null;
  const now = Date.now(), win = new Map();
  if (d.raw) win.set('RAW|', d.raw.days || 90);
  for (const g of d.grades || []) win.set(g.grader + '|' + g.grade, g.days || 90);
  const per = {}, out = [];
  const rows = res.sales.map(x => {
    const graded = x.grader && !/^(raw|ungraded|none|null)$/i.test(String(x.grader));
    return { date: String(x.date || '').slice(0, 10), price: num(x.price_usd), gr: graded ? String(x.grader).toUpperCase() : 'RAW', g: graded ? String(x.grade == null ? '' : x.grade).replace(/\.0$/, '') : '', pf: String(x.platform || '').slice(0, 20), url: /^https:\/\//.test(x.url || '') ? String(x.url).slice(0, 300) : 0 };
  }).filter(x => x.price > 0 && /^\d{4}-\d\d-\d\d$/.test(x.date)).sort((a, b) => b.date.localeCompare(a.date));
  for (const x of rows) {
    const k = x.gr + '|' + x.g, days = win.get(k);
    if (!days) continue; // a grade with no price above: left out, so the two blocks never disagree
    if (now - Date.parse(x.date + 'T12:00:00Z') > (days + 1) * DAY) continue;
    if ((per[k] = (per[k] || 0) + 1) > SALES_PER_GRADE) continue;
    out.push([x.date, x.price, x.gr, x.g, x.pf, x.url]);
  }
  return out;
}
// The cards to keep: English Pokémon cards worth $20+, dearest first (highest TCGplayer market price of any printing).
function cardsFrom(pf) {
  const setName = new Map((pf.groups || []).map(g => [String(g.groupId), g.name]));
  const out = [];
  for (const [g, list] of Object.entries(pf.products || {})) {
    const pr = (pf.prices || {})[g] || {};
    for (const p of list) {
      if (!p[5]) continue; // cards only (sealed has no grades)
      const v = Object.values(pr[p[0]] || {}).filter(x => x > 0); if (!v.length) continue;
      const market = Math.max(...v); if (market < CFG.minMarket) continue;
      out.push({ id: String(p[0]), name: p[1], number: p[2] || '', set: setName.get(String(g)) || '', market });
    }
  }
  return out.sort((a, b) => b.market - a.market).slice(0, CFG.pool);
}
// Today's work, in order: cards never read (dearest first), then the most overdue.
function plan(cards, st, now) {
  const fresh = [], due = [];
  cards.forEach((c, i) => {
    const s = st.cards[c.id];
    if (!s) return fresh.push(c);
    if (s.miss) { if (now - s.at > CFG.missRetry * DAY) due.push([s.at, c]); return; }
    if (now - s.at > (i < CFG.top ? CFG.freshTop : CFG.freshRest) * DAY) due.push([s.at, c]);
  });
  return fresh.concat(due.sort((a, b) => a[0] - b[0]).map(x => x[1]));
}

class PokeInvest {
  constructor({ fetch, key, log }) { Object.assign(this, { fetch, key, log }); this.used = 0; }
  async call(tool, args) {
    this.used++;
    for (let t = 0; ; t++) {
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': 'MintyPrices/1.0 (+https://github.com/earnviacrypto/minty-prices)' };
      if (this.key) headers.authorization = 'Bearer ' + this.key;
      const r = await this.fetch(PI_URL, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: tool, arguments: args } }) });
      if (r.status === 429) { const e = new Error('PokeInvest daily limit reached'); e.limit = true; throw e; }
      if (r.status >= 500 && t < 2) { await sleep(10000); continue; }
      if (!r.ok) throw new Error('PokeInvest ' + r.status + ' ' + (await r.text()).slice(0, 200));
      let text = await r.text();
      if (/^\s*(event|data):/m.test(text)) text = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('');
      const j = JSON.parse(text);
      if (j.error) { const e = new Error('PokeInvest: ' + (j.error.message || 'error')); if (/limit|quota|too many/i.test(e.message)) e.limit = true; throw e; }
      const res = j.result;
      if (!res || res.isError) { const msg = (res && res.content && res.content[0] && res.content[0].text) || 'no answer'; const e = new Error('PokeInvest: ' + msg.slice(0, 200)); if (/limit|quota|too many/i.test(msg)) e.limit = true; throw e; }
      return res.structuredContent || JSON.parse((res.content && res.content[0] && res.content[0].text) || '{}');
    }
  }
}

// One card: find it (unless known), prove it by the TCGplayer number, read population and prices.
async function readCard(pi, c, known, gap) {
  let ids = known ? [known] : [];
  if (!ids.length) {
    const no = String(c.number || '').split('/')[0];
    const res = await pi.call('search_cards', { query: [piName(c.name), no, piSet(c.set)].filter(Boolean).join(' '), limit: 10 }); await sleep(gap);
    ids = piCandidates(res.cards || [], c).slice(0, 2).map(x => x.id);
    if (!ids.length) return { miss: true };
  }
  for (const id of ids) {
    const pop = await pi.call('get_population', { card: id }); await sleep(gap);
    if (pop && pop.tcgplayer_id && String(pop.tcgplayer_id) !== c.id) { if (known) return { miss: true }; continue; } // another printing
    if (!(pop && pop.tcgplayer_id) && ids.length > 1) continue; // two look alike and nothing proves which
    const p = await pi.call('get_card_prices', { card: id }); await sleep(gap);
    if (p && p.tcgplayer_id && String(p.tcgplayer_id) !== c.id) continue;
    const d = gradedFromPi(p, pop && pop.population ? pop : null);
    if (!d) return { miss: true };
    let s = null, limit = false;
    try { s = salesFrom(await pi.call('get_sales', { card: id, days: 365 }), d); await sleep(gap); }
    catch (e) { if (e.limit) limit = true; } // prices without the list is fine; the list never comes without its prices
    return { pi: id, d, s, limit };
  }
  return { miss: true };
}

async function runGraded(env = {}) {
  const log = env.log || ((...a) => console.log(new Date().toISOString().slice(11, 19), 'graded:', ...a));
  const fetchFn = env.fetch || fetch;
  const gh = env.gh || new GitHub({ repo: env.repo || process.env.GITHUB_REPOSITORY, token: env.token || process.env.GITHUB_TOKEN, fetch: fetchFn, log });
  const now = env.now || Date.now(), today = new Date(now).toISOString().slice(0, 10);
  const daily = env.daily || +process.env.PI_DAILY || CFG.daily, gap = env.gap ?? CFG.gap;
  const stBuf = await gh.download('state', 'graded-state.json');
  const st = stBuf ? JSON.parse(stBuf) : { day: null, used: 0, cards: {} };
  st.cards = st.cards || {};
  if (st.day === today && (st.used >= daily - 2 || st.idle)) { log('done for today'); return { skipped: true }; }
  if (st.day !== today) { st.day = today; st.used = 0; st.idle = false; }
  const pfBuf = await gh.download('prices', `prices-${CFG.cat}.json.gz`);
  if (!pfBuf) { log('no Pokémon price file yet'); return { skipped: true }; }
  const cards = cardsFrom(JSON.parse(zlib.gunzipSync(pfBuf)));
  const todo = plan(cards, st, now);
  const outBuf = await gh.download('prices', 'graded.json.gz');
  const out = outBuf ? JSON.parse(zlib.gunzipSync(outBuf)) : { v: VERSION, cards: {} };
  out.cards = out.cards || {};
  const pi = env.pi || new PokeInvest({ fetch: fetchFn, key: env.key ?? process.env.PI_KEY, log });
  let read = 0, missed = 0, lastError = null, n = 0;
  for (const c of todo) {
    n++;
    if (st.used + (st.cards[c.id] && st.cards[c.id].pi ? 3 : 4) > daily) break;
    const before = pi.used;
    let r;
    try { r = await readCard(pi, c, st.cards[c.id] && st.cards[c.id].pi, gap); }
    catch (e) { st.used += pi.used - before; lastError = e.message; log(c.name, e.message); if (e.limit) break; continue; }
    st.used += pi.used - before;
    if (r.miss) { st.cards[c.id] = { miss: 1, at: now }; delete out.cards[c.id]; missed++; continue; }
    st.cards[c.id] = { pi: r.pi, at: now };
    out.cards[c.id] = Object.assign({ at: new Date(now).toISOString().slice(0, 10), pi: r.pi, d: r.d }, r.s && r.s.length ? { s: r.s } : {});
    read++;
    if (r.limit) { lastError = 'PokeInvest daily limit reached'; break; }
  }
  if (n >= todo.length && !lastError) st.idle = true; // nothing left to do today
  // cards that fell out of the list (price dropped under $20) are kept until 60 days old
  for (const [id, v] of Object.entries(out.cards)) if (now - Date.parse(v.at) > 60 * DAY && !cards.some(c => c.id === id)) delete out.cards[id];
  Object.assign(out, { v: VERSION, updated: new Date(now).toISOString(), count: Object.keys(out.cards).length, pool: cards.length, lastError: read ? null : lastError });
  await gh.put('prices', 'graded.json.gz', zlib.gzipSync(Buffer.from(JSON.stringify(out))));
  await gh.put('state', 'graded-state.json', Buffer.from(JSON.stringify(st)));
  log(`read ${read}, no match ${missed}, calls ${st.used}/${daily} today, ${out.count} cards in the file`);
  return { read, missed, used: st.used, count: out.count };
}

module.exports = { runGraded, cardsFrom, plan, piCandidates, piName, piSet, gradedFromPi, salesFrom, readCard, PokeInvest, CFG };
if (require.main === module) runGraded().catch(e => { console.error(e); process.exit(1); });
