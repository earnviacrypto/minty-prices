// One-off: what TCGplayer says about upcoming sets' products (extendedData: description, pack counts) – to see what a
// Releases pop-up can show. Writes rel-check.json.
(async () => {
  const out = {};
  const get = async u => { const r = await fetch(u, { headers: { 'user-agent': 'MintyPrices/1.0 (+https://github.com/earnviacrypto/minty-prices)' } }); console.log(u, r.status); return r.ok ? r.json() : null; };
  for (const cat of [89, 2, 3, 68, 1, 85, 92]) {
    const gs = (await get(`https://tcgcsv.com/tcgplayer/${cat}/groups`)) || { results: [] };
    const now = Date.now();
    console.log(cat, gs.results.length);
    const up = gs.results.filter(g => /T00:00:00/.test(g.publishedOn) && Date.parse(g.publishedOn) > now - 15 * 864e5 && Date.parse(g.publishedOn) < now + 100 * 864e5);
    for (const g of up.slice(0, 6)) {
      const p = (await get(`https://tcgcsv.com/tcgplayer/${cat}/${g.groupId}/products`)) || { results: [] };
      const sealed = p.results.filter(x => !(x.extendedData || []).some(e => e.name === 'Number'));
      out[cat + ' ' + g.name] = { cards: p.results.length - sealed.length, sealed: sealed.slice(0, 6).map(x => ({ name: x.name, ext: x.extendedData, presale: x.presaleInfo })) };
      await new Promise(r => setTimeout(r, 300));
    }
  }
  require('fs').writeFileSync('rel-check.json', JSON.stringify(out, null, 1));
})();
