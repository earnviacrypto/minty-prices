// One-off: does eBay return the seller's Card Condition (and the catalog product) for US trading-card listings?
// Reads today's deals, looks up 40 card listings with getItem, writes cond-check.json (no seller names, no tokens).
const fs = require('fs');
(async () => {
  const appId = process.env.EBAY_APP_ID, certId = process.env.EBAY_CERT_ID;
  const t = await fetch('https://api.ebay.com/identity/v1/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(appId + ':' + certId).toString('base64') }, body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope') });
  if (!t.ok) throw new Error('sign-in ' + t.status);
  const token = (await t.json()).access_token;
  const deals = JSON.parse(fs.readFileSync('deals.json', 'utf8')).deals.filter(d => d.kind !== 'sealed').slice(0, 40);
  const out = [];
  for (const d of deals) {
    const r = await fetch('https://api.ebay.com/buy/browse/v1/item/' + encodeURIComponent(d.lid), { headers: { authorization: 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } });
    if (!r.ok) { out.push({ lid: d.lid, title: d.title, error: r.status }); continue; }
    const j = await r.json();
    const asp = (j.localizedAspects || []).filter(a => /condition|graded|grade|language|set|card number|manufacturer|product/i.test(a.name)).map(a => a.name + ': ' + a.value);
    out.push({ lid: d.lid, name: d.name, title: d.title, condition: j.condition, conditionId: j.conditionId, descriptors: (j.conditionDescriptors || []).map(c => ({ name: c.name, values: (c.values || []).map(v => v.content) })), epid: j.epid || null, aspects: asp });
  }
  const s = { checked: out.length, withCardCondition: out.filter(o => (o.descriptors || []).some(c => /card condition/i.test(c.name))).length, withEpid: out.filter(o => o.epid).length };
  fs.writeFileSync('cond-check.json', JSON.stringify({ summary: s, items: out }, null, 1));
  console.log(JSON.stringify(s));
})().catch(e => { console.error(e.message); process.exit(1); });
