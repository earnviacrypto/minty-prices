// One-off: which news feeds answer, how often they post, and how many items are about trading card games.
const FEEDS = {
  'Games Press news': 'https://www.gamespress.com/News/RSS', 'The Outer Haven TCG': 'https://www.theouterhaven.net/tag/tcg-news/feed/', 'CGMagazine TCG': 'https://www.cgmagonline.com/tag/trading-card-game/feed/',
  'onepiece.gg': 'https://onepiece.gg/feed/', 'KitGuru TCG': 'https://www.kitguru.net/tag/trading-card-game/feed/', 'ICv2 a': 'https://icv2.com/rss', 'ICv2 b': 'https://icv2.com/articles/rss',
  'ICv2 c': 'https://icv2.com/feeds/news', 'TCG Rocks b': 'https://tcgrocks.com/feed', 'Card Gamer': 'https://cardgamer.com/feed/', 'Bleeding Cool card games': 'https://bleedingcool.com/games/tabletop/card-games/feed/',
  'Graphic Policy card games': 'https://graphicpolicy.com/category/games/card-games/feed/', 'Tabletop Gaming': 'https://www.tabletopgaming.co.uk/feed/', 'BoardGameWire': 'https://boardgamewire.com/index.php/feed/',
  'Shonen TCG': 'https://www.shonentcg.com/blog-feed.xml', 'Comicbook tabletop': 'https://comicbook.com/gaming/feed/', 'Dicebreaker b': 'https://www.dicebreaker.com/feed/news',
  'Bell of Lost Souls card games': 'https://www.belloflostsouls.net/category/card-games/feed', 'GeekDad crowdfunding': 'https://geekdad.com/tag/crowdfunding/feed/', 'GeekDad kickstarter': 'https://geekdad.com/category/gaming/kickstarter/feed/'
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
