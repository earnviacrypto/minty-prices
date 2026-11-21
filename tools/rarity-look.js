// One-off (2nd batch, Scarlet & Violet / Mega Evolution scans): real card scans of each Pokémon rarity, to draw the printed rarity symbols exactly. Results in the "checks" release.
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  fs.mkdirSync('rar', { recursive: true });
  const names = ['Double rare', 'Ultra Rare', 'Illustration rare', 'Special illustration rare', 'Hyper rare', 'Shiny rare', 'Common', 'Uncommon', 'Rare'];
  const log = [];
  for (const n of names) {
    try {
      const r = await fetch('https://api.tcgdex.net/v2/en/cards?rarity=' + encodeURIComponent(n) + '&pagination:itemsPerPage=400');
      const list = (await r.json()) || [];
      const pick = list.filter(c => c.image && /^(sv|me)/.test(c.id) && !/sv0?\d?\.?\d*-/.test('')).filter(c => /^(sv0[5-9]|sv10|me)/.test(c.id)).slice(-2); // newest sets last
      for (const [i, c] of pick.entries()) {
        const u = c.image + '/high.png', b = Buffer.from(await (await fetch(u)).arrayBuffer());
        const f = 'rar/' + n.replace(/\W+/g, '_') + '_' + i + '.png'; fs.writeFileSync(f, b); log.push([n, c.id, c.name, u, b.length]);
        await sleep(300);
      }
      if (!pick.length) log.push([n, 'none', list.length]);
    } catch (e) { log.push([n, 'ERR ' + e.message]); }
  }
  fs.writeFileSync('rar/log.json', JSON.stringify(log, null, 1)); console.log(log);
})();
