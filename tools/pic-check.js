// One-off: which Releases pictures load? Every product and card picture address in releases.json, checked once.
const fs = require('fs');
(async () => {
  const d = await (await fetch('https://github.com/earnviacrypto/minty-prices/releases/download/prices/releases.json')).json();
  const out = { updated: d.updated, sets: [] };
  for (const s of d.sets) {
    const urls = [].concat(((s.info || {}).products || []).map(p => ['p', p.img]), ((s.info || {}).cards || []).map(c => ['c', c.img])).filter(x => x[1]);
    const res = [];
    for (const [k, u] of urls) {
      try { const r = await fetch(u, { headers: { 'user-agent': 'MintyTCGPortfolio/2.0.85' } }); const b = Buffer.from(await r.arrayBuffer()); res.push([k, u, r.status, r.headers.get('content-type'), b.length]); }
      catch (e) { res.push([k, u, 'ERR ' + e.message]); }
      await new Promise(r => setTimeout(r, 120));
    }
    out.sets.push({ cat: s.cat, set: s.set, res });
  }
  fs.writeFileSync('pic-check.json', JSON.stringify(out, null, 1));
  for (const s of out.sets) console.log(s.cat, s.set, s.res.map(r => r[2]).join(' '));
})();
