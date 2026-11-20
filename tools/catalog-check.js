// One-off check of eBay's Catalog API (stock pictures): signs in with the EBAY_REFRESH_TOKEN secret and searches a few
// cards from different games. Writes checks/catalog.json (titles, catalog numbers and picture links only – no tokens).
const fs = require('fs');
const { EBAY_APP_ID: ID, EBAY_CERT_ID: CERT, EBAY_REFRESH_TOKEN: RT } = process.env;
const SCOPES = 'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/commerce.catalog.readonly';
const Q = [
  ['Pokémon', 'Charizard 4/102 Base Set'], ['Pokémon', 'Pikachu ex 247/191 Surging Sparks'], ['Pokémon', 'Umbreon VMAX 215/203'],
  ['Magic', 'Sol Ring'], ['Yu-Gi-Oh!', 'Dark Magician LOB'], ['One Piece', 'Monkey.D.Luffy OP01-003'],
  ['Lorcana', 'Elsa Spirit of Winter'], ['Riftbound', 'Teemo Swift Scout'], ['Sealed', 'Pokemon Surging Sparks Elite Trainer Box'],
];
(async () => {
  const out = { at: new Date().toISOString(), token: null, results: [] };
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(ID + ':' + CERT).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: (RT || '').trim(), scope: SCOPES }),
  });
  const t = await r.json();
  out.token = r.ok ? 'ok, access token valid ' + t.expires_in + ' s' : { status: r.status, error: t.error, description: t.error_description };
  if (r.ok) for (const [game, q] of Q) {
    const u = 'https://api.ebay.com/commerce/catalog/v1_beta/product_summary/search?limit=3&q=' + encodeURIComponent(q);
    const s = await fetch(u, { headers: { Authorization: 'Bearer ' + t.access_token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } });
    const d = await s.json().catch(() => ({}));
    out.results.push({ game, q, status: s.status, total: d.total, errors: d.errors && d.errors.map(e => e.message),
      found: (d.productSummaries || []).map(p => ({ title: p.title, epid: p.epid, image: p.image && p.image.imageUrl, more: (p.additionalImages || []).length })) });
  }
  fs.mkdirSync('checks', { recursive: true });
  fs.writeFileSync('checks/catalog.json', JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
})();
