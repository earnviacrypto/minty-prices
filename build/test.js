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
  console.log('minty-prices: ' + n + ' checks passed');
})().catch(e => { console.error(e); process.exit(1); });
