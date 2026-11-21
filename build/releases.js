// Releases: sets coming out in the next 100 days and sets out in the last 14, for Minty's front page.
// From the TCGplayer price lists: each set's release date and its main sealed products with their (pre-order) prices.
// For each set one eBay link – only to a listing from a Top Rated seller with 99.7%+ positive feedback and 500+ ratings.
// Run after the deals; it does its work at most every 6 hours (eBay listing details are shown at most 6 hours old).
const zlib = require('zlib');
const { GitHub, sleep } = require('./gh');
const { Ebay, setWords } = require('./deals');

const RELEASES_VERSION = 1;
const GAMES = [3, 85, 68, 89, 92, 86, 2, 1]; // the games Minty shows on the front page
const GAME_WORD = { 1: 'MTG', 2: 'Yugioh', 3: 'Pokemon', 68: 'One Piece', 85: 'Pokemon Japanese', 86: 'Gundam', 89: 'Riftbound', 92: 'Cyberpunk' };
const CFG = { ahead: 100, back: 14, perSet: 3, every: 6, minFeedback: 99.7, minRatings: 500, tryItems: 2 };
const SKIP_SET = /release event|box toppers|promo|miscellaneous|\bmisc\b|prize|jumbo|art series|code card|championship|league|oversized|world collection|black star|deck exclusives/i;
const SKIP_ITEM = /\bcase\b|code card|sleeve|playmat|binder|deck box|storage|portfolio|dice|token|\blot\b/i;
const KINDS = [['etb', /elite trainer box/i], ['half', /half booster box/i], ['side', /build (&|and) battle|scene box|starter deck display/i], ['box', /booster box|\bdisplay\b|\bbox\b/i], ['bundle', /bundle/i], ['kit', /kit\b/i], ['deck', /deck/i], ['pack', /\bpacks?\b/i], ['other', /./]];
const RANK = ['box', 'etb', 'bundle', 'half', 'kit', 'deck', 'side', 'pack', 'other'];
const kindOf = n => KINDS.find(k => k[1].test(n))[0];
const BAD = /\b(proxy|custom|orica|replica|fake|empty|opened|resealed|damaged|lot|you pick|mystery|repack|art card|sticker|playmat|sleeves?|binder|display case|case only|box only|psa|bgs|cgc|graded|japanese|japan|jp|jpn|korean|chinese|german|french|italian|spanish|portuguese|thai|indonesian)\b/i;
const KIND_WORD = { box: /\b(box|display)\b/i, half: /\bhalf\b/i, side: /\b(box|display)\b/i, etb: /\b(elite trainer|etb)\b/i, bundle: /\bbundle\b/i, kit: /\bkit\b/i, deck: /\bdeck\b/i, pack: /\bpacks?\b/i, other: /./ };

// a set's real release date (TCGplayer gives a plain day; older sets carry the date it last touched them)
const relDay = g => { const d = String((g && g.publishedOn) || ''); return /T00:00:00(\.0+)?$/.test(d) ? d.slice(0, 10) : null; };
const dayNo = s => Math.round(Date.parse(s.slice(0, 10) + 'T00:00:00Z') / 864e5);

// The sets to show, newest last: date window, no catch-all groups, up to 3 main sealed products each (boxes first).
function pickSets(priceFiles, today) {
  const t = dayNo(today), out = [];
  for (const cat of GAMES) {
    const pf = priceFiles[cat]; if (!pf) continue;
    for (const g of pf.groups || []) {
      const day = relDay(g); if (!day) continue;
      const d = dayNo(day) - t;
      if (d > CFG.ahead || d < -CFG.back || SKIP_SET.test(g.name)) continue;
      const list = (pf.products || {})[g.groupId] || [];
      const pr = (pf.prices || {})[g.groupId] || {};
      const priceOf = id => { const v = Object.values(pr[id] || {}).filter(p => p > 0); return v.length ? Math.min(...v) : null; };
      const sealed = list.filter(p => !p[5] && !SKIP_ITEM.test(p[1])).map(p => ({ id: p[0], name: p[1], price: priceOf(p[0]), k: kindOf(p[1]) }));
      const rank = x => RANK.indexOf(x.k);
      sealed.sort((a, b) => rank(a) - rank(b) || (b.price || 0) - (a.price || 0));
      if (!sealed.length) continue; // cards only (box toppers, side sets): not a release to buy
      out.push({ cat, set: g.name, g: g.groupId, date: day, items: sealed.slice(0, CFG.perSet) });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.cat - b.cat);
}

// The set's own name: no code ("ME06: "), no "Commander: ", no " - Retail"
const bareSet = n => String(n).replace(/^commander:\s*/i, '').replace(/^[A-Za-z]{1,5}\d{0,3}[a-z]?:\s*/, '').replace(/\s*-\s*retail\b/i, '').trim();
const PROD_WORDS = new Set(['starter', 'deck', 'decks', 'retail', 'display', 'bundle', 'kit', 'booster', 'box', 'pack', 'special', 'set']);
const mustWords = r => setWords(bareSet(r.set)).filter(w => !PROD_WORDS.has(w));
// The eBay search: game and product, with the set's name when the product's name lacks it – "Pokemon Delta Reign Booster Box"
function queryOf(r, it) {
  const prod = it.name.replace(/\[.*?\]|\(.*?\)/g, '').replace(/\s*-\s*retail\b/ig, '').replace(/\s+-\s+/g, ' ').replace(/:/g, '').replace(/\s+/g, ' ').trim();
  const has = mustWords(r).every(w => (' ' + prod.toLowerCase() + ' ').includes(w));
  return `${GAME_WORD[r.cat]} ${has ? '' : bareSet(r.set).replace(/:/g, '') + ' '}${prod}`.replace(/\s+/g, ' ').trim();
}
// Is this eBay listing one we may link to? Top Rated seller, 99.7%+, 500+ ratings, US, Buy It Now, the right product.
function linkOk(rel, item, l) {
  if (!l || !l.price || l.price.currency !== 'USD') return false;
  if (!(l.buyingOptions || []).includes('FIXED_PRICE')) return false;
  if (l.itemLocation && l.itemLocation.country && l.itemLocation.country !== 'US') return false;
  const s = l.seller || {};
  if (l.topRatedBuyingExperience !== true) return false;
  if (!(parseFloat(s.feedbackPercentage) >= CFG.minFeedback) || !(s.feedbackScore >= CFG.minRatings)) return false;
  if (!/^new/i.test(l.condition || 'new')) return false;
  const t = ' ' + String(l.title || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ') + ' ';
  const ja = rel.cat === 85, jaWord = /\b(japanese|japan|jp|jpn)\b/;
  if (ja && !jaWord.test(t)) return false; // Pokémon Japanese: the listing has to say so
  const t2 = ja ? t.replace(new RegExp(jaWord.source, 'g'), ' ') : t;
  if (BAD.test(t2) && !BAD.test(item.name)) return false;
  if (/\bcase\b/.test(t)) return false;
  if (!mustWords(rel).every(w => t.includes(' ' + w.replace(/[^a-z0-9 ]+/g, ' ').trim() + ' '))) return false;
  if (!KIND_WORD[item.k].test(t)) return false;
  const p = parseFloat(l.price.value);
  if (item.price && !(p >= item.price * 0.6 && p <= item.price * 2.5)) return false; // far off the pre-order price: another product or a scalper
  return true;
}

async function runReleases(env = {}) {
  const log = env.log || ((...a) => console.log(new Date().toISOString().slice(11, 19), 'releases:', ...a));
  const fetchFn = env.fetch || fetch;
  const gh = env.gh || new GitHub({ repo: env.repo || process.env.GITHUB_REPOSITORY, token: env.token || process.env.GITHUB_TOKEN, fetch: fetchFn, log });
  const appId = env.appId ?? process.env.EBAY_APP_ID, certId = env.certId ?? process.env.EBAY_CERT_ID, campaign = env.campaign ?? (process.env.EBAY_CAMPAIGN_ID || '5339254309');
  const now = env.now || Date.now();
  let prev = null; try { const b = await gh.download('prices', 'releases.json'); prev = b ? JSON.parse(b) : null; } catch (_) {}
  if (prev && prev.v === RELEASES_VERSION && now - Date.parse(prev.updated) < CFG.every * 3600000) { log('up to date'); return { skipped: true }; }
  const priceFiles = {};
  for (const cat of GAMES) { const b = await gh.download('prices', `prices-${cat}.json.gz`); if (b) priceFiles[cat] = JSON.parse(zlib.gunzipSync(b)); }
  const sets = pickSets(priceFiles, new Date(now).toISOString());
  const eb = appId && certId ? (env.ebay || new Ebay({ appId, certId, campaign, fetch: fetchFn, log })) : null;
  let searched = 0;
  for (const r of sets) {
    if (!eb) break;
    for (const it of r.items.slice(0, CFG.tryItems)) {
      let list;
      try { list = await eb.find(queryOf(r, it)); searched++; }
      catch (e) { log(r.set, e.message); if (e.limit) break; continue; }
      const tr = list.filter(l => l.topRatedBuyingExperience === true), hi = tr.filter(l => parseFloat((l.seller || {}).feedbackPercentage) >= CFG.minFeedback && (l.seller || {}).feedbackScore >= CFG.minRatings);
      log(`${queryOf(r, it)}: ${list.length} listings, ${tr.length} Top Rated, ${hi.length} at 99.7%/500` + (hi[0] ? ` – e.g. "${hi[0].title}" $${hi[0].price && hi[0].price.value} ${hi[0].condition || ''}` : ''));
      const ok = list.filter(l => linkOk(r, it, l)).sort((a, b) => parseFloat(a.price.value) - parseFloat(b.price.value));
      if (ok.length) { r.link = { id: it.id, u: ok[0].itemAffiliateWebUrl || ok[0].itemWebUrl }; break; }
      if (!env.fast) await sleep(250);
    }
  }
  const out = { v: RELEASES_VERSION, updated: new Date(now).toISOString(), bar: { pct: CFG.minFeedback, ratings: CFG.minRatings, topRated: true }, sets };
  await gh.put('prices', 'releases.json', Buffer.from(JSON.stringify(out)));
  log(`${sets.length} sets, ${searched} eBay searches, ${sets.filter(r => r.link).length} with a trusted seller link`);
  return { sets: sets.length, searched };
}

module.exports = { runReleases, pickSets, linkOk, queryOf, kindOf, CFG, RELEASES_VERSION };
if (require.main === module) runReleases().catch(e => { console.error(e); process.exit(1); });
