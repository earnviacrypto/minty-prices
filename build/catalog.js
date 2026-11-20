// eBay catalog numbers (ePIDs): which eBay catalog product each card is, with eBay's stock picture when it has one.
// Minty uses them for exact "See current listings" links (eBay's own page for the card) and as a picture when a card has
// no other. Runs after the deals every hour, a share of the day's budget each time. Writes prices/epid.json.gz:
// { v, updated, count, items: { <TCGplayer product id>: [[epid, picture or '', eBay title], …] } } – best match first.
//
// eBay's Catalog API needs a user sign-in: Pavel's refresh token (scopes api_scope + commerce.catalog.readonly, about
// 18 months) is kept in auth/refresh.enc, locked with the EBAY_CERT_ID secret (openssl aes-256-cbc, pbkdf2, 200,000 rounds).
//
// A card is matched only when an eBay catalog title passes the same checks as a deal (name, card number, version, other
// sets, language, graded) – no guessing. Cards without a number, and sealed products, are not looked up. A game whose
// first 40 lookups find nothing is left alone for 30 days. A card found is not looked up again; one not found, after 30 days.
const fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const { GitHub, sleep } = require('./gh');
const D = require('./deals');

const CFG = { dayBudget: 2000, minMarket: 3, maxItems: 20000, keep: 3, retryDays: 30, gameTry: 40, gameRest: 30 };
const SCOPES = 'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/commerce.catalog.readonly';
const DAY = 86400000;

// openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt: "Salted__", 8 bytes of salt, then the locked text.
function unlock(buf, pass) {
  if (!buf || buf.length < 32 || buf.slice(0, 8).toString() !== 'Salted__') throw new Error('refresh token file not readable');
  const kv = crypto.pbkdf2Sync(pass, buf.slice(8, 16), 200000, 48, 'sha256');
  const d = crypto.createDecipheriv('aes-256-cbc', kv.slice(0, 32), kv.slice(32));
  const out = Buffer.concat([d.update(buf.slice(16)), d.final()]);
  // a wrong key sometimes still ends in valid padding (about 1 in 256) and gives garbage, so the result must be plain text
  if (!out.length || out.some(b => b < 9 || b > 126)) throw new Error('refresh token file not readable');
  return out.toString().trim();
}
function lock(text, pass) { // the same format, for the tests
  const salt = crypto.randomBytes(8), kv = crypto.pbkdf2Sync(pass, salt, 200000, 48, 'sha256');
  const c = crypto.createCipheriv('aes-256-cbc', kv.slice(0, 32), kv.slice(32));
  return Buffer.concat([Buffer.from('Salted__'), salt, c.update(text), c.final()]);
}
// What is searched: the card's name without brackets and its number ("Umbreon VMAX 215/203").
function catalogQuery(it) {
  const base = String(it.name || '').replace(/\s+-\s+[A-Z]{0,6}\d+[a-z]?(\/[A-Z]{0,6}\d+)?\s*$/i, '').replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  return (base + ' ' + (D.numForms(it.number)[0] || '')).trim();
}
// eBay catalog titles name the set ("… Base Set Holo", "… SWSH07: Evolving Skies Holo"), so on top of the deal checks the
// card's own set must be named, and anything in brackets ("(Celebrations Metal Card)") must be in the card's name or set.
const RULES = 2;
function sameCard(it, title) {
  if (D.rejectReason(it, { title })) return false;
  const t = ' ' + String(title).toLowerCase().replace(/[^a-z0-9/ ]+/g, ' ').replace(/\s+/g, ' ') + ' '; // "Sm-Team Up" → "sm team up"
  const sw = D.setWords(it.set).map(w => w.replace(/-/g, ' ').trim()).filter(Boolean); // "Yu-Gi-Oh!" → "yu gi oh"; no telling words ("XY Promos"): the card number has to do
  if (sw.some(w => !t.includes(' ' + w))) return false;
  const mine = ' ' + String(it.name + ' ' + it.set).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ') + (+it.cat === 85 ? ' japanese' : '') + ' '; // Japanese Pokémon: eBay adds "(Japanese)"
  for (const m of String(title).matchAll(/\(([^)]*)\)/g)) for (const w of m[1].toLowerCase().split(/[^a-z0-9]+/)) {
    if (!w || /^\d+$/.test(w) || ['the', 'and', 'of'].includes(w)) continue;
    if (!mine.includes(' ' + w + ' ')) return false;
  }
  return true;
}
// The catalog products that are this card: every check a deal passes, on eBay's own title. Best first: the plain printing
// before reverse holo, 1st edition or shadowless versions (Minty picks by the printing a card is kept in).
function matches(it, found) {
  const out = [];
  for (const p of found || []) {
    if (!p || !p.epid || !p.title) continue;
    if (!sameCard(it, p.title)) continue;
    out.push([String(p.epid), (p.image && p.image.imageUrl) || '', p.title]);
  }
  const odd = t => /reverse|1st edition|first edition|shadowless|staff|pre-?release|stamped/i.test(t) ? 1 : 0;
  return out.sort((a, b) => odd(a[2]) - odd(b[2]) || (b[1] ? 1 : 0) - (a[1] ? 1 : 0)).slice(0, CFG.keep);
}
// The cards to look up: the ones watched for deals and listings first, then every card worth minMarket+, dearest first.
function candidates(watched, priceFiles) {
  const out = [], seen = new Set();
  const add = x => { if (x.kind !== 'card' || !D.numForms(x.number).length || seen.has(x.id)) return; seen.add(x.id); out.push({ id: x.id, cat: x.cat, g: x.g, kind: 'card', name: x.name, number: x.number, set: x.set, market: x.market }); };
  for (const x of watched || []) add(x);
  const rest = [];
  for (const [cat, pf] of Object.entries(priceFiles || {})) {
    const setName = new Map((pf.groups || []).map(g => [String(g.groupId), g.name]));
    for (const [g, list] of Object.entries(pf.products || {})) {
      const pr = (pf.prices || {})[g] || {};
      for (const p of list) {
        if (!p[5] || !p[2]) continue;
        const v = Object.values(pr[p[0]] || {}).filter(x => x > 0); if (!v.length) continue;
        const market = Math.min(...v); if (market < CFG.minMarket) continue;
        rest.push({ id: p[0], cat: +cat, g: +g, kind: 'card', name: p[1], number: p[2], set: setName.get(String(g)) || '', market });
      }
    }
  }
  rest.sort((a, b) => b.market - a.market).forEach(add);
  return out.slice(0, CFG.maxItems);
}
class Catalog {
  constructor({ appId, certId, refresh, fetch }) { Object.assign(this, { appId, certId, refresh, fetch }); this.count = 0; this.token = null; }
  async auth() {
    if (this.token && Date.now() < this.until) return this.token;
    const r = await this.fetch('https://api.ebay.com/identity/v1/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(this.appId + ':' + this.certId).toString('base64') },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refresh, scope: SCOPES }).toString() });
    if (!r.ok) { const e = new Error('eBay catalog sign-in: ' + r.status + ' ' + (await r.text()).slice(0, 200)); e.signin = true; throw e; }
    const j = await r.json(); this.token = j.access_token; this.until = Date.now() + ((j.expires_in || 7200) - 300) * 1000;
    return this.token;
  }
  async search(it) {
    const url = 'https://api.ebay.com/commerce/catalog/v1_beta/product_summary/search?' + new URLSearchParams({ q: catalogQuery(it), category_ids: '183454', limit: '10' });
    this.count++;
    const r = await this.fetch(url, { headers: { authorization: 'Bearer ' + await this.auth(), 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } });
    if (r.status === 204) return [];
    if (r.status === 429) { const e = new Error('eBay catalog daily limit reached'); e.limit = true; throw e; }
    if (!r.ok) throw new Error('eBay catalog search: ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return (await r.json()).productSummaries || [];
  }
}
async function runCatalog(env = {}) {
  const log = env.log || ((...a) => console.log(new Date().toISOString().slice(11, 19), 'catalog:', ...a));
  const fetchFn = env.fetch || fetch;
  const gh = env.gh || new GitHub({ repo: env.repo || process.env.GITHUB_REPOSITORY, token: env.token || process.env.GITHUB_TOKEN, fetch: fetchFn, log });
  const appId = env.appId ?? process.env.EBAY_APP_ID, certId = env.certId ?? process.env.EBAY_CERT_ID, now = env.now || Date.now();
  const file = env.tokenFile ?? path.join(__dirname, '..', 'auth', 'refresh.enc');
  if (!appId || !certId || !fs.existsSync(file)) { log('no eBay sign-in – catalog not running'); return { enabled: false }; }
  let refresh; try { refresh = unlock(fs.readFileSync(file), certId); } catch (e) { log(e.message); return { enabled: false, error: e.message }; }
  const stBuf = await gh.download('state', 'catalog-state.json');
  const st = stBuf ? JSON.parse(stBuf) : {};
  st.checked = st.checked || {}; st.games = st.games || {};
  const dsBuf = await gh.download('state', 'deals-state.json');
  const ds = dsBuf ? JSON.parse(dsBuf) : {};
  D.useSetNames(ds.setNames || {}); // a title naming another set is not this card
  const ixBuf = await gh.download('history', 'indexes.json.gz');
  const indexes = ixBuf ? JSON.parse(zlib.gunzipSync(ixBuf)) : null;
  if (!st.items || (indexes && st.built !== indexes.built)) { // the card list: rebuilt once a day, with the market indexes
    const priceFiles = {};
    for (const cat of Object.keys((indexes && indexes.cats) || {})) { const b = await gh.download('prices', `prices-${cat}.json.gz`); if (b) priceFiles[cat] = JSON.parse(zlib.gunzipSync(b)); }
    if (Object.keys(priceFiles).length || !st.items) { st.items = candidates(ds.items, priceFiles); st.built = indexes ? indexes.built : null; log(st.items.length + ' cards to look up'); }
  }
  const outBuf = await gh.download('prices', 'epid.json.gz');
  let OUT = null; try { OUT = outBuf ? JSON.parse(zlib.gunzipSync(outBuf)) : null; } catch (_) {}
  OUT = OUT && OUT.items ? OUT : { v: 1, items: {} };
  let refiltered = false;
  if (OUT.rules !== RULES) { refiltered = true; // matching rules changed: entries found before must pass them too; a card left with none is looked up again
    const byId = new Map(st.items.map(x => [String(x.id), x]));
    for (const [id, list] of Object.entries(OUT.items)) {
      const it = byId.get(String(id)), keep = it ? list.filter(e => sameCard(it, e[2])) : [];
      if (keep.length) OUT.items[id] = keep; else { delete OUT.items[id]; delete st.checked[id]; }
    }
    OUT.rules = RULES; st.games = {};
  }
  const P = D.pacific(now);
  if (!st.budget || st.budget.day !== P.day) st.budget = { day: P.day, used: 0 };
  const allowance = Math.max(0, Math.min(CFG.dayBudget - st.budget.used, Math.ceil((CFG.dayBudget - st.budget.used) / P.hoursLeft)));
  const resting = cat => (st.games[cat] || {}).restUntil > now;
  const todo = st.items.filter(it => !OUT.items[it.id] && !resting(it.cat) && now - (st.checked[it.id] || 0) >= CFG.retryDays * DAY).slice(0, allowance);
  const cat = env.catalog || new Catalog({ appId, certId, refresh, fetch: fetchFn });
  let looked = 0, found = 0, lastError = null;
  for (const it of todo) {
    if (resting(it.cat)) continue;
    let res;
    try { res = await cat.search(it); } catch (e) { log(it.name, e.message); lastError = e.message.slice(0, 300); if (e.limit || e.signin) break; continue; }
    looked++; st.budget.used++; st.checked[it.id] = now;
    const g = st.games[it.cat] = st.games[it.cat] || { tried: 0, found: 0 };
    g.tried++;
    const m = matches(it, res);
    if (m.length) { OUT.items[it.id] = m; g.found++; found++; }
    if (g.tried >= CFG.gameTry && !g.found) { g.restUntil = now + CFG.gameRest * DAY; g.tried = 0; log('game ' + it.cat + ': nothing in eBay\'s catalog – resting ' + CFG.gameRest + ' days'); }
    if (!env.fast) await sleep(200);
  }
  st.lastError = looked ? null : lastError;
  if (looked || !outBuf || refiltered) await gh.put('prices', 'epid.json.gz', zlib.gzipSync(Buffer.from(JSON.stringify({ v: 1, rules: RULES, updated: new Date(now).toISOString(), count: Object.keys(OUT.items).length, items: OUT.items }))));
  await gh.put('state', 'catalog-state.json', Buffer.from(JSON.stringify(st)));
  log(`looked up ${looked} of ${todo.length} planned (${st.budget.used} today), ${found} found, ${Object.keys(OUT.items).length} in all`);
  return { enabled: true, looked, found, total: Object.keys(OUT.items).length, error: st.lastError };
}

module.exports = { sameCard, runCatalog, unlock, lock, catalogQuery, matches, candidates, CFG, Catalog };
if (require.main === module) runCatalog().catch(e => { console.error(e); process.exit(1); });
