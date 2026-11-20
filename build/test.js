// Local test with a fake TCGCSV and a fake GitHub: node build/test.js
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const { execFileSync } = require('child_process');
const { main } = require('./run');
const { Hist, dayIndex } = require('./hist');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// ---- history store ----
{
  const h = new Hist('2024-02-08');
  h.set('1|Normal', 10, 5, 150); h.set('1|Normal', 10, 7, 175); h.set('1|Normal', 10, 2, 120); h.set('2|Foil', 11, 3, 999);
  const h2 = Hist.decode(h.encode());
  ok(h2.get('1|Normal', 2) === 120 && h2.get('1|Normal', 5) === 150 && h2.get('1|Normal', 7) === 175 && h2.get('1|Normal', 6) === 0, 'history: stored and read back, earlier day added later');
  const b = h2.bucketJson([10]);
  ok(!b['2|Foil'] && JSON.stringify(b['1|Normal']) === JSON.stringify([2, 120, null, null, 30, null, 25]), 'bucket file: only its sets; first price then changes, null for no price');
  ok(JSON.stringify(Hist.unpack('2024-02-08', b['1|Normal'])) === JSON.stringify([['2024-02-10', 1.2], ['2024-02-13', 1.5], ['2024-02-15', 1.75]]), 'unpacked back to dates and dollars');
}


// ---- grading companies ----
{
  const G = require('./grading');
  const fx = c => fs.readFileSync(path.join(__dirname, 'fixtures', c + '.txt'), 'utf8');
  const psa = G.READ.PSA(fx('psa')), tag = G.READ.TAG(fx('tag')), bgs = G.READ.BGS(fx('bgs'));
  ok(psa && psa.length === 11 && psa[0].join('|') === 'Value|$39.99|$500|90–100 business days||open' && psa[10][1] === '$9,999+' && psa[10][2] === 'over $250,000', 'PSA page: every listed tier with price, cover and wait');
  ok(tag && tag.length === 6 && tag[0].join('|') === 'Value|$29.95|$250|90 business days|10 cards|open' && tag[5][2] === '$5,000', 'TAG page: tiers with card minimums and protection');
  ok(bgs && bgs.length === 5 && bgs.filter(t => t[5] === 'sold').length === 4 && bgs[3].join('|') === 'Express|$79.95||15 business days||open' && bgs[0][4] === 'No sub-grades', 'Beckett page: sold-out tiers marked, the two Base prices told apart');
  const cgc = G.READ.CGC(fx('cgc'));
  ok(cgc && cgc.length === 6 && cgc[0].join('|') === 'Bulk|$17|$500|150 working days|25 cards|open' && cgc[5].join('|') === 'Unlimited|$300 + 1% of value|any value|2 working days||open', 'CGC page: tiers with value cap, fee, wait and the bulk minimum');
  ok(G.READ.PSA('Just a moment...') === null && G.READ.BGS('<title>Just a moment...</title>') === null, 'a blocked page is not read as prices');
  const merged = G.mergeTiers(psa, require('./grading-seed.json').companies.PSA.tiers);
  ok(merged.length === 14 && merged[0][0] === 'Value Bulk' && merged[0][5] === 'paused' && merged[0][4] === '50 cards, Collectors Club' && merged[1][0] === 'Value', 'tiers no longer listed stay, marked paused, in their old place');
  const at = s => Date.parse(s);
  const V = G.GRADING_VERSION;
  ok(G.due(null, at('2026-11-18T12:00:00Z')) && !G.due({ v: V, updated: '2026-11-18T11:05:00Z' }, at('2026-11-18T20:00:00Z')) && G.due({ v: V, updated: '2026-11-18T11:05:00Z' }, at('2026-11-19T11:30:00Z')) && !G.due({ v: V, updated: '2026-11-18T11:05:00Z' }, at('2026-11-19T10:30:00Z')), 'checked once a day, from 6 AM Eastern');
  ok(G.due({ v: V - 1, updated: '2026-11-18T11:05:00Z' }, at('2026-11-18T20:00:00Z')), 'a new reader runs at once, not tomorrow');
}

// ---- market indexes ----
{
  const { categoryIndexes, sizeFor } = require('./indexes');
  const h = new Hist('2024-02-08');
  // 70 cards that trade (price moves every day, card i worth i dollars, all up 10% over the period), 30 that never move
  const D = 200;
  for (let i = 1; i <= 70; i++) for (let d = 0; d < D; d++) h.set(i + '|Normal', 5, d, Math.round(i * 100 * (1 + 0.1 * d / (D - 1)) + (d % 2)));
  for (let i = 71; i <= 100; i++) for (let d = 0; d < D; d++) h.set(i + '|Normal', 5, d, 900000);
  const pf = { groups: [{ groupId: 5, name: 'Set X' }], products: { 5: Array.from({ length: 100 }, (_, k) => [k + 1, 'Card ' + (k + 1), String(k + 1), 'Rare', '', 1]) } };
  const r = categoryIndexes(h, pf, '2024-02-08');
  ok(r.cards && r.cards.n === 20 && r.sealed === null, 'index size from how many trade: 70 trading cards → 20; no sealed → no index');
  ok(r.cards.values[0] === 1000, 'starts at 1,000');
  const last = r.cards.values[r.cards.values.length - 1];
  ok(last > 1080 && last < 1120, 'follows the cards (~+10%): ' + last);
  ok(!r.cards.up.concat(r.cards.down).some(x => x.id > 70), 'cards whose price never moves are left out');
  // a quiet game: 40 cards whose price moves about once every 12 days still gets an index, at the 5-day bar
  const q = new Hist('2024-02-08');
  for (let i = 1; i <= 40; i++) for (let d = 0; d < D; d++) q.set(i + '|Normal', 6, d, i * 100 + Math.floor(d / 12));
  const pq = { groups: [{ groupId: 6, name: 'Set Q' }], products: { 6: Array.from({ length: 40 }, (_, k) => [k + 1, 'Q ' + (k + 1), String(k + 1), 'Rare', '', 1]) } };
  const rq = categoryIndexes(q, pq, '2024-02-08');
  ok(rq.cards && rq.cards.n === 20 && rq.cards.bar === 5, 'quiet game: index at the 5-day bar');
  ok(r.cards.bar === 20, 'busy game keeps the 20-day bar');
  ok(sizeFor('card', 500) === 100 && sizeFor('sealed', 30) === 10 && sizeFor('card', 10) === 0, 'sizes');
}

// ---- deal finder ----
{
  const D = require('./deals');
  const card = { id: 1, cat: 3, g: 5, kind: 'card', name: 'Umbreon VMAX (Alternate Art Secret)', number: '215/203', set: 'Evolving Skies', market: 1650 };
  ok(D.buildQuery(card) === 'Pokemon Umbreon VMAX 215/203', 'query: game, name without brackets, number: ' + D.buildQuery(card));
  const L = (title, price, extra = {}) => Object.assign({ itemId: 'v1|' + title.length + '|' + price, title, price: { value: String(price), currency: 'USD' }, buyingOptions: ['FIXED_PRICE'], itemLocation: { country: 'US' },
    seller: { username: 's', feedbackPercentage: '99.5', feedbackScore: 500 }, shippingOptions: [{ shippingCostType: 'FIXED', shippingCost: { value: '5.00' } }], condition: 'Ungraded', itemWebUrl: 'https://www.ebay.com/itm/1' }, extra);
  const now = '2026-11-18T00:00:00Z';
  const good = D.dealFrom(card, L('Pokemon Umbreon VMAX 215/203 Evolving Skies Alt Art NM', 1149.99), now);
  ok(good && good.total === 1154.99 && good.pct > 29 && good.pct < 31, 'a real deal: price + shipping, % under market');
  ok(!D.dealFrom(card, L('Umbreon VMAX 215/203 PSA 10 Evolving Skies', 1149.99), now), 'graded listing is not a raw deal');
  ok(!D.dealFrom(card, L('Umbreon VMAX 215/203 Evolving Skies PROXY', 1149.99), now), 'proxies thrown out');
  ok(!D.dealFrom(card, L('Umbreon VMAX 214/203 Evolving Skies', 1149.99), now), 'wrong card number thrown out');
  ok(!D.dealFrom(card, L('Umbreon VMAX 215/203 Evolving Skies', 500), now), 'more than 60% under: too good to be true');
  ok(!D.dealFrom(card, L('Umbreon VMAX 215/203 Evolving Skies', 1500), now), 'less than 15% under: not a deal');
  ok(!D.dealFrom(card, L('Umbreon VMAX 215/203 Evolving Skies', 1149.99, { seller: { feedbackPercentage: '95.0', feedbackScore: 900 } }), now), 'seller under 98% feedback thrown out');
  ok(!D.dealFrom(card, L('Umbreon VMAX 215/203 Evolving Skies Japanese', 1149.99), now), 'foreign listing for an English card thrown out');
  const box = { id: 2, cat: 89, g: 7, kind: 'sealed', name: 'Origins - Booster Display', number: '', set: 'Origins', market: 268.92 };
  ok(!!D.dealFrom(box, L('Riftbound Origins Booster Display 24 packs sealed', 199.99), now) && !D.dealFrom(box, L('Riftbound Origins Booster Display Case', 199.99), now), 'sealed: a case is not a box');
  ok(D.numForms('001/298').includes('1/298') && D.numForms('OP09-004')[0] === 'op09-004', 'number forms');
  // items and the hourly plan
  const ix = { cats: { 3: { cards: { ids: [10, 11, 12] }, sealed: null } } };
  const pf = { 3: { groups: [{ groupId: 5, name: 'Set' }], products: { 5: [[10, 'A', '1/9', 'R', '', 1], [11, 'A (Alt)', '1/9', 'R', '', 1], [12, 'B', '2/9', 'R', '', 1]] }, prices: { 5: { 10: { Normal: 300 }, 11: { Normal: 900 }, 12: { Normal: 10 } } } } };
  const items = D.itemsFrom(ix, pf);
  ok(items.length === 2 && items.every(x => x.market === 300), 'items: under $20 left out; same number = the cheaper printing as market');
  const H = 3600000, t0 = Date.parse('2026-11-18T12:00:00Z');
  const its = [{ id: 1, market: 500 }, { id: 2, market: 50 }, { id: 3, market: 250 }];
  const p1 = D.plan(its, { checked: { 1: t0 - 7 * H, 2: t0 - 25 * H, 3: t0 - 2 * H } }, [], t0, 10);
  ok(p1.map(x => x.id).sort().join() === '1,2', 'plan: the dearest items again after 5 h (their listings stay under 6 h old)');
  const many = Array.from({ length: D.CFG.listTop + 1 }, (_, i) => ({ id: i + 1, market: 10000 - i }));
  const chk = Object.fromEntries(many.map(x => [x.id, t0 - 6 * H]));
  ok(D.plan(many, { checked: chk }, [], t0, 5000).length === D.CFG.listTop, 'plan: past the dearest ' + D.CFG.listTop + ', once a day');
  // matching: no false deals
  const rj = (it, title) => D.rejectReason(Object.assign({ cat: 3, kind: 'card', number: '' }, it), { title });
  ok(rj({ name: 'Jolteon', set: 'Pokemon Jungle', cat: 85 }, 'Pokémon Japanese Jolteon 299/SM-P Gym Promo NEAR MINT') === 'set', 'a card with no number needs its set named');
  ok(rj({ name: 'Jolteon', set: 'Pokemon Jungle', cat: 85 }, 'Jolteon Pokemon Jungle Japanese Holo') === '', 'a card with no number and its set named is fine');
  ok(rj({ kind: 'sealed', name: 'Mega Evolution Booster Box', set: 'ME01: Mega Evolution' }, 'Pokemon Mega Evolution Booster Bundle Box Factory Sealed') === 'type', 'a booster bundle is not a booster box');
  ok(rj({ kind: 'sealed', name: 'Mega Evolution Booster Box', set: 'ME01: Mega Evolution' }, 'Pokemon Mega Evolution Booster Box 36 packs Factory Sealed') === '', 'the booster box itself matches');
  ok(rj({ kind: 'sealed', name: 'Chaos Rising Pokemon Center Elite Trainer Box', set: 'ME04: Chaos Rising' }, 'Fennekin 080 Pokemon Center Stamped Promo Chaos Rising Elite Trainer Box NM') === 'single card', 'a promo card is not the box it came in');
  ok(rj({ cat: 68, name: 'Kuzan (SP)', number: 'OP10-082', set: 'Legacy of the Master' }, 'Kuzan (Parallel) OP10-082 Super Rare One Piece') === 'version', 'One Piece: a parallel is not the SP');
  ok(rj({ cat: 68, name: 'Nico Robin', number: 'OP18-031', set: 'The Dominance of God' }, 'Nico Robin OP18-031 Alt Art One Piece') === 'version', 'an alt art is not the plain card');
  ok(rj({ cat: 68, name: 'Nico Robin', number: 'OP18-031', set: 'The Dominance of God' }, 'NICO ROBIN SR OP18-031 One Piece DOMINANCE OF GOD ENGLISH') === '', 'the plain card matches');
  D.useSetNames({ 3: ['ME01: Mega Evolution', 'ME03: Perfect Order', 'SV: White Flare'] });
  ok(rj({ kind: 'sealed', name: 'Mega Evolution Booster Bundle', set: 'ME01: Mega Evolution' }, 'Pokemon Mega Evolution Perfect Order 3 Pack Booster Bundle') === 'other set', 'another set named in the title');
  D.useSetNames({});
  ok(rj({ cat: 3, name: 'Squirtle - 170/165', number: '170/165', set: 'SV: Scarlet & Violet 151' }, 'Squirtle 170/165 Holofoil - SV2a: Pokemon Card 151 AR') === 'language', 'a Japanese set code on an English card');
  ok(rj({ cat: 3, name: 'Squirtle - 170/165', number: '170/165', set: 'SV: Scarlet & Violet 151' }, 'Squirtle 170/165 Scarlet Violet 151 Illustration Rare') === '', 'the English card still matches');
  ok(rj({ cat: 3, name: 'Basic Darkness Energy (Cracked Ice Holo)', number: '015', set: 'SVE: Scarlet & Violet Energies' }, 'Play Pokemon Basic Darkness Energy Prize Pack Series Cracked Ice Holo 015') === 'version', 'a Prize Pack stamp is another version');
  const etb = { cat: 3, kind: 'sealed', name: 'Celebrations Elite Trainer Box', set: 'Celebrations', yr: 2021 };
  ok(rj(etb, 'Pokémon 30th Anniversary Celebrations Elite Trainer Box ETB CONFIRMED') === 'edition', 'sealed: the 2026 30th anniversary box is not the 2021 Celebrations box');
  ok(rj({ cat: 3, kind: 'sealed', name: 'Celebrations Prime Collection', set: 'Celebrations', yr: 2021 }, 'Pokemon TCG 25th Anniversary Celebrations Prime Collection Box Factory Sealed') === '', 'sealed: the 2021 box sold as the 25th anniversary still matches');
  ok(rj({ cat: 3, kind: 'sealed', name: 'Celebrations Prime Collection', set: 'Celebrations', yr: 2021 }, 'Pokemon Celebrations Collection Dragapult Prime Box Two 2026 Pokemon') === 'edition', 'sealed: a year newer than the set');
  ok(rj({ cat: 3, kind: 'sealed', name: 'Fusion Strike Elite Trainer Box', set: 'SWSH08: Fusion Strike', yr: 2021 }, 'Pokemon Sword & Shield Fusion Strike Pokemon Center Elite Trainer Box') === 'not the same product', 'sealed: a Pokemon Center box is another product');
  ok(rj({ cat: 3, kind: 'sealed', name: 'Surging Sparks Booster Box', set: 'SV08: Surging Sparks', yr: 2024 }, 'Pokemon Surging Sparks Half Booster Box (18 Packs) - Brand New') === 'not the same product', 'sealed: half a box');
  ok(rj({ cat: 2, kind: 'sealed', name: 'Blazing Dominion Booster Box [1st Edition]', set: 'Blazing Dominion', yr: 2025 }, 'Yu-Gi-Oh! OCG - BLAZING DOMINION Booster Box, 1st Edition (30 packs)') === 'not the same product', 'sealed: an Asian OCG box');
  ok(rj({ cat: 3, kind: 'sealed', name: '30th Celebration Elite Trainer Box', set: 'ME: 30th Celebration', yr: 2026 }, 'Pokemon 30th Celebration Elite Trainer Box ETB 2026 Sealed') === '', 'sealed: the right 30th Celebration box still matches');
  const dd = [{ lid: 'a', pid: 1, title: 'X', total: 10, pct: 50 }, { lid: 'a', pid: 2, title: 'X', total: 10, pct: 40 }, { lid: 'b', pid: 1, title: 'X', total: 10, pct: 45 }];
  ok(D.cleanDeals(dd).length === 1, 'an eBay listing shows once, and one seller\'s identical copies once');
  const lst = D.listingFrom(card, L('Pokemon Umbreon VMAX 215/203 Evolving Skies Alt Art NM', 1700, { itemAffiliateWebUrl: 'https://www.ebay.com/itm/1?campid=5339254309' }));
  ok(lst && lst.p === 1700 && lst.s === 5 && /campid=5339254309/.test(lst.u) && !('seller' in lst) && !JSON.stringify(lst).includes('"s":"s"'), 'listing: any fair price, affiliate link, no seller name');
  ok(!D.listingFrom(card, L('Umbreon VMAX 215/203 Evolving Skies PSA 10', 1700)) && !D.listingFrom(card, L('Umbreon VMAX 215/203 Evolving Skies', 300)), 'listing: no slabs, nothing far under market');
  ok(!('seller' in good), 'deal: no seller name kept');
  const pfs = { 3: { groups: [{ groupId: 1, name: 'Old Set', publishedOn: '2000-01-01' }, { groupId: 2, name: 'New Set', publishedOn: '2026-11-01' }],
    products: { 1: [[100, 'Old Card', '1/9', 'R', '', 1]], 2: [[200, 'Cheap', '1/9', 'C', '', 1], [201, 'Mid', '2/9', 'R', '', 1], [202, 'Dear', '3/9', 'R', '', 1], [203, 'Booster Box', '', '', '', 0]] },
    prices: { 1: { 100: { Holofoil: 40 } }, 2: { 200: { Normal: 1 }, 201: { Holofoil: 30 }, 202: { Holofoil: 900 }, 203: { Normal: 140 } } } } };
  const pk = D.listPick(pfs, 100).map(x => x.id);
  ok(pk.join() === '201,203,100', 'listings pick: $5–$250 cards and sealed, newest set first, a handful from each set, newest first: ' + pk.join());
  const sl = D.listSlots(['1', '2', '3', '16', '17', '20', '24', '25', '26', '27', '57', '58', '62', '63', '65', '66', '67', '68', '71', '72', '73', '74', '77', '79', '80', '81', '83', '85', '86', '87', '89', '91', '92'], 650);
  ok(sl.slots['92'] === 8 && sl.slots['86'] === 8 && Object.values(sl.slots).reduce((a, b) => a + b, 0) === 650 && sl.raised.has('92') && !sl.raised.has('3'), 'listings pick: every game at least 8, the total unchanged');
  const pfs2 = { 92: { groups: [{ groupId: 5, name: 'Night City', publishedOn: '2026-01-01T00:00:00' }], products: { 5: [[500, 'Booster Box', '', '', '', 0], [501, 'Card A', '1/9', 'R', '', 1], [502, 'Card B', '2/9', 'R', '', 1]] }, prices: { 5: { 500: { Normal: 310 }, 501: { Normal: 12 }, 502: { Normal: 9 } } } } };
  ok(D.listPick(Object.assign({}, pfs, pfs2), 12).filter(x => x.cat === 92)[0].id === 500, 'listings pick: a small game\'s $310 booster box is watched, first');
  ok(D.plan(its, { checked: {} }, [], t0, 2).map(x => x.id).join() === '1,3', 'plan: dear items first when short of searches');
}

// ---- deal finder run (fake GitHub, fake eBay) ----

const gradingRun = async () => {
  const G = require('./grading');
  const store = {}; const gh = { download: async (t, n) => store[n] || null, put: async (t, n, b) => { store[n] = b; } };
  const pages = { 'www.psacard.com': fs.readFileSync(path.join(__dirname, 'fixtures', 'psa.txt'), 'utf8') };
  const readFetch = async (u) => { const host = new URL(u.replace('https://r.jina.ai/', '')).host; const body = u.startsWith('https://r.jina.ai/') && pages[host] ? pages[host] : '<title>Just a moment...</title>'; if (/archive\.org\/wayback/.test(u)) return { ok: true, json: async () => ({ archived_snapshots: {} }) }; return { ok: true, text: async () => body }; };
  const r = await G.runGrading({ gh, readFetch, fetch: readFetch, now: Date.parse('2026-11-19T12:00:00Z'), log: () => {} });
  ok(r.companies.PSA.from === 'site' && r.companies.PSA.checked === '2026-11-19T12:00:00.000Z' && r.companies.PSA.tiers.length === 14, 'grading run: a readable page is used and dated today');
  ok(r.companies.CGC.checked === '2026-10-16T01:49:00Z' && r.companies.CGC.tried === '2026-11-19T12:00:00.000Z' && r.companies.CGC.tiers.length === 6, 'grading run: a blocked company keeps its last tiers and their date');
  const again = await G.runGrading({ gh, readFetch, fetch: readFetch, now: Date.parse('2026-11-19T15:00:00Z'), log: () => {} });
  ok(again.skipped && JSON.parse(store['grading.json']).updated === '2026-11-19T12:00:00.000Z', 'grading run: only once a day');
};
const reportsRun = async () => {
  const G = require('./grading');
  const rx = f => fs.readFileSync(path.join(__dirname, 'fixtures', 'reports', f + '.txt'), 'utf8');
  const sites = { 'www.thelines.com': rx('thelines-sgc'), 'www.aamintstore.com': rx('aamint-sgc'), 'cardgrade.io/sgc': rx('cgio-sgc'),
    'cardgrading.app': rx('cga-bgs'), 'cardgrade.io/bec': rx('cgio-bgs'), 'www.tcgrader.com': rx('tcgrader') };
  const mk = over => async (u) => {
    if (/archive\.org\/wayback/.test(u)) return { ok: true, json: async () => ({ archived_snapshots: {} }) };
    const x = new URL(u), key = x.host === 'cardgrade.io' ? 'cardgrade.io/' + x.pathname.slice(1, 4) : x.host;
    const body = (over && over[key]) || sites[key] || '<title>Just a moment...</title>';
    return { ok: true, text: async () => body };
  };
  const store = {}; const gh = { download: async (t, n) => store[n] || null, put: async (t, n, b) => { store[n] = b; } };
  const r = await G.runGrading({ gh, readFetch: mk(), fetch: mk(), now: Date.parse('2026-11-19T12:00:00Z'), log: () => {} });
  const sgc = r.companies.SGC, bgs = r.companies.BGS;
  ok(sgc.from === 'report' && sgc.by === 'TheLines' && sgc.checked === '2026-11-12T12:00:00Z' && sgc.tiers.length === 8, 'reports: SGC dated by the newest confirmed report (TheLines, Nov 12)');
  ok(sgc.tiers[7][1] === '$3,750 + $375 per $10k' && sgc.tiers.every(t => t[5] === 'open'), 'reports: a tier we already show keeps its wording; no site marks SGC status, so it stays as it was');
  ok(bgs.from === 'report' && bgs.by === 'CardGrading.app' && bgs.checked === '2026-11-06T12:00:00Z', 'reports: Beckett dated by CardGrading.app (Nov 6); TCGrader only confirms prices');
  ok(bgs.tiers.map(t => t[5]).join() === 'sold,sold,sold,open,sold', 'reports: Beckett sold-out marks applied, unmarked tiers keep their last status');
  ok(r.companies.PSA.checked === require('./grading-seed.json').companies.PSA.checked || r.companies.PSA.from !== 'report', 'reports: companies without report sites are untouched');
  // one site alone with a new price is not enough
  const lone = rx('thelines-sgc').replace('Standard $1,500 $50', 'Standard $1,500 $60').replace('November 12, 2026', 'November 18, 2026');
  const s2 = {}; const gh2 = { download: async (t, n) => s2[n] || null, put: async (t, n, b) => { s2[n] = b; } };
  const r2 = await G.runGrading({ gh: gh2, readFetch: mk({ 'www.thelines.com': lone }), fetch: mk(), now: Date.parse('2026-11-19T12:00:00Z'), log: () => {} });
  ok(r2.companies.SGC.checked === '2026-11-12T12:00:00Z' && r2.companies.SGC.tiers[0][1] === '$50', 'reports: a new price shown by only one site is not used; older confirmed reports do not replace newer data');
  // a challenge page (Cloudflare / Vercel checkpoint) is never read as prices
  ok(G.REPORTS.SGC[0].read('<title>Vercel Security Checkpoint</title>') === null && G.REPORTS.BGS[0].read('Just a moment...') === null, 'reports: a challenge page is not read as prices');
  // a report older than what we already show changes nothing
  const r3 = await G.runGrading({ gh, readFetch: mk(), fetch: mk(), now: Date.parse('2026-11-20T12:00:00Z'), log: () => {} });
  ok(r3.companies.SGC.checked === '2026-11-12T12:00:00Z' && r3.companies.SGC.tried === '2026-11-20T12:00:00.000Z', 'reports: no newer report keeps the last good data and its date');
};
// Graded prices: matched by the TCGplayer number, read once a day within the allowance, refreshed later
const gradedRun = async () => {
  const G = require('./graded');
  const files = {};
  const gh = { download: async (tag, name) => files[tag + '/' + name] || null, put: async (tag, name, buf) => { files[tag + '/' + name] = buf; } };
  files['prices/prices-3.json.gz'] = zlib.gzipSync(Buffer.from(JSON.stringify({ groups: [{ groupId: 5, name: 'SWSH07: Evolving Skies' }, { groupId: 6, name: 'XY - Ancient Origins' }],
    products: { 5: [[10, 'Umbreon VMAX (Alternate Art Secret)', '215/203', 'R', '', 1], [11, 'Cheap card', '1/203', 'C', '', 1], [12, 'Booster Box', '', '', '', 0]], 6: [[20, 'Lugia EX (94 Full Art)', '94/98', 'R', '', 1]] },
    prices: { 5: { 10: { Holofoil: 1650 }, 11: { Normal: 0.5 }, 12: { Normal: 300 } }, 6: { 20: { Holofoil: 150 } } } })));
  const calls = [];
  const answers = {
    search_cards: a => ({ cards: /umbreon/i.test(a.query) ? [{ id: 'pi_12081', name: 'Umbreon VMAX #215', set: 'Evolving Skies' }, { id: 'pi_x', name: 'Umbreon VMAX #95', set: 'Evolving Skies' }] : /lugia/i.test(a.query) ? [{ id: 'pi_2912', name: 'Lugia EX #94', set: 'Ancient Origins' }] : [] }),
    get_population: a => a.card === 'pi_12081' ? { tcgplayer_id: '10', population: { psa_10: 22079, psa_9: 6704, total: 32082 }, gem_rate_pct: 68.82, psa_last_updated: '2026-11-16' } : { tcgplayer_id: '999', population: { total: 5 } },
    get_sales: a => ({ sales: [{ date: '2026-11-15', price_usd: 3900, grader: 'PSA', grade: '10', platform: 'eBay' }, { date: '2026-11-10', price_usd: 1750, grader: null, grade: null, platform: 'TCGplayer', url: 'https://example.com/s' }, { date: '2026-11-12', price_usd: 900, grader: 'CGC', grade: '9', platform: 'eBay' }] }),
    get_card_prices: a => ({ tcgplayer_id: '10', name: 'Umbreon VMAX #215', page_url: 'u', ungraded: { median_usd: 1800, sales: 219 }, graded: [{ grader: 'PSA', grade: '10', median_usd: 3850, sales: 239 }, { grader: 'CGC', grade: '10', median_usd: 0, sales: 0 }], population: { cgc_total: 3146 } })
  };
  const pi = { used: 0, call: async (tool, args) => { pi.used++; calls.push(tool + ' ' + (args.card || args.query)); return answers[tool](args); } };
  const day1 = Date.parse('2026-11-19T12:00:00Z');
  let r = await G.runGraded({ gh, pi, gap: 0, now: day1, log: () => {} });
  let out = JSON.parse(zlib.gunzipSync(files['prices/graded.json.gz']));
  ok(out.cards['10'] && out.cards['10'].pi === 'pi_12081' && out.cards['10'].d.grades.length === 1 && out.cards['10'].d.pop.psa['10'] === 22079 && out.cards['10'].d.pop.cgcTotal === 3146, 'graded: Umbreon read, priced grades only, PSA population and CGC total kept');
  ok(!out.cards['20'] && r.missed === 1 && calls.includes('get_population pi_2912'), 'graded: a card whose TCGplayer number does not match is not published');
  ok(!calls.some(c => /Cheap|Booster/.test(c)) && out.pool === 2, 'graded: only cards worth $20+, no sealed');
  const sl = out.cards['10'].s || [];
  ok(sl.some(x => x[2] === 'PSA' && x[3] === '10' && x[1] === 3900) && !sl.some(x => x[2] === 'CGC'), 'graded: sales kept for priced grades only (PSA 10 yes, unpriced CGC 9 no)');
  calls.length = 0;
  r = await G.runGraded({ gh, pi, gap: 0, now: day1 + 3600000, log: () => {} });
  ok(r.skipped && !calls.length, 'graded: nothing more to do the same day – later hourly runs skip');
  r = await G.runGraded({ gh, pi, gap: 0, now: day1 + 8 * 86400000, log: () => {} });
  ok(calls.length === 3 && calls[0] === 'get_population pi_12081' && calls.includes('get_sales pi_12081') && !calls.some(c => /^search_cards/.test(c)), 'graded: a known card is refreshed after 7 days with 3 calls (population, prices, sales), no search');
  calls.length = 0;
  files['state/graded-state.json'] = null;
  r = await G.runGraded({ gh, pi, gap: 0, now: day1 + 9 * 86400000, daily: 4, log: () => {} });
  ok(calls.length <= 4 && r.used <= 4, 'graded: the daily allowance is never passed');
  const lim = { used: 0, call: async () => { lim.used++; const e = new Error('PokeInvest daily limit reached'); e.limit = true; throw e; } };
  files['state/graded-state.json'] = null;
  r = await G.runGraded({ gh, pi: lim, gap: 0, now: day1 + 10 * 86400000, log: () => {} });
  ok(lim.used === 1 && JSON.parse(zlib.gunzipSync(files['prices/graded.json.gz'])).cards['10'], 'graded: at PokeInvest\'s limit it stops at once and keeps what it had');
};
const dealsRun = async () => {
  const D = require('./deals');
  const files = {};
  const gh = { download: async (tag, name) => files[tag + '/' + name] || null, put: async (tag, name, buf) => { files[tag + '/' + name] = buf; } };
  let r = await D.runDeals({ gh, appId: '', certId: '', log: () => {} });
  ok(!r.enabled && JSON.parse(files['prices/deals.json']).enabled === false, 'no eBay keys: deals.json says not connected');
  files['history/indexes.json.gz'] = zlib.gzipSync(Buffer.from(JSON.stringify({ built: 'b1', cats: { 3: { cards: { ids: [10] } } } })));
  files['prices/prices-3.json.gz'] = zlib.gzipSync(Buffer.from(JSON.stringify({ groups: [{ groupId: 5, name: 'Evolving Skies' }], products: { 5: [[10, 'Umbreon VMAX (Alternate Art Secret)', '215/203', 'R', '', 1]] }, prices: { 5: { 10: { Holofoil: 200 } } } })));
  let searches = 0;
  const lst = (id, price, who) => ({ itemId: id, title: 'Pokemon Umbreon VMAX 215/203 Alt Art', price: { value: String(price), currency: 'USD' }, buyingOptions: ['FIXED_PRICE'], itemLocation: { country: 'US' }, seller: { username: who, feedbackPercentage: '100', feedbackScore: 99 }, shippingOptions: [{ shippingCost: { value: '0' } }], itemWebUrl: 'https://www.ebay.com/itm/' + id });
  // other sellers ask $195–$205: the $150 one stands out. When every listing asks about $150, none is a deal.
  ok(await (async () => { const f2 = {}; const g2 = { download: async (t, n) => f2[t + '/' + n] || files[t + '/' + n] || null, put: async (t, n, b) => { f2[t + '/' + n] = b; } };
    await D.runDeals({ gh: g2, appId: 'a', certId: 'b', ebay: { search: async () => [lst('y1', 150, 'a'), lst('y2', 152, 'b'), lst('y3', 149, 'c'), lst('y4', 155, 'd')] }, fast: true, log: () => {}, now: Date.parse('2026-11-18T12:00:00Z') });
    return JSON.parse(f2['prices/deals.json']).deals.length === 0; })(), 'deals: when all of eBay asks about the same, the market price is wrong – no deal');
  const ebay = { search: async it => { searches++; return [lst('x1', 150, 'a'), lst('x2', 195, 'b'), lst('x3', 200, 'c'), lst('x4', 205, 'd')]; } };
  r = await D.runDeals({ gh, appId: 'a', certId: 'b', ebay, fast: true, log: () => {}, now: Date.parse('2026-11-18T12:00:00Z') });
  const out = JSON.parse(files['prices/deals.json']);
  ok(r.enabled && searches === 1 && out.deals.length === 1 && out.deals[0].pid === 10 && out.budget.used === 1, 'keys set: item searched once, deal published, budget counted');
  r = await D.runDeals({ gh, appId: 'a', certId: 'b', ebay, fast: true, log: () => {}, now: Date.parse('2026-11-18T13:00:00Z') });
  ok(searches === 2 || searches === 1, 'next hour: rechecks only when due');
  r = await D.runDeals({ gh, appId: 'a', certId: 'b', ebay, fast: true, log: () => {}, now: Date.parse('2026-11-18T19:00:00Z') });
  ok(searches >= 2 && JSON.parse(files['prices/deals.json']).deals[0].found === out.deals[0].found, 'a top item again after 5 h; the same listing keeps its found time');
  const LS = JSON.parse(zlib.gunzipSync(files['prices/listings.json.gz']));
  ok(LS.items[10] && LS.items[10].l.length === 4 && LS.items[10].at === '2026-11-18T19:00:00.000Z', 'listings file: the item\'s listings with their time');
  r = await D.runDeals({ gh, appId: 'a', certId: 'b', ebay: { search: async () => { throw new Error('eBay search: 500'); } }, fast: true, log: () => {}, now: Date.parse('2026-11-19T02:00:00Z') });
  ok(!JSON.parse(zlib.gunzipSync(files['prices/listings.json.gz'])).items[10] && !JSON.parse(files['prices/deals.json']).deals.length, 'nothing older than 6 h is kept (eBay rule)');
};

// ---- fake TCGCSV ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpt-'));
const START = '2026-11-10';
const groupsOf = { 3: [{ groupId: 100, name: 'Set A', modifiedOn: 'm1' }, { groupId: 101, name: 'Set B', modifiedOn: 'm1' }], 89: [{ groupId: 200, name: 'Origins', modifiedOn: 'm1' }] };
const prodOf = g => ({ results: [{ productId: g * 10 + 1, name: 'Card ' + g, imageUrl: 'https://x/' + g + '_200w.jpg', imageCount: 1, extendedData: [{ name: 'Number', value: '001/100' }, { name: 'Rarity', value: 'Rare' }] }, { productId: g * 10 + 2, name: 'Booster Box ' + g, imageUrl: '', imageCount: 0, extendedData: [] }] });
let price = 1.0;
const priceOf = g => ({ results: [{ productId: g * 10 + 1, subTypeName: 'Holofoil', marketPrice: price + g / 1000 }, { productId: g * 10 + 2, subTypeName: 'Normal', marketPrice: null }] });
const archives = {};
function makeArchive(d) { // the archive of day d: <d>/<cat>/<group>/prices, the price of day i = 0.5 + i/100
  const dir = path.join(tmp, 'a-' + d), i = dayIndex(START, d);
  for (const [cat, gs] of Object.entries(groupsOf)) for (const g of gs) {
    fs.mkdirSync(path.join(dir, d, cat, String(g.groupId)), { recursive: true });
    fs.writeFileSync(path.join(dir, d, cat, String(g.groupId), 'prices'), JSON.stringify({ success: true, results: [{ productId: g.groupId * 10 + 1, subTypeName: 'Holofoil', marketPrice: 0.5 + i / 100 }] }));
  }
  fs.mkdirSync(path.join(dir, d, '4', '1'), { recursive: true }); fs.writeFileSync(path.join(dir, d, '4', '1', 'prices'), '{"results":[{"productId":9,"marketPrice":5}]}'); // a category Minty does not use
  const f = path.join(tmp, d + '.7z');
  execFileSync('7z', ['a', '-m0=PPMd', '-bd', f, d], { cwd: dir, stdio: 'ignore' });
  archives[d] = fs.readFileSync(f);
}
for (const d of ['2026-11-10', '2026-11-11', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16']) makeArchive(d); // 12th missing
let updated = '2026-11-17T20:05:43+0000', extraCat = false;
const calls = [];
const resp = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => typeof body === 'string' ? body : JSON.stringify(body), arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) });
async function fakeFetch(url, opt) {
  calls.push(url);
  assert.ok(/MintyPrices/.test(opt.headers['user-agent']), 'TCGCSV asked with our User-Agent');
  let m;
  if (url.endsWith('/last-updated.txt')) return resp(updated);
  if (url.endsWith('/tcgplayer/categories')) return resp({ results: [{ categoryId: 3 }, { categoryId: 89 }].concat(extraCat ? [{ categoryId: 95, name: 'New Game' }] : []) });
  if ((m = url.match(/tcgplayer\/(\d+)\/groups$/))) return resp({ results: groupsOf[m[1]] || [] });
  if ((m = url.match(/tcgplayer\/\d+\/(\d+)\/products$/))) return resp(prodOf(+m[1]));
  if ((m = url.match(/tcgplayer\/\d+\/(\d+)\/prices$/))) return resp(priceOf(+m[1]));
  if ((m = url.match(/prices-(\d{4}-\d\d-\d\d)\.ppmd\.7z$/))) return archives[m[1]] ? resp(archives[m[1]]) : resp('', 404);
  throw new Error('unexpected ' + url);
}
// ---- fake GitHub: releases as maps ----
const store = { state: {}, prices: {}, history: {} }, repoFiles = {};
const gh = { calls: 0,
  async download(tag, name) { return store[tag][name] || null; },
  async put(tag, name, buf) { store[tag][name] = Buffer.from(buf); },
  async remove(tag, name) { delete store[tag][name]; },
  async writeFile(p, text) { repoFiles[p] = text; return true; } };
const cfg = { categories: [3, 89], archiveStart: START, historyBucketBytes: 10 };
const quiet = () => {};

// Exchange rates (build/rates.js): the bank's history file read oldest-first; nothing done when the day is already in.
async function ratesRun() {
  const R = require('./rates');
  const days = []; for (let i = 0; i < 1200; i++) days.push(new Date(Date.UTC(2026, 10, 19) - i * 864e5).toISOString().slice(0, 10));
  const csv = 'Date,USD,JPY,BGN,GBP,KRW,CNY,\n' + days.map((d, i) => `${d},${(1.15 + i / 1e5).toFixed(4)},180.5,N/A,0.86,1700.1,${i % 7 ? '8.1' : 'N/A'},`).join('\n') + '\n2009-12-31,1.4,130,1.9,0.9,1600,9.8,';
  const p = R.parseHist(csv);
  ok(p.dates[0] < p.dates[1] && p.updated === '2026-11-19' && !p.dates.includes('2009-12-31'), 'rates: oldest first, from 2010, newest day known');
  ok(p.rates.USD[p.rates.USD.length - 1] === 1.15 && p.rates.GBP[0] === 0.86 && !('BGN' in p.rates), 'rates: values in place, currencies Minty does not offer left out');
  ok(p.rates.CNY.some(v => v === null) && p.rates.CNY.length === p.dates.length, 'rates: a missing rate stays empty, never guessed');
  ok(R.dailyDate('<Cube time="2026-11-19">') === '2026-11-19', 'rates: the daily file\'s date');
  const store = {}, gh = { download: async (t, n) => store[n] || null, put: async (t, n, b) => { store[n] = b; } };
  const f = async u => ({ text: async () => '<Cube time=\'2026-11-19\'>', arrayBuffer: async () => new ArrayBuffer(4) });
  let r = await R.main({ fetch: f, gh, unzip: () => csv, log: () => {} });
  ok(r.changed && JSON.parse(zlib.gunzipSync(store['rates.json.gz'])).updated === '2026-11-19', 'rates: published');
  r = await R.main({ fetch: f, gh, unzip: () => { throw new Error('should not read again'); }, log: () => {} });
  ok(!r.changed, 'rates: the same day is not read again');
}
// eBay catalog numbers (build/catalog.js): the locked token opens, only true matches are kept, the budget and resting work.
async function catalogRun() {
  const C = require('./catalog'), zlib = require('zlib'), fs = require('fs'), os = require('os'), path = require('path');
  ok(C.unlock(C.lock('v^1.1#i^1#r^1#abc', 'cert-secret'), 'cert-secret') === 'v^1.1#i^1#r^1#abc', 'catalog: the locked refresh token opens with the Cert ID');
  let bad = false; try { C.unlock(C.lock('x', 'a'), 'b'); } catch (_) { bad = true; } ok(bad, 'catalog: a wrong key does not open it');
  const P = (epid, title, img) => ({ epid, title, image: img ? { imageUrl: img } : undefined });
  const zard = { id: 1, cat: 3, kind: 'card', name: 'Charizard', number: '4/102', set: 'Base Set' };
  ok(C.catalogQuery({ name: 'Umbreon VMAX (Alternate Art Secret)', number: '215/203' }) === 'Umbreon VMAX 215/203', 'catalog: searched by name and number');
  let m = C.matches(zard, [P('9', 'Blastoise 2/102 Base Set Holo'), P('8', 'Charizard 4/102 Base Set Holo 1st Edition', 'a.jpg'), P('7', 'Charizard 4/102 Base Set Holo', 'b.jpg'), P('6', 'Charizard 4/130 Base Set 2 Holo')]);
  ok(m.length === 2 && m[0][0] === '7' && m[1][0] === '8', 'catalog: other cards and numbers left out; the plain printing first');
  m = C.matches({ id: 2, cat: 3, kind: 'card', name: 'Pikachu ex - 247/191', number: '247/191', set: 'SV08: Surging Sparks' }, [P('5', 'Pikachu ex 247/191 Sv08: Surging Sparks Holo'), P('4', 'Pikachu ex 247/191 Japanese Holo')]);
  ok(m.length === 1 && m[0][0] === '5' && m[0][1] === '', 'catalog: a match without a picture is kept; a foreign one is not');
  ok(C.matches({ id: 3, cat: 68, kind: 'card', name: 'Monkey.D.Luffy', number: 'OP01-003', set: 'Romance Dawn' }, [P('3', 'Monkey.D.Luffy (003) OP01-003 Romance Dawn Regular')]).length === 1, 'catalog: One Piece numbers');
  ok(C.matches(zard, [P('2', 'Charizard 4/102 Base Set Holo PSA 10')]).length === 0, 'catalog: a graded entry is not the raw card');
  ok(C.matches(zard, [P('1', 'Charizard (Celebrations Metal Card) 004/102 Miscellaneous Cards & Products Holo')]).length === 0, 'catalog: another product with the same number and no set named is not this card');
  ok(C.matches({ id: 9, cat: 85, kind: 'card', name: 'Umbreon ex - 217/187', number: '217/187', set: 'SV8a: Terastal Fest ex' }, [P('1', 'Umbreon ex 217/187 Sv8a: Terastal Fest Ex Holo (Japanese)')]).length === 1 && C.matches({ id: 8, cat: 2, kind: 'card', name: 'Number 106: Giant Hand', number: 'YCSW-EN006', set: 'Yu-Gi-Oh! Championship Series Prize Cards' }, [P('1', 'Number 106: Giant Hand YCSW-EN006 Yu-Gi-Oh! Championship Series Prize Cards Limited Edition')]).length === 1, 'catalog: Japanese cards and hyphenated set names match');
  ok(C.matches(zard, [P('1', 'Charizard 4/102 Base Set (Shadowless) Holo')]).length === 0, 'catalog: a bracketed version the card does not have is not this card');
  ok(C.candidates([{ id: 5, cat: 3, kind: 'sealed', name: 'ETB', number: '' }, { id: 6, cat: 3, kind: 'card', name: 'X', number: '1/2', market: 9 }], {}).map(x => x.id).join() === '6', 'catalog: sealed products and cards without a number are not looked up');
  // a run: budget share, found cards kept and not asked again, a game with nothing found rests
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-')), tf = path.join(dir, 'refresh.enc'); fs.writeFileSync(tf, C.lock('RT', 'cert'));
  const store = { state: { 'deals-state.json': Buffer.from(JSON.stringify({ items: [Object.assign({ g: 1, market: 50 }, zard)].concat(Array.from({ length: 45 }, (_, i) => ({ id: 100 + i, cat: 2, g: 2, kind: 'card', name: 'Dark Magician', number: 'LOB-' + String(i).padStart(3, '0'), set: 'LOB', market: 20 }))) })) }, prices: {}, history: {} };
  const gh = { async download(t, n) { return (store[t] || {})[n] || null; }, async put(t, n, b) { (store[t] = store[t] || {})[n] = Buffer.from(b); } };
  let asked = [];
  const catalog = { async search(it) { asked.push(it.id); return it.id === 1 ? [P('7', 'Charizard 4/102 Base Set Holo', 'b.jpg')] : []; } };
  const now = Date.parse('2026-11-20T18:00:00Z');
  let r = await C.runCatalog({ gh, catalog, appId: 'a', certId: 'cert', tokenFile: tf, now, fast: true, log: () => {} });
  const out = JSON.parse(zlib.gunzipSync(store.prices['epid.json.gz']));
  ok(r.enabled && out.items[1][0][0] === '7' && out.count === 1, 'catalog: a found card is published with its eBay number and picture');
  const st = JSON.parse(store.state['catalog-state.json']);
  ok(st.budget.used === asked.length && asked.length <= Math.ceil(C.CFG.dayBudget / 1), 'catalog: lookups counted against the day');
  ok(st.games[2].restUntil > now, 'catalog: a game with nothing in eBay\'s catalog after 40 lookups rests');
  asked = []; r = await C.runCatalog({ gh, catalog, appId: 'a', certId: 'cert', tokenFile: tf, now: now + 3600000, fast: true, log: () => {} });
  ok(!asked.includes(1) && !asked.some(id => id >= 100), 'catalog: a found card and a resting game are not asked again');
  r = await C.runCatalog({ gh, catalog, appId: 'a', certId: '', tokenFile: tf, now, fast: true, log: () => {} });
  ok(!r.enabled, 'catalog: no Cert ID – not running');
}

(async () => {
  // Run 1: first pull + the archive days before it
  let r = await main({ fetch: fakeFetch, gh, cfg, gap: 0, log: quiet, sevenZip: '7z' });
  ok(r.did && r.state.lastPull === '2026-11-17T20:05:43.000Z' && r.state.apiStart === '2026-11-17', 'first run: daily pull done, start of daily pulls recorded');
  ok(Object.keys(r.state.archives).length === 7 && r.state.archives['2026-11-12'] === 'none' && r.state.archives['2026-11-16'] === 3, 'archive: every day before the first pull read once, missing day noted');
  ok(calls.filter(u => /ppmd/.test(u)).length === 7, 'archive: 7 downloads');
  const pf = JSON.parse(zlib.gunzipSync(store.prices['prices-3.json.gz']));
  ok(pf.groups.length === 2 && pf.products[100][0][1] === 'Card 100' && pf.products[100][0][5] === 1 && pf.products[100][1][4] === '' && pf.prices[100]['1001'].Holofoil === 1.1, 'price file: sets, products (Minty form), prices');
  ok(pf.prices[100]['1002'].Normal === null, 'no recent sales stays empty, not 0');
  const idx = JSON.parse(store.history['index.json']);
  ok(idx.categories['3'].files === 2 && idx.categories['3'].sets['101'] === 1 && idx.historyEnd === '2026-11-17', 'history index: sets spread over files, last day');
  const b0 = JSON.parse(zlib.gunzipSync(store.history['h-3-0.json.gz']));
  const s = Hist.unpack(b0.start, b0.series['1001|Holofoil']);
  ok(s.length === 7 && s[0][0] === '2026-11-10' && s[0][1] === 0.5 && s.find(x => x[0] === '2026-11-16')[1] === 0.56 && s[6][0] === '2026-11-17' && s[6][1] === 1.1, 'history: archive days + the daily pull, missing day skipped');
  ok(!store.state['hist-4.bin.gz'], 'categories Minty does not use are not kept');
  ok(JSON.parse(store.prices['categories.json']).results.length === 2, 'TCGplayer\'s list of games published');
  ok(JSON.parse(repoFiles['status.json']).archiveDaysLeft === 0, 'status file written');

  // Run 2: nothing new
  calls.length = 0;
  r = await main({ fetch: fakeFetch, gh, cfg, gap: 0, log: quiet });
  ok(!r.did && calls.length === 1, 'nothing new: only last-updated.txt is asked');

  // Run 3: next day's prices; a new game on TCGplayer; one set changed
  calls.length = 0; updated = '2026-11-18T20:04:00+0000'; price = 2.0; extraCat = true; groupsOf[3][1].modifiedOn = 'm2'; groupsOf[95] = [{ groupId: 300, name: 'New Set', modifiedOn: 'm1' }];
  r = await main({ fetch: fakeFetch, gh, cfg, gap: 0, log: quiet });
  ok(calls.filter(u => /ppmd/.test(u)).length === 0, 'no archive downloaded again');
  const prodCalls = calls.filter(u => /products$/.test(u)).map(u => +u.match(/\/(\d+)\/products/)[1]).sort();
  ok(JSON.stringify(prodCalls) === JSON.stringify([101, 300]), 'product lists read only for a changed or new set');
  ok(r.state.cats.includes(95) && store.prices['prices-95.json.gz'], 'a game TCGplayer adds later is picked up');
  const b1 = JSON.parse(zlib.gunzipSync(store.history['h-3-0.json.gz']));
  const s2 = Hist.unpack(b1.start, b1.series['1001|Holofoil']);
  ok(s2.length === 8 && s2[7][0] === '2026-11-18' && s2[7][1] === 2.1, 'history: next day added');
  ok(calls.filter(u => /tcgcsv/.test(u)).length === 1 + 1 + 3 + 2 + 4, 'requests: last-updated, categories, 3 set lists, 2 product lists, 4 price lists');
  // An archive laid out differently: the run stops, keeps the archive itself and what it read before it
  const store2 = { state: {}, prices: {}, history: {} };
  const gh2 = Object.assign({}, gh, { async download(t, nm) { return store2[t][nm] || null; }, async put(t, nm, b) { store2[t][nm] = Buffer.from(b); }, async remove(t, nm) { delete store2[t][nm]; } });
  const odd = path.join(tmp, 'odd'); fs.mkdirSync(path.join(odd, 'other'), { recursive: true }); fs.writeFileSync(path.join(odd, 'other', 'file.txt'), 'x');
  execFileSync('7z', ['a', '-bd', path.join(tmp, 'odd.7z'), 'other'], { cwd: odd, stdio: 'ignore' });
  const good = archives['2026-11-14']; archives['2026-11-14'] = fs.readFileSync(path.join(tmp, 'odd.7z'));
  updated = '2026-11-17T20:05:43+0000'; calls.length = 0;
  r = await main({ fetch: fakeFetch, gh: gh2, cfg, gap: 0, log: quiet });
  ok(r.error && /2026-11-14: no prices found/.test(r.error.message), 'unreadable archive: the run reports it');
  const st2 = JSON.parse(store2.state['state.json']);
  ok(st2.lastPull && store2.prices['prices-3.json.gz'], 'unreadable archive: the day\'s prices were still published');
  ok(st2.archives['2026-11-13'] === 3 && !st2.archives['2026-11-14'] && store2.state['archive-2026-11-14.7z'] && st2.archiveError.day === '2026-11-14', 'unreadable archive: days before it saved, the archive kept in our own release');
  calls.length = 0;
  r = await main({ fetch: fakeFetch, gh: gh2, cfg, gap: 0, log: quiet });
  ok(!r.did && calls.length === 1, 'until the reader is fixed: nothing is asked again, no pull repeated');
  archives['2026-11-14'] = good; store2.state['archive-2026-11-14.7z'] = good; calls.length = 0;
  r = await main({ fetch: fakeFetch, gh: gh2, cfg, gap: 0, log: quiet, parser: 2 });
  ok(!calls.some(u => /ppmd/.test(u) && /2026-11-1[0-4]/.test(u)) && !store2.state['archive-2026-11-14.7z'] && JSON.parse(store2.state['state.json']).archives['2026-11-14'] === 3, 'fixed reader: the kept archive is used, TCGCSV not asked again for any day already read');
  ok(JSON.parse(store2.state['state.json']).req.n === 18 + 3, 'requests counted across runs (first run 18, last run 3)');
  await dealsRun();
  await gradedRun();
  await gradingRun();
  await reportsRun();
  await ratesRun();
  await catalogRun();
  console.log('minty-prices: ' + n + ' checks passed');
})().catch(e => { console.error(e); process.exit(1); });
