// One-off (3rd batch): Hyper Rare and Shiny Rare scans, by card id, with the rarity TCGdex gives.
const fs = require('fs');
(async () => {
  fs.mkdirSync('rar', { recursive: true }); const log = [];
  for (const id of ['sv08-250', 'sv08-252', 'sv06-226', 'sv04.5-100', 'sv04.5-130', 'sv04.5-200', 'sv03.5-205', 'sv10-240']) {
    try { const c = await (await fetch('https://api.tcgdex.net/v2/en/cards/' + id)).json(); const u = c.image + '/high.png'; const b = Buffer.from(await (await fetch(u)).arrayBuffer()); fs.writeFileSync('rar/' + id + '.png', b); log.push([id, c.name, c.rarity, b.length]); }
    catch (e) { log.push([id, 'ERR ' + e.message]); }
    await new Promise(r => setTimeout(r, 300));
  }
  fs.writeFileSync('rar/log.json', JSON.stringify(log, null, 1)); console.log(log);
})();
