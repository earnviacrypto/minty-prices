// One-off (2nd batch): can the job read the makers' own product pages (release dates, contents)? Saves robots.txt and each page.
const fs = require('fs'), path = require('path');
const UA = 'Mozilla/5.0 (compatible; minty-prices/1.0; +https://github.com/earnviacrypto/minty-prices)';
const PAGES = [
  ['op-op19', 'https://en.onepiece-cardgame.com/products/op19.html'],
  ['op-st38', 'https://en.onepiece-cardgame.com/products/st38.html'],
  ['op-eb06', 'https://en.onepiece-cardgame.com/products/eb06.html'],
  ['dg-st25', 'https://world.digimoncard.com/products/deck/st-25/'],
  ['dg-bt27', 'https://world.digimoncard.com/products/pack/ver27/'],
  ['db-list-booster', 'https://www.dbs-cardgame.com/fw/en/products/?tags=BoosterPack&page=1'],
  ['db-01_348', 'https://www.dbs-cardgame.com/fw/en/products/01_348.html'],
  ['ua-ark-1', 'https://www.unionarena-tcg.com/na/products/boosters/ark-1.php'],
  ['gd-gd06', 'https://www.gundam-gcg.com/en/products/gd06.html'],
  ['gd-st14', 'https://www.gundam-gcg.com/en/products/st14.html'],
  ['yg-booster', 'https://www.yugioh-card.com/en/products/booster-pack/'],
  ['yg-terms', 'https://www.yugioh-card.com/en/terms-of-use/'],
  ['yg-terms2', 'https://www.konami.com/games/us/en/terms/'],
  ['pk-terms', 'https://www.pokemon.com/us/legal/terms-of-use'],
  ['pk-news', 'https://www.pokemon.com/us/pokemon-news'],
  ['bandai-terms', 'https://www.bandai.co.jp/en/site/'],
];
(async () => {
  const out = 'maker-check'; fs.mkdirSync(out, { recursive: true });
  const sum = {}; const robotsDone = new Set();
  for (const [k, u] of PAGES) {
    const host = new URL(u).origin;
    if (false && !robotsDone.has(host)) { robotsDone.add(host);
      try { const r = await fetch(host + '/robots.txt', { headers: { 'user-agent': UA } }); const t = await r.text(); fs.writeFileSync(path.join(out, 'robots-' + new URL(u).hostname + '.txt'), r.status + '\n' + t); } catch (e) { fs.writeFileSync(path.join(out, 'robots-' + new URL(u).hostname + '.txt'), 'ERR ' + e.message); } }
    try { const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'text/html' } }); const t = await r.text(); fs.writeFileSync(path.join(out, k + '.html'), t); sum[k] = { url: u, status: r.status, final: r.url, len: t.length }; }
    catch (e) { sum[k] = { url: u, error: e.message }; }
    await new Promise(r => setTimeout(r, 1500));
  }
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(sum, null, 1));
  console.log(JSON.stringify(sum, null, 1));
})();
