// One-off: real card scans of each Pokémon rarity, to draw the printed rarity symbols exactly. Results in the "checks" release.
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  fs.mkdirSync('rar', { recursive: true });
  const names = ['Common', 'Uncommon', 'Rare', 'Double Rare', 'Ultra Rare', 'Illustration Rare', 'Special Illustration Rare', 'Hyper Rare', 'Shiny Rare', 'Shiny Ultra Rare', 'ACE SPEC Rare', 'Black White Rare', 'Mega Hyper Rare', 'Mega Attack Rare', 'Rare Holo'];
  const log = [];
  for (const n of names) {
    try {
      const r = await fetch('https://api.tcgdex.net/v2/en/cards?rarity=' + encodeURIComponent('eq:' + n) + '&pagination:itemsPerPage=40');
      const list = (await r.json()) || [];
      const pick = list.filter(c => c.image).slice(-2); // newest sets last
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
