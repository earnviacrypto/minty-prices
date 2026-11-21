// One-off: which eBay search link shapes find sold listings (count of results per variant).
const base = 'https://www.ebay.com/sch/i.html?';
const V = {
  plain: '_nkw=Pokemon+Flowing+Fists+Booster+Box&LH_Sold=1&LH_Complete=1',
  plainNew: '_nkw=Pokemon+Flowing+Fists+Booster+Box&LH_Sold=1&LH_Complete=1&LH_ItemCondition=1000',
  plainCat: '_nkw=Pokemon+Flowing+Fists+Booster+Box&_sacat=2536&LH_Sold=1&LH_Complete=1',
  plainCatNew: '_nkw=Pokemon+Flowing+Fists+Booster+Box&_sacat=2536&LH_Sold=1&LH_Complete=1&LH_ItemCondition=1000',
  minus1: '_nkw=Pokemon+Flowing+Fists+Booster+Box+-case&LH_Sold=1&LH_Complete=1',
  minus8: '_nkw=Pokemon+Flowing+Fists+Booster+Box+-case+-lot+-empty+-opened+-code+-japanese+-chinese+-korean&LH_Sold=1&LH_Complete=1',
  ours: '_nkw=Pokemon+Flowing+Fists+Booster+Box+-case+-lot+-empty+-opened+-code+-japanese+-chinese+-korean&_sacat=2536&LH_Sold=1&LH_Complete=1&_sop=13&LH_ItemCondition=1000',
  oursNoCond: '_nkw=Pokemon+Flowing+Fists+Booster+Box+-case+-lot+-empty+-opened+-code+-japanese+-chinese+-korean&_sacat=2536&LH_Sold=1&LH_Complete=1&_sop=13',
  oursNoCat: '_nkw=Pokemon+Flowing+Fists+Booster+Box+-case+-lot+-empty+-opened+-code+-japanese+-chinese+-korean&LH_Sold=1&LH_Complete=1&_sop=13&LH_ItemCondition=1000',
  ours1000_1500: '_nkw=Pokemon+Flowing+Fists+Booster+Box+-case+-lot+-empty+-opened+-code+-japanese+-chinese+-korean&_sacat=2536&LH_Sold=1&LH_Complete=1&_sop=13&LH_ItemCondition=1000%7C1500',
  raw: '_nkw=Pokemon+Umbreon+ex+092%2F128+-psa+-bgs+-cgc+-proxy+-lot+-japanese+-chinese+-korean&_sacat=183454&LH_Sold=1&LH_Complete=1&_sop=13',
  rawPlain: '_nkw=Pokemon+Umbreon+ex+092%2F128&_sacat=183454&LH_Sold=1&LH_Complete=1&_sop=13'
};
(async () => {
  const out = {};
  for (const [k, q] of Object.entries(V)) {
    try {
      const r = await fetch(base + q, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'accept-language': 'en-US,en;q=0.9' } });
      const t = await r.text();
      const m = t.match(/<h1[^>]*srp-controls__count-heading[^>]*>([\s\S]*?)<\/h1>/) || t.match(/([\d,]+)\s+results? for/);
      out[k] = { status: r.status, count: m ? m[1].replace(/<[^>]+>/g, '').trim().slice(0, 80) : null, len: t.length, noexact: /No exact matches found/.test(t), sold: (t.match(/s-item__title|s-card__title/g) || []).length };
    } catch (e) { out[k] = { error: e.message }; }
    await new Promise(r => setTimeout(r, 1500));
  }
  require('fs').writeFileSync('ebay-search-check.json', JSON.stringify(out, null, 1));
})();
