// Deal finder: eBay Buy It Now listings well under the TCGplayer market price, for the cards and sealed products in the
// market indexes. Runs after the price job every hour, and only when the eBay keys are set as repository secrets
// (EBAY_APP_ID, EBAY_CERT_ID; the EPN campaign defaults to 5339254309). Everyone's Minty reads the one file it
// writes (prices/deals.json) – no copy of Minty ever searches eBay itself, so users never use up eBay searches.
//
// Budget: eBay allows 5,000 searches a day per app (reset at midnight Pacific). 4,500 are used, spread over the hours:
//  - items worth $200+ are searched every 6 hours, items worth $20–200 once a day, items under $20 never;
//  - what is left of each hour's share rechecks items that have deals, so sold listings drop off sooner.
// One search per item, asking eBay only for Buy It Now listings from US sellers priced 40–85% of market.
const zlib = require('zlib');
const { GitHub, sleep } = require('./gh');

const DEALS_VERSION = 1;
const CFG = { dayBudget: 4500, minMarket: 20, highMarket: 200, highEvery: 6, lowEvery: 24, recheckAfter: 2, minOff: 0.15, maxOff: 0.60, minFeedback: 98, minRatings: 50, keep: 300 };
// Search word for each TCGplayer category (how eBay sellers write the game).
const GAME_WORD = { 1: 'MTG', 2: 'Yugioh', 3: 'Pokemon', 16: 'Vanguard', 17: 'Force of Will', 20: 'Weiss Schwarz', 24: 'Final Fantasy TCG', 25: 'UniVersus', 27: 'Dragon Ball Super', 57: 'Transformers TCG', 62: 'Flesh and Blood', 63: 'Digimon', 66: 'MetaZoo', 67: 'Wixoss', 68: 'One Piece', 71: 'Lorcana', 72: 'Battle Spirits', 73: 'Shadowverse', 74: 'Grand Archive', 77: 'Sorcery', 79: 'Star Wars Unlimited', 80: 'Dragon Ball Fusion World', 81: 'Union Arena', 83: 'Elestrals', 85: 'Pokemon Japanese', 86: 'Gundam', 87: 'hololive', 89: 'Riftbound', 91: 'Palworld', 92: 'Cyberpunk' };
const BAD_WORDS = ['proxy', 'custom', 'orica', 'replica', 'fan art', 'fanart', 'digital', 'code card', 'online code', 'lot', 'you pick', 'pick your', 'choose', 'mystery', 'repack', 'reprint', 'fake', 'not real', 'damaged', 'read description', 'see description', 'empty', 'opened', 'resealed', 'no packs', 'art card', 'sticker', 'playmat', 'sleeve', 'binder', 'display only'];
const GRADED_WORDS = ['psa', 'bgs', 'cgc', 'tag', 'sgc', 'beckett', 'graded', 'gem mint', 'slab', 'slabbed'];
const FOREIGN_WORDS = ['japanese', 'japan', 'jp', 'jpn', 'korean', 'chinese', 'german', 'french', 'italian', 'spanish', 'portuguese', 'thai', 'indonesian'];

const norm = s => ' ' + String(s || '').toLowerCase().replace(/[^a-z0-9/\- ]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
// "Umbreon VMAX (Alternate Art Secret)" → "Umbreon VMAX"; "Nidoking ex - 216/182" → "Nidoking ex"
const baseName = n => String(n || '').replace(/\s+-\s+[A-Z]{0,6}\d+[a-z]?(\/[A-Z]{0,6}\d+)?\s*$/i, '').replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
const words = s => norm(s).trim().split(' ').filter(w => w.length >= 3 && !['the', 'and', 'for', 'with', 'tcg', 'card', 'game'].includes(w));
// Card number forms a seller may write: "001/298" → "001/298", "1/298"; "OP09-004" stays.
function numForms(no) {
  const n = String(no || '').trim().toLowerCase(); if (!n) return [];
  const m = n.match(/^([a-z]{0,4})0*(\d+)([a-z]?)\s*\/\s*([a-z]{0,4})0*(\d+)$/);
  if (m) return [...new Set([n.replace(/\s/g, ''), `${m[1]}${m[2]}${m[3]}/${m[4]}${m[5]}`])];
  return [n];
}
function buildQuery(it) {
  const g = GAME_WORD[it.cat] || '';
  if (it.kind === 'sealed') return [g, String(it.name).replace(/[()]/g, ' ')].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return [g, baseName(it.name), (numForms(it.number)[0] || '')].filter(Boolean).join(' ').trim();
}
// Is this listing the item, sold the way a deal must be? Returns the reason it is not, or '' when it is.
function rejectReason(it, l) {
  const t = norm(l.title);
  if (BAD_WORDS.some(w => t.includes(' ' + w + ' '))) return 'bad word';
  const foreignItem = it.cat === 85 || /japanese/i.test(it.set || '');
  if (!foreignItem && FOREIGN_WORDS.some(w => t.includes(' ' + w + ' '))) return 'language';
  if (it.kind !== 'sealed') {
    if (GRADED_WORDS.some(w => t.includes(' ' + w + ' '))) return 'graded';
    if (l.conditionId === '2750' || /^graded/i.test(l.condition || '')) return 'graded';
    const forms = numForms(it.number);
    if (forms.length && !forms.some(f => t.includes(' ' + f + ' ') || t.includes(' ' + f.replace(/\//g, ' / ') + ' ') || t.includes('#' + f))) return 'number';
  } else {
    if (/\bcase\b/i.test(it.name) !== /\bcase\b/.test(t)) return 'case';
  }
  const need = words(it.kind === 'sealed' ? it.name : baseName(it.name));
  if (need.some(w => !t.includes(' ' + w + ' ') && !t.includes(' ' + w))) return 'name';
  return '';
}
function dealFrom(it, l, now) {
  if (!l || !l.price || l.price.currency !== 'USD') return null;
  if (!(l.buyingOptions || []).includes('FIXED_PRICE')) return null;
  if (l.itemLocation && l.itemLocation.country && l.itemLocation.country !== 'US') return null;
  const s = l.seller || {};
  if (!(parseFloat(s.feedbackPercentage) >= CFG.minFeedback) || !(s.feedbackScore >= CFG.minRatings)) return null;
  const so = (l.shippingOptions || [])[0];
  let ship = 0;
  if (so) { if (so.shippingCostType === 'CALCULATED' && !so.shippingCost) return null; ship = so.shippingCost ? parseFloat(so.shippingCost.value) || 0 : 0; }
  const price = parseFloat(l.price.value), total = Math.round((price + ship) * 100) / 100;
  const off = 1 - total / it.market;
  if (!(off >= CFG.minOff && off <= CFG.maxOff)) return null;
  if (rejectReason(it, l)) return null;
  return { lid: l.itemId, pid: it.id, cat: it.cat, g: it.g, kind: it.kind, name: it.name, set: it.set, number: it.number || '', title: l.title, price, ship, total, market: it.market, pct: Math.round(off * 1000) / 10,
    cond: l.condition || '', seller: s.username || '', fb: parseFloat(s.feedbackPercentage), fbScore: s.feedbackScore, img: (l.image && l.image.imageUrl) || ((l.thumbnailImages || [])[0] || {}).imageUrl || '',
    url: l.itemWebUrl, aff: l.itemAffiliateWebUrl || '', found: now, checked: now };
}
// The items to watch: every member of the market indexes worth $20+, with the lowest TCGplayer market price among the
// products sharing its set and number (a cheaper printing of the same card must not look like a deal on the dear one).
function itemsFrom(indexes, priceFiles) {
  const out = [];
  for (const [cat, x] of Object.entries(indexes.cats || {})) {
    const pf = priceFiles[cat]; if (!pf) continue;
    const ids = new Set([].concat(x.cards && x.cards.ids || [], x.sealed && x.sealed.ids || []));
    if (!ids.size) continue;
    const setName = new Map((pf.groups || []).map(g => [String(g.groupId), g.name]));
    for (const [g, list] of Object.entries(pf.products || {})) {
      const pr = (pf.prices || {})[g] || {};
      const minOf = id => { const v = Object.values(pr[id] || {}).filter(p => p > 0); return v.length ? Math.min(...v) : null; };
      for (const p of list) {
        if (!ids.has(p[0])) continue;
        let market = minOf(p[0]);
        if (p[5] && p[2]) for (const q of list) if (q !== p && q[5] && q[2] === p[2]) { const m = minOf(q[0]); if (m && (!market || m < market)) market = m; }
        if (!(market >= CFG.minMarket)) continue;
        out.push({ id: p[0], cat: +cat, g: +g, kind: p[5] ? 'card' : 'sealed', name: p[1], number: p[5] ? p[2] || '' : '', set: setName.get(String(g)) || '', market });
      }
    }
  }
  return out;
}
// Pacific-time day (eBay's quota day) and how many hours of it are left.
function pacific(now) {
  const d = new Date(now), parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(d);
  const v = k => parts.find(p => p.type === k).value;
  return { day: `${v('year')}-${v('month')}-${v('day')}`, hoursLeft: 24 - (parseInt(v('hour'), 10) % 24) };
}
// Which items to search this hour: overdue ones first ($200+ before the rest), then rechecks of items with deals.
function plan(items, st, deals, now, allowance) {
  const H = 3600000, last = id => (st.checked && st.checked[id]) || 0;
  const due = items.filter(it => now - last(it.id) >= (it.market >= CFG.highMarket ? CFG.highEvery : CFG.lowEvery) * H)
    .sort((a, b) => (b.market >= CFG.highMarket) - (a.market >= CFG.highMarket) || last(a.id) - last(b.id));
  const picked = due.slice(0, allowance);
  if (picked.length < allowance) {
    const withDeals = new Set(deals.map(d => d.pid)), have = new Set(picked.map(x => x.id));
    const re = items.filter(it => withDeals.has(it.id) && !have.has(it.id) && now - last(it.id) >= CFG.recheckAfter * H).sort((a, b) => last(a.id) - last(b.id));
    picked.push(...re.slice(0, allowance - picked.length));
  }
  return picked;
}

class Ebay {
  constructor({ appId, certId, campaign, fetch, log }) { Object.assign(this, { appId, certId, campaign, fetch, log }); this.count = 0; this.token = null; }
  async auth() {
    if (this.token && Date.now() < this.tokenUntil) return this.token;
    const r = await this.fetch('https://api.ebay.com/identity/v1/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(this.appId + ':' + this.certId).toString('base64') },
      body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope') });
    if (!r.ok) throw new Error('eBay sign-in: ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json(); this.token = j.access_token; this.tokenUntil = Date.now() + ((j.expires_in || 7200) - 300) * 1000;
    return this.token;
  }
  async search(it) {
    const lo = Math.floor(it.market * (1 - CFG.maxOff) * 100) / 100, hi = Math.floor(it.market * (1 - CFG.minOff) * 100) / 100;
    const filter = `buyingOptions:{FIXED_PRICE},itemLocationCountry:US,deliveryCountry:US,priceCurrency:USD,price:[${lo}..${hi}]`;
    const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?' + new URLSearchParams({ q: buildQuery(it), filter, limit: '50', sort: 'newlyListed' });
    const headers = { authorization: 'Bearer ' + await this.auth(), 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' };
    if (this.campaign) headers['X-EBAY-C-ENDUSERCTX'] = `affiliateCampaignId=${this.campaign},affiliateReferenceId=minty`;
    this.count++;
    const r = await this.fetch(url, { headers });
    if (r.status === 429) { const e = new Error('eBay daily limit reached'); e.limit = true; throw e; }
    if (!r.ok) throw new Error('eBay search: ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return (await r.json()).itemSummaries || [];
  }
}

async function runDeals(env = {}) {
  const log = env.log || ((...a) => console.log(new Date().toISOString().slice(11, 19), 'deals:', ...a));
  const fetchFn = env.fetch || fetch;
  const gh = env.gh || new GitHub({ repo: env.repo || process.env.GITHUB_REPOSITORY, token: env.token || process.env.GITHUB_TOKEN, fetch: fetchFn, log });
  const appId = env.appId ?? process.env.EBAY_APP_ID, certId = env.certId ?? process.env.EBAY_CERT_ID, campaign = env.campaign ?? (process.env.EBAY_CAMPAIGN_ID || '5339254309'); // Pavel's EPN campaign (not a secret: it is in every affiliate link)
  const now = env.now || Date.now();
  const prevBuf = await gh.download('prices', 'deals.json');
  let prev = null; try { prev = prevBuf ? JSON.parse(prevBuf) : null; } catch (_) {}
  if (!appId || !certId) { // not connected yet: say so once, so Minty can show it
    if (!prev || prev.enabled !== false) await gh.put('prices', 'deals.json', Buffer.from(JSON.stringify({ v: DEALS_VERSION, enabled: false, updated: new Date(now).toISOString(), deals: [] })));
    log('no eBay keys set – deals not running'); return { enabled: false };
  }
  const stBuf = await gh.download('state', 'deals-state.json');
  const st = stBuf ? JSON.parse(stBuf) : { checked: {}, items: null, itemsBuilt: null };
  st.checked = st.checked || {};
  // the list of items: rebuilt when the market indexes are rebuilt (once a day)
  const ixBuf = await gh.download('history', 'indexes.json.gz');
  const indexes = ixBuf ? JSON.parse(zlib.gunzipSync(ixBuf)) : null;
  if (!indexes) { log('no market indexes yet'); return { enabled: true, searched: 0 }; }
  if (!st.items || st.itemsBuilt !== indexes.built) {
    const priceFiles = {};
    for (const cat of Object.keys(indexes.cats || {})) { const b = await gh.download('prices', `prices-${cat}.json.gz`); if (b) priceFiles[cat] = JSON.parse(zlib.gunzipSync(b)); }
    st.items = itemsFrom(indexes, priceFiles); st.itemsBuilt = indexes.built;
    log(`${st.items.length} items to watch`);
  }
  const P = pacific(now);
  if (!st.budget || st.budget.day !== P.day) st.budget = { day: P.day, used: 0 };
  const allowance = Math.max(0, Math.min(CFG.dayBudget - st.budget.used, Math.ceil((CFG.dayBudget - st.budget.used) / P.hoursLeft)));
  let deals = (prev && prev.enabled !== false ? prev.deals : []) || [];
  const byId = new Map(st.items.map(it => [it.id, it]));
  deals = deals.filter(d => byId.has(d.pid) && now - Date.parse(d.checked) < 30 * 3600000); // an item not rechecked in 30 h: its deals drop
  const todo = plan(st.items, st, deals, now, allowance);
  const eb = env.ebay || new Ebay({ appId, certId, campaign, fetch: fetchFn, log });
  let searched = 0, lastError = null;
  for (const it of todo) {
    let list;
    try { list = await eb.search(it); } catch (e) { log(it.name, e.message); lastError = e.message.slice(0, 300); if (e.limit || /sign-in/.test(e.message)) break; continue; } // a failed sign-in fails every search: stop
    searched++; st.budget.used++; st.checked[it.id] = now;
    const old = new Map(deals.filter(d => d.pid === it.id).map(d => [d.lid, d]));
    deals = deals.filter(d => d.pid !== it.id);
    for (const l of list) { const d = dealFrom(it, l, new Date(now).toISOString()); if (d) { if (old.has(d.lid)) d.found = old.get(d.lid).found; deals.push(d); } }
    if (!env.fast) await sleep(250);
  }
  deals.sort((a, b) => b.pct - a.pct);
  deals = deals.slice(0, CFG.keep);
  await gh.put('prices', 'deals.json', Buffer.from(JSON.stringify({ v: DEALS_VERSION, enabled: true, updated: new Date(now).toISOString(), items: st.items.length, budget: st.budget, lastError: searched ? null : lastError, deals })));
  await gh.put('state', 'deals-state.json', Buffer.from(JSON.stringify(st)));
  log(`searched ${searched} of ${todo.length} planned (${st.budget.used} today), ${deals.length} deals`);
  return { enabled: true, searched, deals: deals.length };
}

module.exports = { runDeals, buildQuery, rejectReason, dealFrom, itemsFrom, plan, pacific, numForms, CFG, Ebay };
if (require.main === module) runDeals().catch(e => { console.error(e); process.exit(1); });
