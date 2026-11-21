// One-off: can the job read the makers' own product pages (release dates, contents)? Saves robots.txt and each page.
const fs = require('fs'), path = require('path');
const UA = 'Mozilla/5.0 (compatible; minty-prices/1.0; +https://github.com/earnviacrypto/minty-prices)';
const PAGES = [
  ['onepiece', 'https://en.onepiece-cardgame.com/products/'],
  ['onepiece2', 'https://en.onepiece-cardgame.com/products/?page=2'],
  ['gundam', 'https://www.gundam-gcg.com/en/products/'],
  ['digimon', 'https://world.digimoncard.com/products/'],
  ['dbfw', 'https://www.dbs-cardgame.com/fw/en/products/'],
  ['unionarena', 'https://www.unionarena-tcg.com/na/products/'],
  ['yugioh', 'https://www.yugioh-card.com/en/products/'],
  ['yugioh-bp', 'https://www.yugioh-card.com/en/products/booster-packs/'],
  ['pokemon', 'https://www.pokemon.com/us/pokemon-tcg/'],
  ['pokemon-exp', 'https://www.pokemon.com/us/pokemon-tcg/pokemon-tcg-expansions'],
  ['cyberpunk', 'https://cyberpunktcg.com/'],
];
(async () => {
  const out = 'maker-check'; fs.mkdirSync(out, { recursive: true });
  const sum = {}; const robotsDone = new Set();
  for (const [k, u] of PAGES) {
    const host = new URL(u).origin;
    if (!robotsDone.has(host)) { robotsDone.add(host);
      try { const r = await fetch(host + '/robots.txt', { headers: { 'user-agent': UA } }); const t = await r.text(); fs.writeFileSync(path.join(out, 'robots-' + new URL(u).hostname + '.txt'), r.status + '\n' + t); } catch (e) { fs.writeFileSync(path.join(out, 'robots-' + new URL(u).hostname + '.txt'), 'ERR ' + e.message); } }
    try { const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'text/html' } }); const t = await r.text(); fs.writeFileSync(path.join(out, k + '.html'), t); sum[k] = { url: u, status: r.status, final: r.url, len: t.length }; }
    catch (e) { sum[k] = { url: u, error: e.message }; }
    await new Promise(r => setTimeout(r, 1500));
  }
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(sum, null, 1));
  console.log(JSON.stringify(sum, null, 1));
})();
