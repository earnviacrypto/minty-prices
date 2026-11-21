// One-off: which news feeds answer, how often they post, and how many items are about trading card games.
const FEEDS = {
  'Bell of Lost Souls': 'https://www.belloflostsouls.net/feed', 'GeekDad': 'https://geekdad.com/feed/', 'Graphic Policy (TCG)': 'https://graphicpolicy.com/tag/tcg/feed/',
  'Graphic Policy (card games)': 'https://graphicpolicy.com/category/games/card-games/feed/', 'Meeple Mountain': 'https://www.meeplemountain.com/feed/',
  'TCG Rocks': 'https://tcgrocks.com/feed/', 'Bleeding Cool card games': 'https://bleedingcool.com/games/tabletop/card-games/feed/', 'ICv2': 'https://icv2.com/rss/news',
  'ICv2 games': 'https://icv2.com/rss/games', 'Dot Esports TCG': 'https://dotesports.com/tcg/feed', 'Tabletop Gaming': 'https://www.tabletopgaming.co.uk/feed/',
  'PokeBeach': 'https://www.pokebeach.com/feed', 'Dicebreaker': 'https://www.dicebreaker.com/feed', 'EN World': 'https://www.enworld.org/ewr-porta/index.rss',
  'Polygon tabletop': 'https://www.polygon.com/rss/tabletop-games/index.xml', 'Card Gamer': 'https://cardgamer.com/feed/', 'Tabletop Gaming News': 'https://www.tabletopgamingnews.com/feed/',
  'BoardGameWire': 'https://boardgamewire.com/index.php/feed/', 'Kicktraq hot': 'https://www.kicktraq.com/hot/rss/'
};
const TCG = /\b(tcg|trading card|card game|ccg|booster|starter deck)\b/i, CROWD = /\b(kickstarter|crowdfund|gamefound|backerkit|campaign|pledge)\b/i;
const UA = { 'user-agent': 'MintyPrices/1.0 (+https://github.com/earnviacrypto/minty-prices)' };
(async () => {
  const out = {};
  for (const [name, url] of Object.entries(FEEDS)) {
    try {
      const r = await fetch(url, { headers: UA, redirect: 'follow' }); const t = await r.text();
      const items = [...t.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/g)].map(m => m[0]);
      const tit = x => ((x.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
      const date = x => ((x.match(/<(pubDate|published|updated|dc:date)>([^<]+)</) || [])[2] || '').trim();
      const tcg = items.filter(x => TCG.test(tit(x)) || TCG.test(x.slice(0, 3000)));
      out[name] = { status: r.status, type: r.headers.get('content-type'), items: items.length, newest: items[0] ? date(items[0]) : '', oldest: items.length ? date(items[items.length - 1]) : '',
        tcg: tcg.length, tcgCrowd: tcg.filter(x => CROWD.test(x)).length, sample: tcg.slice(0, 6).map(tit) };
    } catch (e) { out[name] = { error: e.message }; }
  }
  require('fs').writeFileSync('feed-check.json', JSON.stringify(out, null, 1));
})();
