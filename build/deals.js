// Deal finder: eBay Buy It Now listings well under the TCGplayer market price, for the cards and sealed products in the
// market indexes. Runs after the price job every hour, and only when the eBay keys are set as repository secrets
// (EBAY_APP_ID, EBAY_CERT_ID; the EPN campaign defaults to 5339254309). Everyone's Minty reads the one file it
// writes (prices/deals.json) – no copy of Minty ever searches eBay itself, so users never use up eBay searches.
//
// Budget: eBay allows 5,000 calls a day per app (reset at midnight Pacific). 3,800 searches, spread over the hours, and
// up to 700 listing look-ups (a card deal's own Card Condition and eBay catalog product, each listing once):
//  - items worth $200+ are searched every 6 hours, items worth $20–200 once a day, items under $20 never;
//  - what is left of each hour's share rechecks items that have deals, so sold listings drop off sooner.
// One search per item, asking eBay only for Buy It Now listings from US sellers priced 40–85% of market.
const zlib = require('zlib');
const { GitHub, sleep } = require('./gh');

const DEALS_VERSION = 1;
// listTop: the dearest items, searched every listEvery hours so their listings can be shown (eBay: listing information
// shown may be at most 6 hours older than on eBay – `stale`); the rest once a day, for deals only.
const CFG = { minPeers: 3, trust: 0.8, dayBudget: 3800, lookDay: 700, lookKeep: 14, minMarket: 20, listTop: 650, listLo: 5, listHi: 250, perSetCards: 4, perSetSealed: 2, listEvery: 5, keepListings: 8, stale: 6, lowEvery: 24, recheckAfter: 2, minOff: 0.15, maxOff: 0.45, minFeedback: 98, minRatings: 50, keep: 300 };
// Search word for each TCGplayer category (how eBay sellers write the game).
const GAME_WORD = { 1: 'MTG', 2: 'Yugioh', 3: 'Pokemon', 16: 'Vanguard', 17: 'Force of Will', 20: 'Weiss Schwarz', 24: 'Final Fantasy TCG', 25: 'UniVersus', 27: 'Dragon Ball Super', 57: 'Transformers TCG', 62: 'Flesh and Blood', 63: 'Digimon', 66: 'MetaZoo', 67: 'Wixoss', 68: 'One Piece', 71: 'Lorcana', 72: 'Battle Spirits', 73: 'Shadowverse', 74: 'Grand Archive', 77: 'Sorcery', 79: 'Star Wars Unlimited', 80: 'Dragon Ball Fusion World', 81: 'Union Arena', 83: 'Elestrals', 85: 'Pokemon Japanese', 86: 'Gundam', 87: 'hololive', 89: 'Riftbound', 91: 'Palworld', 92: 'Cyberpunk' };
const BAD_WORDS = ['proxy', 'custom', 'orica', 'replica', 'fan art', 'fanart', 'digital', 'code card', 'online code', 'lot', 'you pick', 'pick your', 'choose', 'mystery', 'repack', 'reprint', 'fake', 'not real', 'damaged', 'read description', 'see description', 'empty', 'opened', 'resealed', 'no packs', 'art card', 'sticker', 'playmat', 'sleeve', 'binder', 'display only', 'torn', 'ripped', 'rip tear', 'crushed', 'dented', 'dent', 'water damage', 'poster only', 'box only', 'case only', 'empty box', 'no cards', 'mapped', 'weighed', 'read details', 'protector', 'protectors', 'dmg', 'heavily played', 'poor', 'display case', 'case for', 'extended art case', 'extended artwork', 'artwork case', 'magnetic', 'frame', 'unsealed'];
const GRADED_WORDS = ['psa', 'bgs', 'cgc', 'tag', 'sgc', 'beckett', 'graded', 'gem mint', 'slab', 'slabbed', 'pcg'];
const FOREIGN_WORDS = ['japanese', 'japan', 'jp', 'jpn', 'jap', 'korean', 'chinese', 'german', 'french', 'italian', 'spanish', 'portuguese', 'thai', 'indonesian'];

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
  if (!foreignItem && FOREIGN_WORDS.some(w => t.includes(' ' + w + ' ') || t.includes('-' + w + ' ') || t.includes(' ' + w + '-'))) return 'language'; // also "S-Chinese", "Chinese-Simplified"
  if (!foreignItem && +it.cat === 3 && (JP_SET.test(t) || t.includes(' pokemon card 151 '))) return 'language'; // a Japanese set code ("SV2a", "S12a", "SM11b") on an English card
  if (it.kind === 'sealed' && l.condition && !/^(new|ungraded)/i.test(l.condition)) return 'not new'; // used, open box, unspecified ("Ungraded": a sealed promo listed as a card)
  if (it.kind === 'sealed' && / (eu|eu print|european) /.test(t)) return 'language';
  if (it.kind === 'sealed' && / ([2-9]|1\d) ?x | x ?([2-9]|1\d) /.test(t) && !/ ([2-9]|1\d) ?x | x ?([2-9]|1\d) /.test(norm(it.name))) return 'quantity'; // "2X …", "… x2": more than one
  if (it.kind !== 'sealed') {
    const tp = t.replace(/\//g, ' ');
    if (PLAYED.test(tp) || / [a-z]*played /.test(tp) || [...tp.matchAll(/ (\S+) hp /g)].some(m => !/^\d+$/.test(m[1]))) return 'played'; // the market price is for Near Mint ("HP" after a number is the card's hit points)
    if (JUMBO.test(t) && !JUMBO.test(norm(it.name + ' ' + it.set))) return 'jumbo';
    if (+it.cat === 3 && REPRINT.test(t) && !REPRINT.test(norm(it.name + ' ' + it.set))) return 'other set'; // a 30th Celebration / Classic Collection reprint listed under the original
    if (GRADED_WORDS.some(w => t.includes(' ' + w + ' '))) return 'graded';
    if (l.conditionId === '2750' || /^graded/i.test(l.condition || '')) return 'graded';
    const forms = numForms(it.number);
    if (forms.length && !forms.some(f => t.includes(' ' + f + ' ') || t.includes(' ' + f.replace(/\//g, ' / ') + ' ') || t.includes('#' + f))) return 'number';
  } else {
    if (/\bcase\b/i.test(it.name) !== /\bcase\b/.test(t)) return 'case';
    if (GRADED_WORDS.some(w => t.includes(' ' + w + ' ')) || /\bgraded\b|\bgm\b|\bmt ?10\b|gem mt/.test(t)) return 'graded'; // a slab promo listed under the box
  }
  const need = words(it.kind === 'sealed' ? it.name : baseName(it.name));
  if (need.some(w => !t.includes(' ' + w + ' ') && !t.includes(' ' + w))) return 'name';
  if (it.kind !== 'sealed' && !(UNIQUE_NO.has(+it.cat) && numForms(it.number).length)) { // "(SP)", "(Wanted Poster)", "(Gold)": the version in brackets has to be in the title too
    const vw = variantWords(it.name);
    if (vw.some(alts => !alts.some(a => t.includes(' ' + a + ' ')))) return 'version';
    const mine = ' ' + vw.map(a => a[0]).join(' ') + ' ' + norm(it.set);
    if (VARIANT_FLAGS.some(([f, k]) => t.includes(f) && !mine.includes(' ' + k)) ) return 'version'; // an alt art or anniversary printing listed for the plain card
  }
  if (it.kind !== 'sealed' && EVENT_FLAGS.some(f => t.includes(f) && !norm(it.name + ' ' + it.set).includes(f))) return 'version'; // stamped, pre-release, staff…
  if (otherSet(it, t)) return 'other set';
  if (it.kind !== 'sealed' && EVENT_SET.test(it.set || '')) { // a stamped event or promo printing: the event has to be named, not just the number
    const sw = setWords(it.set);
    if (sw.length && sw.some(w => !t.includes(' ' + w))) return 'set';
  }
  if (it.kind === 'sealed' && !/promo/i.test(it.name) && (/ promos? |promos?-\d/.test(t) || / stamped /.test(t) || /\b\d{1,3}\/[a-z]{0,4}\d{1,3}\b|#\d{2,3}\b/.test(t))) return 'single card'; // a promo card listed under the box it came in
  if (it.kind !== 'sealed' && !numForms(it.number).length) { // no card number to check: the set has to be named instead
    const sw = setWords(it.set);
    if (!sw.length || sw.some(w => !t.includes(' ' + w))) return 'set';
  }
  // Another edition of the product: an anniversary or edition number ("30th", "25th") or a year newer than the set.
  const mineAll = norm(it.name + ' ' + it.set);
  // "30th Anniversary" on a 2021 Celebrations box: the game's Nth anniversary falls in another year than the set's
  if (it.yr && LAUNCH[it.cat]) for (const m of t.matchAll(/ (\d{1,2})(st|nd|rd|th) anniversary /g)) if (Math.abs(LAUNCH[it.cat] + +m[1] - it.yr) > 1 && !mineAll.includes(' ' + m[1] + m[2] + ' ')) return 'edition';
  // "30th Celebrations" on a 2021 Celebrations box: an ordinal of 10+ that is not the product's own and falls in another year
  if (it.yr && LAUNCH[it.cat]) for (const m of t.matchAll(/ (\d{2})(st|nd|rd|th) /g)) if (Math.abs(LAUNCH[it.cat] + +m[1] - it.yr) > 1 && !mineAll.includes(' ' + m[1] + m[2] + ' ')) return 'edition';
  // another volume ("Vol. 3" listed under "Vol. 2")
  { const v = x => (x.match(/ vol(?:ume)? ?(\d+) /) || [])[1], a = v(t), b = v(mineAll); if (a && b && a !== b) return 'edition'; }
  // sealed only: card sellers often write the wrong year
  if (it.yr && it.kind === 'sealed') for (const m of t.matchAll(/ (20[1-3]\d) /g)) if (+m[1] > it.yr + 1 && !mineAll.includes(' ' + m[1] + ' ')) return 'edition';
  if (it.kind === 'sealed') {
    const odd = SEALED_ODD.find(w => t.includes(w) && !mineAll.includes(w));
    if (odd) return 'not the same product';
    if (mineAll.includes(' pokemon center ') && !t.includes(' pokemon center ')) return 'not the same product';
  }
  if (it.kind === 'sealed') { // a booster box listing must not be a bundle, an ETB or a set of something else
    const want = sealedTypes(norm(it.name)), got = sealedTypes(t);
    if (want.size && ![...want].some(x => got.has(x))) return 'type';
    if ([...got].some(x => !want.has(x))) return 'type';
    const sw = setWords(it.set).filter(w => !need.includes(w));
    if (sw.length && sw.some(w => !t.includes(' ' + w))) return 'set';
  }
  return '';
}
// Games where a card number alone names the printing (Pokémon); elsewhere variants share the number.
const UNIQUE_NO = new Set([3, 85]);
const VARIANT_FLAGS = [[' alt art ', 'alternate'], [' alternate art ', 'alternate'], [' parallel ', 'parallel'], [' aa ', 'parallel'], [' sp ', 'sp'], [' manga ', 'manga'], [' anniversary ', 'anniversary'], [' wanted poster ', 'wanted'], [' treasure rare ', 'treasure'], [' premium card collection ', 'premium'], [' best selection ', 'best']];
// Words in a sealed listing that make it another product, unless the product's own name has them: a store's own version,
// part of a box, an incomplete or opened one, a pre-order, an Asian (OCG) printing.
// The year each game began, for its anniversary products (Pokémon's 25th = 2021, 30th = 2026).
const LAUNCH = { 1: 1993, 2: 1999, 3: 1996, 85: 1996 };
const SEALED_ODD = [' pokemon center ', ' costco ', ' sam s club ', ' walmart ', ' target exclusive ', ' gamestop ', ' half ', ' 18 packs ', ' missing ', ' incomplete ', ' no foil ', ' pre-order ', ' preorder ', ' pre order ', ' ocg ', ' prerelease ', ' pre-release ', ' build battle ', ' international '];
// A played copy (the market price is for Near Mint) or a jumbo/oversized card listed under the normal one.
const PLAYED = / (lp|mp|dm|played|light play|lightly play|moderate play|medium play|heavy play|crease|creased|creases|bent|whitening) /;
const REPRINT = / (celebration|celebrations|classic collection) /;
const JUMBO = / (jumbo|oversized?|big card|large card) /;
const EVENT_FLAGS = [' stamped ', ' prerelease ', ' pre-release ', ' staff ', ' championship ', ' judge ', ' prize pack ', ' play pokemon '];
// Japanese Pokémon set codes: a letter after the number (SV2a, SV5k, S12a, SM11b, M2a). English codes have none (SV08, ME01).
const JP_SET = / (sv\d{1,2}[a-z]|s\d{1,2}[a-z]|sm\d{1,2}[a-z]|m\d[a-z]) /;
const EVENT_SET = /promo|event|tournament|prize|pre-?release|championship|celebration|anniversary|premium card|judge|store|league/i;
// Words in a card name's brackets, each with the ways sellers write it. Plain printing words are not required.
const VARIANT_SKIP = new Set(['version', 'set', 'card', 'cards', 'the', 'and', 'non', 'foil', 'holofoil', 'normal', 'english', 'eng', 'pack', 'promo', 'edition', 'print', 'printing']);
const VARIANT_ALT = { alternate: ['alternate', 'alt'], parallel: ['parallel', 'alt', 'aa'], secret: ['secret', 'sec', 'sir', 'scr'], 'full': ['full', 'fa'], 'japanese': ['japanese', 'jp', 'jpn', 'japan'], 'anniversary': ['anniversary', 'anniv'], 'treasure': ['treasure', 'tr'] };
function variantWords(name) {
  const out = [];
  for (const m of String(name || '').matchAll(/\(([^)]*)\)/g)) for (const w of norm(m[1]).trim().split(' ')) {
    if (!w || VARIANT_SKIP.has(w) || /^\d+$/.test(w) || (w.length < 2)) continue;
    out.push(VARIANT_ALT[w] || [w]);
  }
  return out;
}
// Another set of the same game named in the title ("Perfect Order 3 Pack Booster Bundle" under Mega Evolution).
let OTHER = {};
function useSetNames(names) {
  OTHER = {};
  for (const [cat, list] of Object.entries(names || {})) OTHER[cat] = [...new Set(list.map(setPhrase).filter(Boolean))];
}
// A set name as sellers write it, for spotting it in a title: "ME02: Phantasmal Flames" → " phantasmal flames ". Too short or too generic: none.
function setPhrase(n) {
  const ph = norm(String(n || '').replace(/^[A-Z]{1,5}\d{0,3}[a-z]?:\s*/, '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' '));
  const w = ph.trim().split(' ').filter(Boolean);
  if (w.length < 2 || ph.trim().length < 8 || w.every(x => SET_SKIP.has(x) || x.length < 3 || /^\d+$/.test(x))) return '';
  return ph;
}
function otherSet(it, t) {
  const own = setPhrase(it.set) || norm(it.set), nm = norm(it.name);
  return (OTHER[it.cat] || []).some(ph => t.includes(ph) && !own.includes(ph) && !ph.includes(own.trim() ? own : '\u0000') && !nm.includes(ph));
}
// The words that name a set, without the game and generic words ("ME01: Mega Evolution" → mega, evolution).
const SET_SKIP = new Set(['pokemon', 'one', 'piece', 'yugioh', 'magic', 'gathering', 'promotion', 'promotional', 'promo', 'promos', 'cards', 'card', 'set', 'series', 'collection', 'boxes', 'box', 'collectors', 'collector', 'products', 'product', 'sealed', 'japanese', 'english', 'edition', 'booster', 'vol', 'the', 'best', 'premium', 'special', 'misc', 'miscellaneous']);
const setWords = s => words(String(s || '').replace(/^[A-Z]{1,5}\d{0,3}[a-z]?:\s*/, '')).filter(w => !SET_SKIP.has(w) && !/^\d+$/.test(w));
// Kinds of sealed product a title names. "Booster Bundle Box" is a bundle, not a box.
const SEALED_TYPES = [['set', / (collector|gift|collectors) set /], ['etb', / elite trainer | etb /], ['bundle', / bundle /], ['collection', / (premium|special|ultra premium|super premium|poster|pin|figure|binder|ex|vmax|vstar|gx|box) collection /], ['collector', / collector s? (box|set|chest) /], ['display', / display /], ['case', / case /], ['tin', / tins? /], ['blister', / blister /], ['deck', / deck /], ['pack', / packs? (?!box)/], ['box', / booster box /]];
function sealedTypes(t) {
  const out = new Set(); let s = t;
  for (const [k, re] of SEALED_TYPES) if (re.test(s)) { out.add(k); if (k === 'bundle' || k === 'etb') s = s.replace(/ booster box /g, ' '); }
  if (out.has('box') || out.has('etb') || out.has('bundle') || out.has('display') || out.has('collection') || out.has('collector')) out.delete('pack'); // "36 packs" inside a box
  return out;
}
// A single card still in its wrapper: a card listed as sealed, or a sealed promo (event pack, promo in cellophane) that
// eBay files as a card. Shown under "Sealed cards", apart from loose cards and from boxes, packs and bundles.
const SEALED_CARD = / (sealed|factory sealed|unopened|still sealed|in cellophane|cello|cellophane|blister) /;
function sealedCard(it, l) {
  if (it.kind === 'sealed') return /^(ungraded|graded)/i.test(l.condition || '');
  return SEALED_CARD.test(norm(l.title)) && !/sealed/i.test(it.name || '');
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
    sub: sealedCard(it, l) ? 'scard' : undefined, cond: l.condition || '', fb: parseFloat(s.feedbackPercentage), fbScore: s.feedbackScore, img: (l.image && l.image.imageUrl) || ((l.thumbnailImages || [])[0] || {}).imageUrl || '',
    url: l.itemWebUrl, aff: l.itemAffiliateWebUrl || '', found: now, checked: now };
}
// One listing for an item's "Check out these listings" box: the same checks as a deal (US seller with good feedback, Buy It Now,
// shipping known, the right item, not graded/foreign/proxy) but any price from 40% of market up. No seller name is kept.
function listingFrom(it, l, anyPrice) {
  if (!l || !l.price || l.price.currency !== 'USD') return null;
  if (!(l.buyingOptions || []).includes('FIXED_PRICE')) return null;
  if (l.itemLocation && l.itemLocation.country && l.itemLocation.country !== 'US') return null;
  const s = l.seller || {};
  if (!(parseFloat(s.feedbackPercentage) >= CFG.minFeedback) || !(s.feedbackScore >= CFG.minRatings)) return null;
  const so = (l.shippingOptions || [])[0];
  let ship = 0;
  if (so) { if (so.shippingCostType === 'CALCULATED' && !so.shippingCost) return null; ship = so.shippingCost ? parseFloat(so.shippingCost.value) || 0 : 0; }
  const price = parseFloat(l.price.value);
  if (!anyPrice && !(price + ship >= it.market * (1 - CFG.maxOff))) return null;
  if (rejectReason(it, l)) return null;
  return { id: l.itemId, t: l.title, p: price, s: Math.round(ship * 100) / 100, c: l.condition || '', img: (l.image && l.image.imageUrl) || ((l.thumbnailImages || [])[0] || {}).imageUrl || '', u: l.itemAffiliateWebUrl || l.itemWebUrl };
}
// The items to watch: every member of the market indexes worth $20+, with the lowest TCGplayer market price among the
// products sharing its set and number (a cheaper printing of the same card must not look like a deal on the dear one).
function itemsFrom(indexes, priceFiles) {
  const out = [];
  for (const [cat, x] of Object.entries(indexes.cats || {})) {
    const pf = priceFiles[cat]; if (!pf) continue;
    const ids = new Set([].concat(x.cards && x.cards.ids || [], x.sealed && x.sealed.ids || []));
    if (!ids.size) continue;
    const setName = new Map((pf.groups || []).map(g => [String(g.groupId), g.name])), setYear = new Map((pf.groups || []).map(g => [String(g.groupId), relYear(g)]));
    for (const [g, list] of Object.entries(pf.products || {})) {
      const pr = (pf.prices || {})[g] || {};
      const minOf = id => { const v = Object.values(pr[id] || {}).filter(p => p > 0); return v.length ? Math.min(...v) : null; };
      for (const p of list) {
        if (!ids.has(p[0])) continue;
        let market = minOf(p[0]);
        if (p[5] && p[2]) for (const q of list) if (q !== p && q[5] && q[2] === p[2]) { const m = minOf(q[0]); if (m && (!market || m < market)) market = m; }
        if (!(market >= CFG.minMarket)) continue;
        out.push({ id: p[0], cat: +cat, g: +g, kind: p[5] ? 'card' : 'sealed', name: p[1], number: p[5] ? p[2] || '' : '', set: setName.get(String(g)) || '', yr: setYear.get(String(g)) || null, market });
      }
    }
  }
  return out;
}
// A set's release year when TCGplayer gives a real release date (a plain day); older sets carry the date it last touched them.
function relYear(g) { const d = String((g && g.publishedOn) || ''); return /T00:00:00(\.0+)?$/.test(d) ? +d.slice(0, 4) : null; }
// Pacific-time day (eBay's quota day) and how many hours of it are left.
function pacific(now) {
  const d = new Date(now), parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(d);
  const v = k => parts.find(p => p.type === k).value;
  return { day: `${v('year')}-${v('month')}-${v('day')}`, hoursLeft: 24 - (parseInt(v('hour'), 10) % 24) };
}
// The items whose listings are shown on card pages (listTop of them): what most people own and buy, not the dearest –
// cards from $5 to $250 and sealed products from $20, newest sets first, a handful from each set, and slots shared out by
// how big each game is. Card pages without their own listings show these as "More from <set>".
const LIST_SKIP = /code card|jumbo|oversized|promo|pop series|trainer kit|miscellaneous|blister|world collection|burger king|mcdonald|professor program|first partner|prize pack|league|deck|art series|tins?$|collection$/i;
const LIST_SHARE = { 3: 0.38, 68: 0.14, 1: 0.10, 71: 0.07, 2: 0.07, 89: 0.07, 85: 0.05 };
// Every game gets at least LIST_MIN items, so a card page always has a full row of 4 others to show; the extra slots come
// out of the biggest game's share. A game raised to the minimum lists its sealed products first (its booster boxes).
const LIST_MIN = 8, SEALED_HI = 1000, LIST_V = '/list5'; // LIST_V: bump to rebuild the watched list at once
function listSlots(cats, total) {
  const known = cats.filter(c => LIST_SHARE[c]), rest = cats.filter(c => !LIST_SHARE[c]);
  const restShare = Math.max(0, 1 - known.reduce((a, c) => a + LIST_SHARE[c], 0));
  const slots = {}, raised = new Set();
  for (const c of cats) { slots[c] = Math.round(total * (LIST_SHARE[c] || (rest.length ? restShare / rest.length : 0))); if (slots[c] < LIST_MIN) { slots[c] = LIST_MIN; raised.add(c); } }
  let over = Object.values(slots).reduce((a, b) => a + b, 0) - total;
  const big = cats.filter(c => !raised.has(c)), pool = big.reduce((a, c) => a + slots[c], 0);
  for (const c of big) { if (over <= 0 || !pool) break; slots[c] = Math.max(LIST_MIN, slots[c] - Math.round((slots[c] / pool) * over)); } // shared by the big games, by size
  let left = Object.values(slots).reduce((a, b) => a + b, 0) - total;
  while (left !== 0) { const c = big.slice().sort((a, b) => slots[b] - slots[a])[0]; if (!c) break; slots[c] -= Math.sign(left); left -= Math.sign(left); } // rounding
  return { slots, raised };
}
function listPick(priceFiles, total = CFG.listTop) {
  const cats = Object.keys(priceFiles), { slots: S, raised } = listSlots(cats, total);
  const out = [];
  for (const cat of cats) {
    const pf = priceFiles[cat], slots = S[cat];
    if (!slots) continue;
    // a real release date is a plain day ("2026-11-06T00:00:00"); older sets carry the date TCGplayer last touched them
    const rel = g => /T00:00:00(\.0+)?$/.test(String(g.publishedOn || '')) ? String(g.publishedOn) : '';
    const groups = (pf.groups || []).filter(g => !LIST_SKIP.test(g.name)).sort((a, b) => rel(b).localeCompare(rel(a)) || b.groupId - a.groupId);
    const queues = groups.map(g => {
      const pr = (pf.prices || {})[g.groupId] || {}, list = (pf.products || {})[g.groupId] || [];
      const mk = id => { const v = Object.values(pr[id] || {}).filter(x => x > 0); return v.length ? Math.min(...v) : null; };
      const rows = list.map(p => ({ id: p[0], cat: +cat, g: g.groupId, kind: p[5] ? 'card' : 'sealed', name: p[1], number: p[5] ? p[2] || '' : '', set: g.name, yr: relYear(g), market: mk(p[0]) })).filter(x => x.market);
      const cards = rows.filter(x => x.kind === 'card' && x.market >= CFG.listLo && x.market <= CFG.listHi).sort((a, b) => b.market - a.market).slice(0, CFG.perSetCards);
      // boxes, ETBs, bundles – not cases
      const sealed = rows.filter(x => x.kind === 'sealed' && x.market >= CFG.minMarket && x.market <= SEALED_HI && !/\bcase\b/i.test(x.name)).sort((a, b) => b.market - a.market).slice(0, CFG.perSetSealed);
      return raised.has(cat) ? sealed.concat(cards) : cards.concat(sealed);
    });
    let taken = 0;
    for (const q of queues) { for (const x of q) { if (taken >= slots) break; out.push(x); taken++; } if (taken >= slots) break; } // newest set first, a handful from each
  }
  return out;
}
// Which items to search this hour: the dearest listTop every listEvery hours (their listings are shown), the rest once
// a day; overdue top items first, then the longest unchecked, dearest first. Then rechecks of items with deals.
function plan(items, st, deals, now, allowance, listIds) {
  const H = 3600000, last = id => (st.checked && st.checked[id]) || 0;
  const top = listIds || new Set(items.slice().sort((a, b) => b.market - a.market).slice(0, CFG.listTop).map(it => it.id));
  const due = items.filter(it => now - last(it.id) >= (top.has(it.id) ? CFG.listEvery : CFG.lowEvery) * H)
    .sort((a, b) => top.has(b.id) - top.has(a.id) || last(a.id) - last(b.id) || b.market - a.market);
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
    // one search feeds both the deals (15–60% under market) and the item's listings box (cheapest first, from 40% of market up)
    const lo = Math.floor(it.market * (1 - CFG.maxOff) * 100) / 100;
    const filter = `buyingOptions:{FIXED_PRICE},itemLocationCountry:US,deliveryCountry:US,priceCurrency:USD,price:[${lo}..]`;
    const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?' + new URLSearchParams({ q: buildQuery(it), filter, limit: '50', sort: 'price' });
    const headers = { authorization: 'Bearer ' + await this.auth(), 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' };
    if (this.campaign) headers['X-EBAY-C-ENDUSERCTX'] = `affiliateCampaignId=${this.campaign},affiliateReferenceId=minty`;
    this.count++;
    const r = await this.fetch(url, { headers });
    if (r.status === 429) { const e = new Error('eBay daily limit reached'); e.limit = true; throw e; }
    if (!r.ok) throw new Error('eBay search: ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return (await r.json()).itemSummaries || [];
  }
  // One listing's own details: the seller's Card Condition (eBay's fixed list – "Near mint or better", "Lightly played
  // (Excellent)" …), whether it is graded, and the eBay catalog product it is attached to.
  async look(lid) {
    const headers = { authorization: 'Bearer ' + await this.auth(), 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' };
    this.count++;
    const r = await this.fetch('https://api.ebay.com/buy/browse/v1/item/' + encodeURIComponent(lid), { headers });
    if (r.status === 429) { const e = new Error('eBay daily limit reached'); e.limit = true; throw e; }
    if (!r.ok) throw new Error('eBay item: ' + r.status);
    const j = await r.json(), ds = j.conditionDescriptors || [];
    const cc = ds.find(d => /card condition/i.test(d.name || '')), graded = ds.some(d => /grader|grade/i.test(d.name || '')) || j.conditionId === '2750';
    return { c: cc && cc.values && cc.values[0] ? String(cc.values[0].content || '') : '', g: graded ? 1 : 0, e: j.epid ? String(j.epid) : '' };
  }
}
// Is a looked-up card listing the item, in Near Mint? (Card Condition must be eBay's "Near mint or better"; a listing
// attached to another eBay catalog product than the card's own is another card – a reprint, a jumbo, another edition.)
function lookOk(it, k, epids) {
  if (!k) return 'not checked';
  if (k.g) return 'graded';
  if (!/^near mint/i.test(k.c)) return k.c ? 'played' : 'no condition';
  if (k.e && epids && epids.length && !epids.includes(k.e)) return 'other product';
  return '';
}

// Biggest saving first; an eBay listing shows once (under the item it matches best), and one seller's identical listings once.
function cleanDeals(deals) {
  const seen = new Set(), same = new Set();
  return deals.slice().sort((a, b) => b.pct - a.pct).filter(d => {
    const k = d.pid + '|' + norm(d.title) + '|' + d.total;
    if (seen.has(d.lid) || same.has(k)) return false;
    seen.add(d.lid); same.add(k); return true;
  });
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
  if (!st.items || st.itemsBuilt !== indexes.built + LIST_V) {
    const priceFiles = {};
    for (const cat of Object.keys(indexes.cats || {})) { const b = await gh.download('prices', `prices-${cat}.json.gz`); if (b) priceFiles[cat] = JSON.parse(zlib.gunzipSync(b)); }
    const deal = itemsFrom(indexes, priceFiles), pick = listPick(priceFiles), have = new Set(deal.map(x => x.id));
    st.listIds = pick.map(x => x.id);
    st.items = deal.concat(pick.filter(x => !have.has(x.id))); st.itemsBuilt = indexes.built + LIST_V;
    st.setNames = {}; for (const [cat, pf] of Object.entries(priceFiles)) st.setNames[cat] = (pf.groups || []).map(g => g.name); // to spot a listing for another set
    log(`${st.items.length} items to watch`);
  }
  const P = pacific(now);
  if (!st.budget || st.budget.day !== P.day) st.budget = { day: P.day, used: 0 };
  const allowance = Math.max(0, Math.min(CFG.dayBudget - st.budget.used, Math.ceil((CFG.dayBudget - st.budget.used) / P.hoursLeft)));
  let deals = (prev && prev.enabled !== false ? prev.deals : []) || [];
  const lsBuf = await gh.download('prices', 'listings.json.gz');
  let LS = null; try { LS = lsBuf ? JSON.parse(zlib.gunzipSync(lsBuf)) : null; } catch (_) {}
  LS = LS && LS.items ? LS : { v: 1, items: {} };
  useSetNames(st.setNames);
  const byId = new Map(st.items.map(it => [it.id, it]));
  if (!st.budget.look) st.budget.look = 0;
  st.look = st.look || {}; for (const [k, v] of Object.entries(st.look)) if (now - v.at > CFG.lookKeep * 86400000) delete st.look[k]; // a listing's condition, looked up once
  let EP = {}; try { const b = await gh.download('prices', 'epid.json.gz'); if (b) EP = JSON.parse(zlib.gunzipSync(b)).items || {}; } catch (_) {}
  const epidsOf = it => (EP[it.id] || []).map(x => String(x[0]));
  const fresh = t => now - Date.parse(t) < CFG.stale * 3600000; // eBay: shown listing information at most 6 h old
  const firstSeen = new Map(deals.map(d => [d.lid, d.found])); // a listing seen before keeps its found time
  deals = deals.filter(d => byId.has(d.pid) && fresh(d.checked) && d.peerMid && (d.kind === 'sealed' || d.nm) && (d.kind !== 'sealed' || /^(new|ungraded)/i.test(d.cond || '')) && d.peerMid >= d.market * CFG.trust && d.total >= d.market * (1 - CFG.maxOff) && !rejectReason(byId.get(d.pid), { title: d.title })); // deals from before the eBay-price check are dropped until their item is searched again // deals kept from before pass today's checks too
  const todo = plan(st.items, st, deals, now, allowance, st.listIds ? new Set(st.listIds) : null);
  const eb = env.ebay || new Ebay({ appId, certId, campaign, fetch: fetchFn, log });
  let searched = 0, lastError = null;
  for (const it of todo) {
    let list;
    try { list = await eb.search(it); } catch (e) { log(it.name, e.message); lastError = e.message.slice(0, 300); if (e.limit || /sign-in/.test(e.message)) break; continue; } // a failed sign-in fails every search: stop
    searched++; st.budget.used++; st.checked[it.id] = now;
    const old = new Map(deals.filter(d => d.pid === it.id).map(d => [d.lid, d]));
    deals = deals.filter(d => d.pid !== it.id);
    // What this item really sells for on eBay right now: the same checks as a deal (US seller, Buy It Now, the right item),
    // any price. A deal has to be cheap against these too, not only against the market price – so a wrong or stale market
    // price (a newer edition, a box whose price fell) never makes every listing look like a bargain.
    const peers = list.map(l => listingFrom(it, l, true)).filter(Boolean).map(x => x.p + x.s).sort((a, b) => a - b);
    const peerMid = peers.length >= CFG.minPeers ? peers[Math.floor(peers.length / 2)] : null;
    const trusted = peerMid !== null && peerMid >= it.market * CFG.trust; // eBay's own listings have to back the market price up
    const sellers = new Set(), titles = new Set(); // one deal per seller per item: a seller's 40 copies of one card fill one card, not 40
    for (const l of list) {
      const d = dealFrom(it, l, new Date(now).toISOString()); if (!d) continue;
      if (!trusted || d.total > peerMid * (1 - CFG.minOff)) continue; // not cheap next to the other listings of it
      d.peers = peers.length; d.peerMid = peerMid;
      const who = (l.seller || {}).username || '', same = norm(l.title) + '|' + d.total;
      if ((who && sellers.has(who)) || titles.has(same)) continue;
      if (who) sellers.add(who); titles.add(same); // used only here – no seller name is kept
      if (it.kind !== 'sealed') { // a card: the seller's own Card Condition and eBay catalog product decide, not the title
        let k = st.look[d.lid];
        if (!k && st.budget.look < CFG.lookDay) {
          try { k = Object.assign(await eb.look(l.itemId), { at: now }); st.look[d.lid] = k; st.budget.look++; } catch (e) { log('look', e.message); if (e.limit) break; }
        }
        if (lookOk(it, k, epidsOf(it))) continue;
        d.nm = 1;
      }
      if (old.has(d.lid)) d.found = old.get(d.lid).found; else if (firstSeen.has(d.lid)) d.found = firstSeen.get(d.lid);
      deals.push(d);
    }
    const ls = []; for (const l of list) { const x = listingFrom(it, l); if (x) ls.push(x); if (ls.length >= CFG.keepListings) break; }
    LS.items[it.id] = { at: new Date(now).toISOString(), g: it.g, cat: it.cat, k: it.kind, n: it.name, num: it.number || '', m: it.market, l: ls };
    if (!env.fast) await sleep(250);
  }
  deals = deals.filter(d => fresh(d.checked));
  for (const [id, v] of Object.entries(LS.items)) if (!byId.has(+id) && !byId.has(id) || !fresh(v.at)) delete LS.items[id]; // older than 6 h or no longer watched: deleted
  deals = cleanDeals(deals).slice(0, CFG.keep);
  await gh.put('prices', 'deals.json', Buffer.from(JSON.stringify({ v: DEALS_VERSION, enabled: true, updated: new Date(now).toISOString(), items: st.items.length, budget: st.budget, lastError: searched ? null : lastError, deals })));
  await gh.put('prices', 'listings.json.gz', zlib.gzipSync(Buffer.from(JSON.stringify({ v: 1, updated: new Date(now).toISOString(), count: Object.keys(LS.items).length, items: LS.items }))));
  await gh.put('state', 'deals-state.json', Buffer.from(JSON.stringify(st)));
  log(`searched ${searched} of ${todo.length} planned (${st.budget.used} today), ${deals.length} deals`);
  return { enabled: true, searched, deals: deals.length };
}

module.exports = { sealedCard, lookOk, listSlots, listPick, runDeals, cleanDeals, useSetNames, setPhrase, variantWords, sealedTypes, setWords, buildQuery, rejectReason, dealFrom, listingFrom, itemsFrom, plan, pacific, numForms, CFG, Ebay };
if (require.main === module) runDeals().catch(e => { console.error(e); process.exit(1); });
