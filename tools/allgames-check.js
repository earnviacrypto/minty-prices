// One-off: every TCGplayer category with sets coming out in the next 100 days or out in the last 14 (for the Releases mockup).
const UA = { 'user-agent': 'MintyPrices/1.0 (+https://github.com/earnviacrypto/minty-prices)' };
(async () => {
  const get = async u => { const r = await fetch(u, { headers: UA }); return r.ok ? r.json() : { results: [] }; };
  const cats = (await get('https://tcgcsv.com/tcgplayer/categories')).results;
  const now = Date.now(), out = [];
  for (const c of cats) {
    const gs = (await get(`https://tcgcsv.com/tcgplayer/${c.categoryId}/groups`)).results || [];
    const win = gs.filter(g => /T00:00:00/.test(g.publishedOn) && Date.parse(g.publishedOn) > now - 14 * 864e5 && Date.parse(g.publishedOn) < now + 100 * 864e5);
    if (win.length) out.push({ cat: c.categoryId, name: c.displayName || c.name, sets: win.map(g => ({ name: g.name, date: g.publishedOn.slice(0, 10) })) });
    await new Promise(r => setTimeout(r, 120));
  }
  require('fs').writeFileSync('allgames-check.json', JSON.stringify({ cats: cats.map(c => [c.categoryId, c.displayName || c.name, c.isScannable]), win: out }, null, 1));
})();
