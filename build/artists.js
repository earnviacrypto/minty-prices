// Artists: who drew each card, for Minty's "Artist" line and the artist pages.
// TCGplayer's card data has no artist, so each game's own card database is read, and every card is tied to its
// TCGplayer product id (each of these sources gives that id itself – no guessing by name).
// Publishes prices/artists.json.gz: { v, updated, names: [artist, …], cats: { "3": { "<productId>": nameIndex, … } } }
// and keeps its own progress (Pokémon is read card by card, so a run carries on where the last one stopped) in
// state/artists-state.json.gz.
const zlib = require('zlib');
const { GitHub, sleep } = require('./gh');

const V = 1;
const CAT = { pokemon: 3, magic: 1, lorcana: 71, swu: 79, riftbound: 89, fab: 62, sorcery: 77, digimon: 63, grandarchive: 74 };
const UA = 'minty-prices (github.com/earnviacrypto/minty-prices)';
const clean = a => String(a || '').replace(/\s+/g, ' ').trim();
const ids = v => (Array.isArray(v) ? v : [v]).map(x => parseInt(x, 10)).filter(x => x > 0);

async function getJson(fetchFn, url, tries = 4) {
  for (let t = 0; ; t++) {
    let r, err;
    try { r = await fetchFn(url, { headers: { 'user-agent': UA, accept: 'application/json' } }); } catch (e) { err = e; }
    if (r && r.ok) return r.json();
    if (r && r.status === 404) return null;
    if (t >= tries) throw new Error(url + ': ' + (r ? r.status : err && err.message));
    await sleep((r && r.status === 429 ? 30000 : 4000) * (t + 1));
  }
}
// run fn over items, n at a time
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } })); }

// ---- each game's source: returns [[productId, artist], …] ----
// Pokémon: TCGdex – the illustrator and TCGplayer's product id of every card. Read card by card (about 20,000); the
// cards already read are kept, so each run reads only new cards (and the first runs carry on where the last stopped).
async function pokemon(fetchFn, state, log, until) {
  const list = await getJson(fetchFn, 'https://api.tcgdex.net/v2/en/cards');
  const known = state.tcgdex = state.tcgdex || {};
  const todo = (list || []).map(c => c.id).filter(id => !(id in known));
  log('Pokémon: ' + (list || []).length + ' cards, ' + todo.length + ' not read yet');
  let n = 0;
  await pool(todo, 8, async id => {
    if (Date.now() > until) return;
    try {
      const c = await getJson(fetchFn, 'https://api.tcgdex.net/v2/en/cards/' + encodeURIComponent(id), 2);
      const tp = (c && c.pricing && c.pricing.tcgplayer) || {};
      const pids = [...new Set(Object.values(tp).filter(x => x && typeof x === 'object' && x.productId).map(x => x.productId))];
      known[id] = [clean(c && c.illustrator), pids];
      n++;
    } catch (e) { /* tried again next run */ }
  });
  log('Pokémon: read ' + n + ' this run');
  const out = [];
  for (const [a, pids] of Object.values(known)) if (a) for (const p of pids) out.push([p, a]);
  return out;
}
// Magic: Scryfall's daily file of every printing (artist + tcgplayer_id), one card per line.
async function magic(fetchFn) {
  const bulk = await getJson(fetchFn, 'https://api.scryfall.com/bulk-data');
  const d = (bulk && bulk.data || []).find(x => x.type === 'default_cards');
  const url = d && (d.jsonl_download_uri || d.download_uri);
  if (!url) throw new Error('Scryfall: no default_cards file');
  const r = await fetchFn(url, { headers: { 'user-agent': UA, accept: '*/*' } });
  if (!r.ok) throw new Error('Scryfall file: ' + r.status);
  // read it as it arrives, line by line (the whole file is too large to hold as one piece of text)
  const out = [];
  const take = c => { if (c.lang && c.lang !== 'en') return; const a = clean(c.artist); if (a) for (const p of ids([c.tcgplayer_id, c.tcgplayer_etched_id].filter(Boolean))) out.push([p, a]); };
  const dec = new TextDecoder(); let rest = '';
  const feed = str => { rest += str; let i; while ((i = rest.indexOf('\n')) >= 0) { const l = rest.slice(0, i).trim().replace(/,$/, ''); rest = rest.slice(i + 1); if (l.startsWith('{')) { try { take(JSON.parse(l)); } catch (_) {} } } };
  const reader = r.body.getReader();
  let gz = null, gzDone = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const ch = Buffer.from(value);
    if (gz === null) { if (ch[0] === 0x1f && ch[1] === 0x8b) { gz = zlib.createGunzip(); gz.on('data', d => feed(dec.decode(d, { stream: true }))); gzDone = new Promise((res, rej) => { gz.on('end', res); gz.on('error', rej); }); } else gz = false; }
    if (gz) { if (!gz.write(ch)) await new Promise(res => gz.once('drain', res)); } else feed(dec.decode(ch, { stream: true }));
  }
  if (gz) { gz.end(); await gzDone; }
  feed(dec.decode() + '\n');
  return out;
}
// Lorcana: Lorcast, set by set.
async function lorcana(fetchFn) {
  const sets = await getJson(fetchFn, 'https://api.lorcast.com/v0/sets');
  const out = [];
  for (const s of (sets && sets.results) || []) {
    const cards = await getJson(fetchFn, 'https://api.lorcast.com/v0/sets/' + encodeURIComponent(s.id) + '/cards');
    for (const c of (Array.isArray(cards) ? cards : (cards && cards.results) || [])) { const a = clean((c.illustrators || []).join(' & ')); if (a) for (const p of ids(c.tcgplayer_id)) out.push([p, a]); }
    await sleep(120);
  }
  return out;
}
// Star Wars Unlimited: SWU-DB, set by set (set codes from TCGplayer's own set list for the game).
async function swu(fetchFn, state, log, until, groups) {
  const codes = [...new Set((groups[CAT.swu] || []).map(g => String(g.abbreviation || '').toLowerCase()).filter(x => /^[a-z0-9]{2,6}$/.test(x)))];
  const out = [];
  for (const code of codes) {
    let j = null; try { j = await getJson(fetchFn, 'https://api.swu-db.com/cards/' + code, 1); } catch (_) {}
    for (const c of (j && j.data) || []) { const a = clean(c.Artist); if (a) for (const p of ids(c.tcgplayerId)) out.push([p, a]); }
    await sleep(150);
  }
  return out;
}
// Riftbound: Rifthunt's file of every card (tcgId = TCGplayer's product id).
async function riftbound(fetchFn) {
  const j = await getJson(fetchFn, 'https://api.rifthunt.com/bulk/cards');
  const out = [];
  for (const c of (j && j.cards) || []) { const a = clean(c.artist); if (a) for (const p of ids(c.tcgId || c.tcg_id)) out.push([p, a]); }
  return out;
}
// Flesh and Blood: the-fab-cube's open card list (every printing carries its artists and TCGplayer product id).
async function fab(fetchFn) {
  let cards = null;
  for (const br of ['main', 'develop']) { try { cards = await getJson(fetchFn, `https://raw.githubusercontent.com/the-fab-cube/flesh-and-blood-cards/${br}/json/english/card.json`, 1); } catch (_) {} if (cards) break; }
  const out = [];
  for (const c of cards || []) for (const pr of c.printings || []) { const a = clean((pr.artists || []).join(' & ')); if (a) for (const p of ids(pr.tcgplayer_product_id)) out.push([p, a]); }
  return out;
}

// ---- games whose card database has the artist but not TCGplayer's id: matched to TCGplayer's own card list ----
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
async function tcgCards(fetchFn, cat) { // [{ id, name, number, set }] – TCGplayer's cards of one game
  const gs = ((await getJson(fetchFn, 'https://tcgcsv.com/tcgplayer/' + cat + '/groups')) || {}).results || [];
  const out = [];
  for (const g of gs) {
    const ps = ((await getJson(fetchFn, 'https://tcgcsv.com/tcgplayer/' + cat + '/' + g.groupId + '/products')) || {}).results || [];
    for (const p of ps) { const ext = Object.fromEntries((p.extendedData || []).map(e => [e.name, e.value])); if (ext.Rarity === undefined && ext.Number === undefined) continue; out.push({ id: p.productId, name: p.name, number: ext.Number || '', set: g.name }); }
    await sleep(110);
  }
  return out;
}
// Sorcery: the official card list – each printing's set and artist. TCGplayer names the card the same way, set by set.
async function sorcery(fetchFn) {
  const cards = await getJson(fetchFn, 'https://api.sorcerytcg.com/api/cards');
  const by = new Map(); // "set|name" → artists
  for (const c of cards || []) for (const pr of c.printings || []) { const a = clean(pr.meta && pr.meta.artist && pr.meta.artist.name); if (!a || !pr.set) continue; const k = norm(pr.set.name) + '|' + norm(c.name); if (!by.has(k)) by.set(k, new Set()); by.get(k).add(a); }
  const out = [];
  for (const t of await tcgCards(fetchFn, CAT.sorcery)) {
    const base = t.name.replace(/\s*\((?:foil|rainbow foil|curio|preconstructed|.*?)\)\s*$/i, '');
    const set = norm(t.set.replace(/\s*\(.*\)$/, ''));
    const hit = [...by.keys()].find(k => k === set + '|' + norm(base)) || [...by.keys()].find(k => k.endsWith('|' + norm(base)) && (set.includes(k.split('|')[0]) || k.split('|')[0].includes(set)));
    const as = hit && by.get(hit);
    if (as && as.size === 1) out.push([t.id, [...as][0]]); // one artist for that card in that set – never a guess between two
  }
  return out;
}
// Digimon: digimoncard.io – the artist of each card number's regular art. Alternate arts (TCGplayer names them with
// a bracket) can have another artist, so they are left without one rather than given the wrong name.
async function digimon(fetchFn) {
  const list = await getJson(fetchFn, 'https://digimoncard.io/api-public/getAllCards?sort=name&series=Digimon%20Card%20Game');
  const nums = [...new Set((list || []).map(c => c.cardnumber || c.id).filter(Boolean))];
  const by = new Map();
  await pool(nums, 4, async n => { try { const j = await getJson(fetchFn, 'https://digimoncard.io/api-public/search?card=' + encodeURIComponent(n), 1); for (const c of j || []) { const a = clean(c.artist); if (a && c.id === n && !by.has(n)) by.set(n, { a, name: norm(c.name) }); } } catch (_) {} });
  const out = [];
  for (const t of await tcgCards(fetchFn, CAT.digimon)) {
    const num = String(t.number).trim().toUpperCase(), hit = by.get(num);
    if (!hit) continue;
    const plain = norm(t.name.replace(/\s+-\s+[A-Z0-9-]+$/i, ''));
    if (plain === hit.name) out.push([t.id, hit.a]); // the plain print only – "(Alternate Art)" and the like are skipped
  }
  return out;
}
// Grand Archive: the official card database – each edition's set and illustrator.
async function grandarchive(fetchFn) {
  const by = new Map();
  for (let page = 1; page < 400; page++) {
    const j = await getJson(fetchFn, 'https://api.gatcg.com/cards/search?page=' + page + '&page_size=50', 1);
    const data = (j && j.data) || [];
    for (const c of data) for (const e of c.editions || []) { const a = clean(e.illustrator); const set = e.set && e.set.name; if (!a || !set) continue; const k = norm(set) + '|' + norm(c.name); if (!by.has(k)) by.set(k, new Set()); by.get(k).add(a); }
    if (!data.length || (j.has_more === false) || (j.total_pages && page >= j.total_pages)) break;
    await sleep(150);
  }
  const out = [];
  for (const t of await tcgCards(fetchFn, CAT.grandarchive)) {
    const base = norm(t.name.replace(/\s*\(.*?\)\s*$/, '')), set = norm(t.set.replace(/\s*\(.*\)$/, ''));
    const k = [...by.keys()].find(x => x === set + '|' + base) || [...by.keys()].find(x => x.endsWith('|' + base) && (set.includes(x.split('|')[0]) || x.split('|')[0].includes(set)));
    const as = k && by.get(k);
    if (as && as.size === 1) out.push([t.id, [...as][0]]);
  }
  return out;
}

async function main(env = {}) {
  const log = env.log || ((...a) => console.log(new Date().toISOString().slice(11, 19), ...a));
  const fetchFn = env.fetch || fetch;
  const gh = env.gh || new GitHub({ repo: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN, fetch: fetchFn, log });
  const until = Date.now() + (+process.env.ARTISTS_MINUTES || 40) * 60000;
  let state = {}; try { const b = await gh.download('state', 'artists-state.json.gz'); if (b) state = JSON.parse(zlib.gunzipSync(b)); } catch (_) {}
  let prev = null; try { const b = await gh.download('prices', 'artists.json.gz'); if (b) prev = JSON.parse(zlib.gunzipSync(b)); } catch (_) {}
  const groups = {}; try { const r = await getJson(fetchFn, 'https://tcgcsv.com/tcgplayer/' + CAT.swu + '/groups'); groups[CAT.swu] = (r && r.results) || []; } catch (_) {}
  const readers = { pokemon, magic, lorcana, swu, riftbound, fab, sorcery, digimon, grandarchive };
  const names = [], nameIx = new Map(), cats = {}, report = {};
  const nameOf = a => { if (!nameIx.has(a)) { nameIx.set(a, names.length); names.push(a); } return nameIx.get(a); };
  for (const [game, cat] of Object.entries(CAT)) {
    let rows = null;
    try { rows = await readers[game](fetchFn, state, log, until, groups); } catch (e) { log(game + ': failed – ' + e.message + ' (keeping the last file\'s artists)'); }
    if (!rows || !rows.length) { // keep what the last run found
      const old = prev && prev.cats && prev.cats[cat]; rows = old ? Object.entries(old).map(([p, i]) => [+p, prev.names[i]]) : [];
    }
    const m = cats[cat] = {};
    for (const [p, a] of rows) m[p] = nameOf(a);
    report[game] = Object.keys(m).length;
    log(game + ': ' + report[game] + ' products with an artist');
  }
  const out = { v: V, updated: new Date().toISOString(), names, cats };
  await gh.put('prices', 'artists.json.gz', zlib.gzipSync(Buffer.from(JSON.stringify(out))));
  await gh.put('state', 'artists-state.json.gz', zlib.gzipSync(Buffer.from(JSON.stringify(state))));
  log('published: ' + names.length + ' artists', JSON.stringify(report));
  return report;
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { main, CAT };
