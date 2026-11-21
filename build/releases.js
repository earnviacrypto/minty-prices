// Releases: sets coming out in the next 100 days and sets out in the last 14, for Minty's front page – every card game TCGplayer
// lists (Minty's own games from the shared price files, the rest read from TCGCSV), plus crowdfunded games named in the news.
// From the TCGplayer price lists: each set's release date and its main sealed products with their (pre-order) prices.
// For each set one eBay link – only to a seller with 99.7%+ positive feedback and 500+ ratings. (eBay's Top Rated badge is
// not asked for: it goes on listings that ship within a day, so pre-orders almost never carry it.)
// Each set also carries what its pop-up in Minty shows (info): one line about the set, every product with what is inside
// (copied from the product details), the set size when stated, and the cards revealed so far, priciest first.
// Run after the deals; it does its work at most every 6 hours (eBay listing details are shown at most 6 hours old).
const zlib = require('zlib');
const { GitHub, sleep } = require('./gh');
const { Ebay, setWords } = require('./deals');

const RELEASES_VERSION = 4;
const GAMES = [3, 85, 68, 89, 92, 86, 2, 1]; // Minty's own games: read from the shared price files
const NOT_TCG = /supplies|accessor|comic|funko|board game|miniature|sports card|non-sport|video game/i; // TCGplayer categories that are not card games
const GAME_WORD = { 1: 'MTG', 2: 'Yugioh', 3: 'Pokemon', 68: 'One Piece', 85: 'Pokemon Japanese', 86: 'Gundam', 89: 'Riftbound', 92: 'Cyberpunk' };
const CFG = { ahead: 100, back: 14, perSet: 3, every: 6, minFeedback: 99.7, minRatings: 500, tryItems: 2 };
const SKIP_SET = /release event|event cards|box toppers|promo|miscellaneous|\bmisc\b|prize|jumbo|art series|code card|championship|league|oversized|world collection|black star|deck exclusives/i;
const SKIP_ITEM = /\bcase\b|code card|sleeve|playmat|binder|deck box|storage|portfolio|dice|token|\blot\b/i;
const KINDS = [['etb', /elite trainer box/i], ['half', /half booster box/i], ['side', /build (&|and) battle|scene box|starter deck display/i], ['box', /booster box|\bdisplay\b|\bbox\b/i], ['bundle', /bundle/i], ['kit', /kit\b/i], ['deck', /deck/i], ['pack', /\bpacks?\b/i], ['other', /./]];
const RANK = ['box', 'etb', 'bundle', 'half', 'kit', 'deck', 'side', 'pack', 'other'];
const kindOf = n => KINDS.find(k => k[1].test(n))[0];
const BAD = /\b(proxy|custom|orica|replica|fake|empty|opened|resealed|damaged|lot|you pick|mystery|repack|art card|sticker|playmat|sleeves?|binder|display case|case only|box only|psa|bgs|cgc|graded|japanese|japan|jp|jpn|korean|chinese|german|french|italian|spanish|portuguese|thai|indonesian|eu|european|eu print)\b/i;
const OTHER_KIND = [/\bdecks?\b/, /\bbundle\b/, /\bkit\b/, /\belite trainer\b|\betb\b/, /\bstarter\b/, /\bchampion\b/, /\bcollection\b/, /\bcollector\b/, /\bplay booster\b/, /\bdraft\b/, /\bhalf\b/, /\bbuild (and )?battle\b/, /\btins?\b/, /\bblister\b/];
const KIND_WORD = { box: /\b(box|display)\b/i, half: /\bhalf\b/i, side: /\b(box|display)\b/i, etb: /\b(elite trainer|etb)\b/i, bundle: /\bbundle\b/i, kit: /\bkit\b/i, deck: /\bdeck\b/i, pack: /\bpacks?\b/i, other: /./ };

// a set's real release date (TCGplayer gives a plain day; older sets carry the date it last touched them)
const relDay = g => { const d = String((g && g.publishedOn) || ''); return /T00:00:00(\.0+)?$/.test(d) ? d.slice(0, 10) : null; };
const dayNo = s => Math.round(Date.parse(s.slice(0, 10) + 'T00:00:00Z') / 864e5);

// The sets to show, newest last: date window, no catch-all groups, up to 3 main sealed products each (boxes first).
function pickSets(priceFiles, today) {
  const t = dayNo(today), out = [];
  for (const cat of Object.keys(priceFiles).map(Number)) {
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

// The game's name for an eBay search: Minty's short names, else TCGplayer's name without "Trading Card Game" and the like
const gameWord = r => GAME_WORD[r.cat] || String(r.game || '').replace(/\b(official card game|trading card game|card game|tcg)\b/ig, '').replace(/[:\s]+$/, '').trim();
// The set's own name: no code ("ME06: "), no "Commander: ", no " - Retail"
const bareSet = n => String(n).replace(/^commander:\s*/i, '').replace(/^[A-Za-z]{1,5}\d{0,3}[a-z]?:\s*/, '').replace(/\s*-\s*retail\b/i, '').trim();
const PROD_WORDS = new Set(['starter', 'deck', 'decks', 'retail', 'display', 'bundle', 'kit', 'booster', 'box', 'pack', 'special', 'set']);
const mustWords = r => setWords(bareSet(r.set)).filter(w => !PROD_WORDS.has(w));
// The eBay search: game and product, with the set's name when the product's name lacks it – "Pokemon Delta Reign Booster Box"
function queryOf(r, it) {
  const prod = it.name.replace(/\[.*?\]|\(.*?\)/g, '').replace(/\s*-\s*retail\b/ig, '').replace(/\s+-\s+/g, ' ').replace(/:/g, '').replace(/\s+/g, ' ').trim();
  const has = mustWords(r).every(w => (' ' + prod.toLowerCase() + ' ').includes(w));
  return `${gameWord(r)} ${has ? '' : bareSet(r.set).replace(/:/g, '') + ' '}${prod}`.replace(/\s+/g, ' ').trim();
}
// Is this eBay listing one we may link to? Seller at 99.7%+, 500+ ratings, US, Buy It Now, the right product.
function linkOk(rel, item, l) {
  if (!l || !l.price || l.price.currency !== 'USD') return false;
  if (!(l.buyingOptions || []).includes('FIXED_PRICE')) return false;
  if (l.itemLocation && l.itemLocation.country && l.itemLocation.country !== 'US') return false;
  const s = l.seller || {};
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
  const other = OTHER_KIND.filter(re => re.test(t) && !re.test(' ' + item.name.toLowerCase() + ' '));
  if (other.length) return false; // a deck display is not a booster display, a bundle not a box
  const vol = String(rel.set).match(/\bvol(?:ume)?\.?\s*(\d+)/i); // Vol.2 is not Vol.1
  if (vol && !new RegExp(`\\bvol(ume)?\\.?\\s*${vol[1]}\\b`, 'i').test(l.title)) return false;
  if (!/\s&\s|combined/i.test(item.name) && /\b[a-z]{1,4}\s?\d{2,3}\s*[-–&\/]\s*\d{2,3}\b/i.test(l.title) || /\s&\s.*\b(booster|box|display)\b.*\b(booster|box|display)\b/i.test(l.title)) return false; // two sets in one listing
  const p = parseFloat(l.price.value);
  if (item.price && !(p >= item.price * 0.6 && p <= item.price * 2.5)) return false; // far off the pre-order price: another product or a scalper
  return true;
}

// ---- what the pop-up shows: from TCGplayer's own product details (the maker's text, copied, never written by us) ----
const plain = t => String(t || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\r/g, '').replace(/[ \t]+/g, ' ');
const textOf = x => { const e = {}; for (const d of x.extendedData || []) e[d.name] = d.value; return plain(e.Description || e.OracleText || e.CardText || ''); };
const sentences = t => t.split(/\n+/).flatMap(l => l.split(/(?<=[.!?])\s+(?=[A-Z"“])/)).map(x => x.trim()).filter(x => x.length > 2);
const clip = (t, n) => t.length <= n ? t : t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…';
// one line about the set: the "More about <set>" paragraph when there is one, else the text's first sentence
function aboutOf(texts) {
  for (const t of texts) { const m = t.match(/More about [^\n]+\n+([^\n]+)/); if (m && sentences(m[1])[0]) return clip(sentences(m[1])[0], 220); }
  for (const t of texts) { const f = sentences(t)[0]; if (f && f.length > 30) return clip(f, 220); }
  return '';
}
// bullet lines ("• 30 Booster Packs") right after the line at index i
function bulletsAfter(lines, i) { const out = []; for (let j = i + 1; j < lines.length; j++) { const l = lines[j].trim(); if (!l) continue; if (!/^[•·\-*]/.test(l)) break; out.push(l.replace(/^[•·\-*]\s*/, '')); } return out; }
// what's inside one product: its "Contents:" list; else a "… contains 7 cards:" line with its list; else sentences giving a count
function insideOf(t) {
  const lines = t.split('\n');
  let i = lines.findIndex(l => /^\s*(pack |bundle |box |display |kit |deck )?contents:\s*$/i.test(l));
  if (i >= 0) { const b = bulletsAfter(lines, i); if (b.length) return b.slice(0, 6).map(x => clip(x, 90)); }
  i = lines.findIndex(l => /\b(contains?|includes?)\b.*\d.*:\s*$/i.test(l));
  if (i >= 0) { const b = bulletsAfter(lines, i); const h = lines[i].trim().replace(/:\s*$/, ''); return [clip(h, 90)].concat(b.slice(0, 4).map(x => clip(x, 90))); }
  const own = t.split(/More about /)[0];
  const pick = sentences(own).filter(x => /\b(contains?|includes?|inside each|you'll get)\b/i.test(x) && /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve)\b/i.test(x));
  return pick.slice(0, 3).map(x => clip(x, 140));
}
const CASE = /\bcase\b|master case/i;
const baseCard = n => String(n).replace(/\s*\([^)]*\)/g, '').replace(/\s+-\s+.*$/, '').trim();
function detailsOf(r, products, pf) {
  const pr = ((pf && pf.prices) || {})[r.g] || {};
  const priceOf = id => { const v = Object.values(pr[id] || {}).filter(p => p > 0); return v.length ? Math.min(...v) : null; };
  const isCard = x => (x.extendedData || []).some(e => e.name === 'Number');
  const sealed = products.filter(x => !isCard(x) && !CASE.test(x.name) && !SKIP_ITEM.test(x.name)), cards = products.filter(isCard);
  const texts = sealed.map(textOf).filter(Boolean);
  const rank = x => RANK.indexOf(kindOf(x.name));
  const prods = sealed.map(x => ({ id: x.productId, name: x.name, price: priceOf(x.productId), img: x.imageUrl || '', inc: insideOf(textOf(x)) }))
    .sort((a, b) => rank(a) - rank(b) || (b.price || 0) - (a.price || 0)).slice(0, 8);
  const seen = new Map();
  for (const c of cards) { const k = baseCard(c.name), p = priceOf(c.productId) || 0; const o = seen.get(k); if (!o || p > o.price) seen.set(k, { id: c.productId, name: k, price: p || null, img: c.imageUrl || '' }); }
  const top = [...seen.values()].sort((a, b) => (b.price || 0) - (a.price || 0)).slice(0, 6);
  // set size only when stated: the maker's "60-card … set", or Pokémon-style numbers "001/198"
  let size = null;
  for (const t of texts) { const m = t.match(/\b(\d{2,3})-card\b[^.]{0,40}\bset\b/i); if (m) { size = +m[1]; break; } }
  if (!size) { const d = cards.map(c => ((c.extendedData || []).find(e => e.name === 'Number') || {}).value || '').map(v => (String(v).match(/^\D*\d+\s*\/\s*(\d+)$/) || [])[1]).filter(Boolean); if (d.length >= 3) { const f = {}; d.forEach(x => f[x] = (f[x] || 0) + 1); size = +Object.entries(f).sort((a, b) => b[1] - a[1])[0][0]; } }
  return { about: aboutOf(texts), size, revealed: seen.size, products: prods, cards: top };
}

// Crowdfunded games from the news: a headline flagged as crowdfunding that names a "<Name> Trading Card Game / TCG / Card Game"
// not on TCGplayer yet. No date is guessed: these show as "date not set" with a link to the article.
const CROWD_NAME = /((?:[A-Z0-9][\w'’!&.-]*)(?:\s+(?:[A-Z0-9][\w'’!&.-]*|of|the|and|x)){0,4})\s+(?:Official\s+)?(?:Trading Card Game|TCG|Card Game)\b/;
const normName = n => String(n).toLowerCase().replace(/\b(official|card game|trading card game|tcg)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
function crowdGames(items, known, now) {
  const seen = new Set(known.map(normName).filter(Boolean)), out = new Map();
  for (const it of items) {
    if (!it.crowd || !it.d || now - Date.parse(it.d) > 60 * 864e5) continue;
    const m = String(it.t).match(CROWD_NAME); if (!m) continue;
    const name = m[1].replace(/^(The|New|A|An)\s+/, '').replace(/(\s+(Trading|Official))+$/, '').trim(), k = normName(name);
    if (!k || k.length < 3 || [...seen].some(s => s && (k === s || k.startsWith(s + ' ') || s.startsWith(k + ' ')))) continue;
    if (!out.has(k)) out.set(k, { name, t: it.t, u: it.u, d: it.d, src: it.src });
  }
  return [...out.values()];
}

async function runReleases(env = {}) {
  const log = env.log || ((...a) => console.log(new Date().toISOString().slice(11, 19), 'releases:', ...a));
  const fetchFn = env.fetch || fetch;
  const gh = env.gh || new GitHub({ repo: env.repo || process.env.GITHUB_REPOSITORY, token: env.token || process.env.GITHUB_TOKEN, fetch: fetchFn, log });
  const appId = env.appId ?? process.env.EBAY_APP_ID, certId = env.certId ?? process.env.EBAY_CERT_ID, campaign = env.campaign ?? (process.env.EBAY_CAMPAIGN_ID || '5339254309');
  const now = env.now || Date.now();
  let prev = null; try { const b = await gh.download('prices', 'releases.json'); prev = b ? JSON.parse(b) : null; } catch (_) {}
  if (!(env.force ?? process.env.RELEASES_FORCE) && prev && prev.v === RELEASES_VERSION && now - Date.parse(prev.updated) < CFG.every * 3600000) { log('up to date'); return { skipped: true }; }
  const ua = env.ua || 'MintyPrices/1.0 (+https://github.com/earnviacrypto/minty-prices)';
  const getJ = async u => { const r = await fetchFn(u, { headers: { 'user-agent': ua } }); if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); };
  const priceFiles = {}, games = {}, raw = {};
  for (const cat of GAMES) { const b = await gh.download('prices', `prices-${cat}.json.gz`); if (b) priceFiles[cat] = JSON.parse(zlib.gunzipSync(b)); }
  // every other card game TCGplayer lists: its sets in the window, with their products and prices, read straight from TCGCSV
  try {
    const cats = (await getJ('https://tcgcsv.com/tcgplayer/categories')).results || [];
    for (const c of cats) games[c.categoryId] = c.displayName || c.name;
    const t = dayNo(new Date(now).toISOString());
    for (const c of cats) {
      if (GAMES.includes(c.categoryId) || NOT_TCG.test(games[c.categoryId])) continue;
      try {
        const gs = ((await getJ(`https://tcgcsv.com/tcgplayer/${c.categoryId}/groups`)).results || []).filter(g => { const d = relDay(g); return d && dayNo(d) - t <= CFG.ahead && dayNo(d) - t >= -CFG.back && !SKIP_SET.test(g.name); });
        if (!gs.length) continue;
        const pf = { groups: gs, products: {}, prices: {} };
        for (const g of gs) {
          const prods = (await getJ(`https://tcgcsv.com/tcgplayer/${c.categoryId}/${g.groupId}/products`)).results || [];
          raw[g.groupId] = prods;
          pf.products[g.groupId] = prods.map(x => [x.productId, x.name, '', '', x.imageUrl || '', (x.extendedData || []).some(e => e.name === 'Number') ? 1 : 0]);
          const pr = {}; for (const x of ((await getJ(`https://tcgcsv.com/tcgplayer/${c.categoryId}/${g.groupId}/prices`)).results || [])) if (x.marketPrice > 0) (pr[x.productId] = pr[x.productId] || {})[x.subTypeName || 'Normal'] = x.marketPrice;
          pf.prices[g.groupId] = pr;
          if (!env.fast) await sleep(120);
        }
        priceFiles[c.categoryId] = pf;
      } catch (e) { log(games[c.categoryId], e.message); }
      if (!env.fast) await sleep(120);
    }
  } catch (e) { log('other games', e.message); }
  const sets = pickSets(priceFiles, new Date(now).toISOString());
  for (const r of sets) r.game = games[r.cat] || null;
  for (const r of sets) { // the set's product details, for the pop-up
    try {
      const prods = raw[r.g] || (await getJ(`https://tcgcsv.com/tcgplayer/${r.cat}/${r.g}/products`)).results || [];
      r.info = detailsOf(r, prods, priceFiles[r.cat]);
      if (!raw[r.g] && !env.fast) await sleep(150);
    } catch (e) { log(r.set, 'details', e.message); }
  }
  const eb = appId && certId ? (env.ebay || new Ebay({ appId, certId, campaign, fetch: fetchFn, log })) : null;
  let searched = 0;
  const old = new Map(((prev && prev.v === RELEASES_VERSION && prev.sets) || []).map(x => [x.cat + '|' + x.g, x]));
  for (const r of sets) {
    if (!eb) break;
    const o = old.get(r.cat + '|' + r.g); // a set checked in the last day keeps that answer (eBay calls are shared with the deals)
    if (o && o.checked && now - Date.parse(o.checked) < 24 * 3600000) { if (o.link) r.link = o.link; r.checked = o.checked; continue; }
    r.checked = new Date(now).toISOString();
    for (const it of r.items.slice(0, CFG.tryItems)) {
      let list;
      try { list = await eb.find(queryOf(r, it)); searched++; }
      catch (e) { log(r.set, e.message); if (e.limit) break; continue; }
      const tr = list.filter(l => l.topRatedBuyingExperience === true), hi = tr.filter(l => parseFloat((l.seller || {}).feedbackPercentage) >= CFG.minFeedback && (l.seller || {}).feedbackScore >= CFG.minRatings);
      log(`${queryOf(r, it)}: ${list.length} listings, ${tr.length} Top Rated, ${hi.length} at 99.7%/500` + (hi[0] ? ` – e.g. "${hi[0].title}" $${hi[0].price && hi[0].price.value} ${hi[0].condition || ''}` : ''));
      const ok = list.filter(l => linkOk(r, it, l)).sort((a, b) => parseFloat(a.price.value) - parseFloat(b.price.value));
      if (ok.length) { r.link = { id: it.id, u: ok[0].itemAffiliateWebUrl || ok[0].itemWebUrl, t: ok[0].title, p: ok[0].price.value, fb: (ok[0].seller || {}).feedbackPercentage, n: (ok[0].seller || {}).feedbackScore }; break; }
      if (!env.fast) await sleep(250);
    }
  }
  let news = null; try { const b = await gh.download('prices', 'news.json'); news = b ? JSON.parse(b) : null; } catch (_) {}
  const crowd = crowdGames((news && news.items) || [], Object.values(games), now);
  const out = { v: RELEASES_VERSION, updated: new Date(now).toISOString(), bar: { pct: CFG.minFeedback, ratings: CFG.minRatings, topRated: false }, games, sets, crowd };
  await gh.put('prices', 'releases.json', Buffer.from(JSON.stringify(out)));
  log(`${sets.length} sets, ${searched} eBay searches, ${sets.filter(r => r.link).length} with a seller link`);
  return { sets: sets.length, searched };
}

module.exports = { crowdGames, gameWord, detailsOf, insideOf, aboutOf, runReleases, pickSets, linkOk, queryOf, kindOf, CFG, RELEASES_VERSION };
if (require.main === module) runReleases().catch(e => { console.error(e); process.exit(1); });
