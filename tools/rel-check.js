// One-off: full TCGplayer product details and pictures for two upcoming sets, for the Releases pop-up mockup.
const fs = require('fs');
const UA = { 'user-agent': 'MintyPrices/1.0 (+https://github.com/earnviacrypto/minty-prices)' };
(async () => {
  const out = {}; fs.mkdirSync('img', { recursive: true });
  for (const [cat, gid] of JSON.parse(process.argv[2])) {
    const r = await fetch(`https://tcgcsv.com/tcgplayer/${cat}/${gid}/products`, { headers: UA }); const p = await r.json();
    out[gid] = p.results.map(x => ({ id: x.productId, name: x.name, img: x.imageUrl, ext: x.extendedData, presale: x.presaleInfo }));
    for (const x of p.results.slice(0, 40)) { const i = await fetch(x.imageUrl.replace('_200w', '_400w')); if (i.ok) fs.writeFileSync(`img/${x.productId}.jpg`, Buffer.from(await i.arrayBuffer())); }
  }
  fs.writeFileSync('rel-check.json', JSON.stringify(out, null, 1));
})();
