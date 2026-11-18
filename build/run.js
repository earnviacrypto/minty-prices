// The daily job. Runs every hour on GitHub; does work only when there is some:
//  1. TCGCSV has copied TCGplayer's prices again (last-updated.txt is newer than our last pull): read every set of
//     Minty's games once (sets list, products of new or changed sets, prices of every set) and publish them.
//  2. Days of the price archive not read yet (from 8 Feb 2024 to the day before our first pull): read them, a batch per
//     run, each archive downloaded once only – TCGCSV's rule. Then publish the price history.
// Everything is kept in this repository's releases: "state" (our own copy of the history), "prices" (one file per game
// category for Minty), "history" (price history files for Minty). index.json in the repository lists them.
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const { execFileSync } = require('child_process');
const { Hist, dayIndex, dateOf } = require('./hist');
const { GitHub, sleep } = require('./gh');

const TC = 'https://tcgcsv.com';
// Raise this when the archive reader is changed, so an archive it could not read is tried again (from our own copy).
const PARSER = 1;
const ARCHIVE = d => `${TC}/archive/tcgplayer/prices-${d}.ppmd.7z`;
const num = v => (v === null || v === undefined || v === '' || isNaN(+v)) ? null : +v;
const cents = v => { const n = num(v); return n && n > 0 ? Math.round(n * 100) : 0; };

// products → [id, name, number, rarity, picture, isCard] (the same form Minty uses)
function products(json) {
  return (json && json.results || []).map(p => {
    const ext = Object.fromEntries((p.extendedData || []).map(e => [e.name, e.value]));
    return [p.productId, p.name, ext.Number || '', /^(none|n\/a|-)$/i.test(ext.Rarity || '') ? '' : ext.Rarity || '', p.imageCount === 0 ? '' : p.imageUrl || '',
      ['Number', 'Rarity'].some(k => ext[k] !== undefined) ? 1 : 0];
  });
}
// prices → { productId: { "Normal": 12.49 } } (market price, US dollars; null = no recent sales)
function prices(json) {
  const out = {};
  for (const r of (json && json.results || [])) (out[r.productId] = out[r.productId] || {})[r.subTypeName || 'Normal'] = num(r.marketPrice);
  return out;
}

class Tcgcsv {
  constructor({ fetch, ua, log, gap = 110, maxRequests = 9000 }) { Object.assign(this, { fetch, ua, log, gap, maxRequests }); this.count = 0; this.last = 0; }
  async get(url, kind = 'json') {
    for (let t = 0; ; t++) {
      if (this.count >= this.maxRequests) throw new Error('request limit for today reached (' + this.maxRequests + ')');
      const wait = this.last + this.gap - Date.now(); if (wait > 0) await sleep(wait);
      this.last = Date.now(); this.count++;
      let r, err;
      try { r = await this.fetch(url, { headers: { 'user-agent': this.ua } }); } catch (e) { err = e; }
      if (r && r.ok) return kind === 'json' ? r.json() : kind === 'text' ? r.text() : Buffer.from(await r.arrayBuffer());
      if (r && r.status === 404) return null;
      if (t >= 3) throw new Error(url + ': ' + (r ? r.status : err && err.message));
      this.log('TCGCSV', url, r ? r.status : err && err.message, '– trying again');
      await sleep((r && r.status === 429 ? 600000 : 20000) * (t + 1) / (process.env.FAST_RETRY ? 1000 : 1)); // 429 = throttled for 10 minutes
    }
  }
}

async function main(env = {}) {
  const log = env.log || ((...a) => console.log(new Date().toISOString().slice(11, 19), ...a));
  const cfg = Object.assign(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')), env.cfg || {});
  const fetchFn = env.fetch || fetch;
  const gh = env.gh || new GitHub({ repo: env.repo || process.env.GITHUB_REPOSITORY, token: env.token || process.env.GITHUB_TOKEN, fetch: fetchFn, log });
  const tc = new Tcgcsv({ fetch: fetchFn, ua: cfg.userAgent, log, gap: env.gap ?? 110 });
  const deadline = Date.now() + (env.maxMinutes || +process.env.MAX_MINUTES || 300) * 60000;
  const batch = env.batch || 60;
  const sevenZip = env.sevenZip || '7z';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-'));
  const START = cfg.archiveStart;

  const stateBuf = await gh.download('state', 'state.json');
  const state = stateBuf ? JSON.parse(stateBuf) : { lastPull: null, apiStart: null, archives: {}, cats: cfg.categories.slice() };
  const updText = await tc.get(`${TC}/last-updated.txt`, 'text');
  const upd = updText && Date.parse(updText.trim()) ? new Date(Date.parse(updText.trim())).toISOString() : null;
  if (!upd) throw new Error('TCGCSV last-updated.txt unreadable: ' + updText);
  const updDate = upd.slice(0, 10);
  let needPull = !state.lastPull || Date.parse(upd) > Date.parse(state.lastPull);
  const until = state.apiStart || updDate; // the archive covers the days before our first daily pull
  const parser = env.parser || PARSER;
  const blocked = state.archiveError && state.archiveError.parser === parser; // stopped on an archive it cannot read: wait for a fix
  const backlog = [];
  if (!blocked) for (let i = 0; dateOf(START, i) < until; i++) { const d = dateOf(START, i); if (!state.archives[d]) backlog.push(d); }
  if (state.archiveError && !blocked) delete state.archiveError;
  // TCGCSV's limit is 10,000 requests a day: count ours across runs.
  const today = new Date().toISOString().slice(0, 10);
  if (!state.req || state.req.day !== today) state.req = { day: today, n: 0 };
  const budgetOk = state.req.n + (state.pullRequests || 4000) <= 9500;
  if (needPull && !budgetOk) log(`Not reading prices now: ${state.req.n} TCGCSV requests made today already.`);
  log(`TCGCSV updated ${upd}; last pull ${state.lastPull || 'never'}; archive days left ${backlog.length}`);
  if (needPull && !budgetOk) needPull = false;
  if (!needPull && !backlog.length) { log('Nothing to do.' + (blocked ? ' (Archive reading stopped at ' + state.archiveError.day + ': ' + state.archiveError.message.split('\n')[0] + ')' : '')); return { did: false, state }; }

  // Our copy of the history, one file per category.
  const hist = {};
  const loadHist = async cat => {
    if (hist[cat]) return hist[cat];
    const b = await gh.download('state', `hist-${cat}.bin.gz`);
    return (hist[cat] = b ? Hist.decode(b, START) : new Hist(START));
  };
  const priceFiles = {};
  let counted = 0;
  const saveAll = async (final) => {
    for (const [cat, h] of Object.entries(hist)) if (h.changed || final === 'all') { await gh.put('state', `hist-${cat}.bin.gz`, h.encode()); h.saved = true; h.changed = false; }
    await gh.put('state', 'state.json', Buffer.from(JSON.stringify(state)));
  };

  // ---- 1. the daily pull ----
  if (needPull) {
    let cats = state.cats && state.cats.length ? state.cats.slice() : cfg.categories.slice();
    const all = await tc.get(`${TC}/tcgplayer/categories`);
    for (const c of (all && all.results) || []) if (c.categoryId > cfg.lastKnownCategory && !cats.includes(c.categoryId)) { cats.push(c.categoryId); log('New TCGplayer category', c.categoryId, c.name); }
    for (const c of cfg.categories) if (!cats.includes(c)) cats.push(c);
    // TCGplayer's list of games, so Minty can notice a game TCGplayer adds (without asking TCGCSV itself)
    if (all && all.results) await gh.put('prices', 'categories.json', Buffer.from(JSON.stringify({ updated: upd, results: all.results.map(c => ({ categoryId: c.categoryId, name: c.name, displayName: c.displayName || c.name, modifiedOn: c.modifiedOn || '' })) })));
    state.cats = cats;
    const day = dayIndex(START, updDate);
    for (const cat of cats) {
      const old = await gh.download('prices', `prices-${cat}.json.gz`);
      const prev = old ? JSON.parse(zlib.gunzipSync(old)) : { groups: [], products: {} };
      const prevMod = Object.fromEntries((prev.groups || []).map(g => [g.groupId, g.modifiedOn]));
      const gj = await tc.get(`${TC}/tcgplayer/${cat}/groups`);
      const groups = ((gj && gj.results) || []).map(g => ({ groupId: g.groupId, name: g.name, abbreviation: g.abbreviation || '', publishedOn: g.publishedOn || '', modifiedOn: g.modifiedOn || '' }));
      const out = { cat, updated: upd, groups, products: {}, prices: {}, missing: [] };
      const h = await loadHist(cat);
      let newSets = 0;
      for (const g of groups) {
        const id = g.groupId;
        if (prev.products[id] && prevMod[id] === g.modifiedOn) out.products[id] = prev.products[id];
        else { try { out.products[id] = products(await tc.get(`${TC}/tcgplayer/${cat}/${id}/products`)); newSets++; } catch (e) { log('products', cat, id, e.message); out.products[id] = prev.products[id] || []; } }
        let pj;
        try { pj = await tc.get(`${TC}/tcgplayer/${cat}/${id}/prices`); } catch (e) { log('prices', cat, id, e.message); out.missing.push(id); continue; }
        const pr = prices(pj);
        out.prices[id] = pr;
        for (const [pid, subs] of Object.entries(pr)) for (const [sub, v] of Object.entries(subs)) h.set(pid + '|' + sub, id, day, cents(v));
      }
      priceFiles[cat] = out;
      log(`category ${cat}: ${groups.length} sets, ${newSets} product lists read, ${out.missing.length} price lists missing; requests so far ${tc.count}`);
    }
    state.apiStart = state.apiStart || updDate;
    // Publish today's prices and remember the pull before the archive work, so a later problem never repeats the pull.
    for (const [cat, out] of Object.entries(priceFiles)) await gh.put('prices', `prices-${cat}.json.gz`, zlib.gzipSync(Buffer.from(JSON.stringify(out)), { level: 9 }));
    state.lastPull = upd;
    state.pullRequests = tc.count;
    state.req.n += tc.count; counted = tc.count;
    await saveAll();
  }

  // ---- 2. the archive, a batch at a time ----
  const catSet = new Set((state.cats || cfg.categories).map(String));
  let read = 0, failed = null;
  while (backlog.length && Date.now() < deadline - 25 * 60000) {
    const days = backlog.splice(0, batch);
    for (const cat of catSet) await loadHist(cat);
    try {
    for (const d of days) {
      // An archive kept from a run that could not read it is used again, so TCGCSV is never asked for it twice.
      const kept = await gh.download('state', `archive-${d}.7z`);
      const buf = kept || await tc.get(ARCHIVE(d), 'buffer');
      if (!buf) { state.archives[d] = 'none'; log('no archive for', d); continue; }
      const f = path.join(tmp, d + '.7z'), dir = path.join(tmp, 'x');
      fs.writeFileSync(f, buf);
      const day = dayIndex(START, d);
      // Only Minty's categories are unpacked (<day>/<category>/<set>/prices); if that finds nothing, everything is.
      const readDir = () => {
        let rows = 0;
        const walk = (p, depth) => {
          for (const e of fs.readdirSync(p, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            const q = path.join(p, e.name);
            if (catSet.has(e.name) && fs.existsSync(path.join(q)) && fs.readdirSync(q).some(g => fs.existsSync(path.join(q, g, 'prices')))) {
              const h = hist[e.name];
              for (const g of fs.readdirSync(q)) {
                const pf = path.join(q, g, 'prices');
                if (!fs.existsSync(pf)) continue;
                let j; try { j = JSON.parse(fs.readFileSync(pf, 'utf8')); } catch (_) { continue; }
                for (const r of (j.results || (Array.isArray(j) ? j : []))) { const c = cents(r.marketPrice); if (c) { h.set(r.productId + '|' + (r.subTypeName || 'Normal'), +g, day, c); rows++; } }
              }
            } else if (depth < 3) walk(q, depth + 1);
          }
        };
        if (fs.existsSync(dir)) walk(dir, 0);
        return rows;
      };
      fs.rmSync(dir, { recursive: true, force: true });
      execFileSync(sevenZip, ['x', '-y', '-bd', '-o' + dir, f, ...[...catSet].map(c => `${d}/${c}/*`), '-r'], { stdio: 'ignore' });
      let rows = readDir();
      if (!rows) {
        fs.rmSync(dir, { recursive: true, force: true });
        execFileSync(sevenZip, ['x', '-y', '-bd', '-o' + dir, f], { stdio: 'ignore' });
        rows = readDir();
      }
      if (!rows) {
        // Unreadable: keep the archive in our own release and stop, so it is looked at without asking TCGCSV again.
        if (!kept) await gh.put('state', `archive-${d}.7z`, buf);
        const list = execFileSync(sevenZip, ['l', '-ba', f]).toString().split('\n').slice(0, 15).join('\n');
        throw new Error(`archive ${d}: no prices found for Minty's categories. First entries:\n${list}`);
      }
      if (kept) await gh.remove('state', `archive-${d}.7z`);
      fs.rmSync(f);
      fs.rmSync(dir, { recursive: true, force: true });
      state.archives[d] = rows;
      read++;
      if (read === 1 || read % 20 === 0) log(`archive ${d}: ${rows} prices`);
    }
    } catch (e) { // keep what was read (those archives are not asked for again) and stop reading the archive until fixed
      failed = e; log('ARCHIVE STOPPED:', e.message);
      state.archiveError = { day: (e.message.match(/archive (\S+):/) || [])[1] || '', parser, message: e.message };
      backlog.length = 0;
    }
    await saveAll(); // after each batch: an archive is never downloaded twice
    log(`saved after archive batch; ${backlog.length} days left`);
  }

  // ---- 3. publish ----
  state.req.n += tc.count - counted; // archive downloads count too
  await saveAll();
  const idxBuf = await gh.download('history', 'index.json');
  const index = idxBuf ? JSON.parse(idxBuf) : { start: START, categories: {} };
  for (const [cat, h] of Object.entries(hist)) {
    if (!h.saved && index.categories[cat]) continue;
    // sets → bunches of about historyBucketBytes (before compression)
    const size = {};
    for (const [k, s] of h.series) size[s.g] = (size[s.g] || 0) + 12 + k.length + Hist.used(s) * 3;
    const gids = Object.keys(size).map(Number).sort((a, b) => a - b);
    const buckets = []; let cur = [], acc = 0;
    for (const g of gids) { if (cur.length && acc + size[g] > cfg.historyBucketBytes) { buckets.push(cur); cur = []; acc = 0; } cur.push(g); acc += size[g]; }
    if (cur.length) buckets.push(cur);
    const map = {};
    for (let i = 0; i < buckets.length; i++) {
      for (const g of buckets[i]) map[g] = i;
      await gh.put('history', `h-${cat}-${i}.json.gz`, zlib.gzipSync(Buffer.from(JSON.stringify({ cat: +cat, start: START, series: h.bucketJson(buckets[i]) })), { level: 9 }));
    }
    const was = index.categories[cat] ? index.categories[cat].files : 0;
    for (let i = buckets.length; i < was; i++) await gh.remove('history', `h-${cat}-${i}.json.gz`);
    index.categories[cat] = { files: buckets.length, sets: map, days: h.days() };
  }
  index.start = START; index.updated = state.lastPull; index.built = new Date().toISOString();
  index.archiveDaysLeft = backlog.length;
  index.historyEnd = dateOf(START, Math.max(0, ...Object.values(index.categories).map(c => c.days)) - 1);
  await gh.put('history', 'index.json', Buffer.from(JSON.stringify(index)));
  await gh.writeFile('status.json', JSON.stringify({ pricesUpdated: state.lastPull, historyFrom: START, historyTo: index.historyEnd, archiveDaysLeft: backlog.length, categories: state.cats, built: index.built }, null, 2) + '\n', 'Daily data ' + (state.lastPull || '').slice(0, 10));
  fs.rmSync(tmp, { recursive: true, force: true });
  log(`Done. TCGCSV requests ${tc.count}, GitHub calls ${gh.calls}, archive days read ${read}, left ${backlog.length}.`);
  return { did: true, state, index, requests: tc.count, error: failed };
}

module.exports = { main, products, prices, Tcgcsv };
if (require.main === module) main().then(r => { if (r.error) { console.error(r.error); process.exit(1); } }).catch(e => { console.error(e); process.exit(1); });
