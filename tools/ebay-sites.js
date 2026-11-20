// One-off check for Minty's eBay links outside the US: for each eBay country site in the eBay Partner Network, does
// the category Minty uses exist there (and what is it called), and what do Minty's searches find there – how many,
// in what currency, and which words in the titles say a card is not in English. Writes out/ebay-sites.json.
// Run by .github/workflows/ebay-sites.yml with the EBAY_APP_ID / EBAY_CERT_ID secrets.
'use strict';
const fs = require('fs');
const ID = process.env.EBAY_APP_ID, SECRET = process.env.EBAY_CERT_ID;
const SITES = ['EBAY_US', 'EBAY_GB', 'EBAY_DE', 'EBAY_FR', 'EBAY_IT', 'EBAY_ES', 'EBAY_NL', 'EBAY_BE', 'EBAY_AT', 'EBAY_CH', 'EBAY_IE', 'EBAY_PL', 'EBAY_CA', 'EBAY_AU'];
const CATS = { 183454: 'cards (Minty: singles)', 2536: 'sealed (Minty: sealed)', 183456: 'CCG sealed boxes?', 261044: 'TCG cards?' };
const SEARCHES = [
  { id: 'pkm-card', q: 'Pokemon Umbreon VMAX 215/203', cat: '183454' },
  { id: 'pkm-card-nocat', q: 'Pokemon Umbreon VMAX 215/203', cat: '' },
  { id: 'op-card', q: 'One Piece Monkey.D.Luffy OP01-003', cat: '183454' },
  { id: 'mtg-card', q: 'Magic Sol Ring Commander Masters', cat: '183454' },
  { id: 'pkm-sealed', q: 'Pokemon Surging Sparks Booster Box', cat: '2536' },
  { id: 'pkm-sealed-nocat', q: 'Pokemon Surging Sparks Booster Box', cat: '' },
  { id: 'pkm-etb', q: 'Pokemon Prismatic Evolutions Elite Trainer Box', cat: '2536' }
];
const LANG = /\b(deutsch|englisch|english|englisch|japanisch|japanese|japonais|giapponese|japon[eé]s|japans|japo[nń]ski|chinesisch|chinese|chinois|cinese|chino|koreanisch|korean|cor[eé]en|coreano|fran[cç]ais|francese|franc[eé]s|italiano|italienisch|espa[nñ]ol|spanisch|nederlands|polski|eng|ger|jap|jp|dt|fra|ita|esp)\b/gi;

async function token() {
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(ID + ':' + SECRET).toString('base64') }, body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope') });
  const j = await r.json(); if (!j.access_token) throw new Error('token: ' + JSON.stringify(j).slice(0, 200)); return j.access_token;
}
(async () => {
  const t = await token(), H = m => ({ authorization: 'Bearer ' + t, 'X-EBAY-C-MARKETPLACE-ID': m, 'Accept-Language': 'en-US' });
  const out = { at: new Date().toISOString(), sites: {} };
  for (const m of SITES) {
    const s = out.sites[m] = { cats: {}, searches: {} };
    try {
      const tr = await (await fetch('https://api.ebay.com/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=' + m, { headers: H(m) })).json();
      s.tree = tr.categoryTreeId;
      for (const c of Object.keys(CATS)) {
        const r = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/${tr.categoryTreeId}/get_category_subtree?category_id=${c}`, { headers: H(m) });
        const j = await r.json();
        s.cats[c] = r.ok ? { name: j.categorySubtreeNode && j.categorySubtreeNode.category && j.categorySubtreeNode.category.categoryName, children: ((j.categorySubtreeNode && j.categorySubtreeNode.childCategoryTreeNodes) || []).map(x => x.category.categoryId + ' ' + x.category.categoryName).slice(0, 12) } : { error: r.status + ' ' + JSON.stringify(j.errors && j.errors[0] && j.errors[0].message) };
      }
    } catch (e) { s.taxonomyError = e.message; }
    for (const q of SEARCHES) {
      try {
        const p = new URLSearchParams({ q: q.q, limit: '50', filter: 'buyingOptions:{FIXED_PRICE}' }); if (q.cat) p.set('category_ids', q.cat);
        const r = await fetch('https://api.ebay.com/buy/browse/v1/item_summary/search?' + p, { headers: H(m) });
        const j = await r.json();
        if (!r.ok) { s.searches[q.id] = { error: r.status + ' ' + JSON.stringify(j.errors && j.errors[0] && j.errors[0].message) }; continue; }
        const items = j.itemSummaries || [], words = {};
        for (const it of items) for (const w of (it.title.match(LANG) || [])) words[w.toLowerCase()] = (words[w.toLowerCase()] || 0) + 1;
        s.searches[q.id] = { total: j.total, cur: [...new Set(items.map(i => i.price && i.price.currency))].join(','), from: [...new Set(items.map(i => i.itemLocation && i.itemLocation.country))].slice(0, 8).join(','), cats: [...new Set(items.map(i => (i.categories || [])[0] && i.categories[0].categoryId + ' ' + i.categories[0].categoryName))].slice(0, 6), words, titles: items.slice(0, 10).map(i => i.title + ' | ' + (i.price && i.price.value + ' ' + i.price.currency)) };
      } catch (e) { s.searches[q.id] = { error: e.message }; }
    }
    console.log(m, s.tree, Object.entries(s.cats).map(([k, v]) => k + '=' + (v.name || v.error)).join('; '), Object.entries(s.searches).map(([k, v]) => k + ':' + (v.total ?? v.error)).join(' '));
  }
  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync('out/ebay-sites.json', JSON.stringify(out, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
