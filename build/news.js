// TCG news for Minty: headlines about trading card games – new games, new sets, crowdfunding campaigns – from established
// news sites' own RSS feeds. Only the headline, date, link and site name are kept; articles are never copied.
// Runs with the Releases step (every 6 hours) and publishes prices/news.json (the last 30 days, newest first).
const { GitHub, sleep } = require('./gh');

const NEWS_VERSION = 1;
const UA = 'MintyPrices/1.0 (+https://github.com/earnviacrypto/minty-prices)';
// all: the feed is only about card games, so every item counts
const FEEDS = [
  { name: 'Bleeding Cool', url: 'https://bleedingcool.com/games/tabletop/card-games/feed/' },
  { name: 'Card Gamer', url: 'https://cardgamer.com/feed/' },
  { name: 'onepiece.gg', url: 'https://onepiece.gg/feed/', all: true },
  { name: 'Graphic Policy', url: 'https://graphicpolicy.com/category/games/card-games/feed/' },
  { name: 'Tabletop Gaming', url: 'https://www.tabletopgaming.co.uk/feed/' },
  { name: 'BoardGameWire', url: 'https://boardgamewire.com/index.php/feed/' },
  { name: 'ICv2', url: 'https://icv2.com/rss' },
  { name: 'CGMagazine', url: 'https://www.cgmagonline.com/tag/trading-card-game/feed/' },
  { name: 'KitGuru', url: 'https://www.kitguru.net/tag/trading-card-game/feed/' },
  { name: 'Bell of Lost Souls', url: 'https://www.belloflostsouls.net/feed' },
  { name: 'GeekDad', url: 'https://geekdad.com/category/gaming/kickstarter/feed/' },
  { name: 'Meeple Mountain', url: 'https://www.meeplemountain.com/feed/' },
  { name: 'Games Press', url: 'https://www.gamespress.com/News/RSS' }
];
const GAMES = [
  ['pokemon', /pok[eé]mon/i], ['onepiece', /one piece/i], ['magic', /magic: the gathering|\bmtg\b|secret lair/i], ['yugioh', /yu-gi-oh/i],
  ['riftbound', /riftbound/i], ['gundam', /gundam/i], ['cyberpunk', /cyberpunk/i], ['lorcana', /lorcana/i], ['swu', /star wars unlimited/i]
];
const TCG = /\b(tcg|ccg|trading card|card game|booster (box|pack|display)|starter deck|expansion|riftbound|lorcana|yu-gi-oh|one piece card|magic: the gathering|pok[eé]mon tcg|star wars unlimited|flesh and blood|union arena|digimon card|weiss schwarz|vanguard|universus|sorcery: contested realm|altered tcg|grand archive)\b/i;
const NOT = /\b(video game|board game review|tabletop rpg|ttrpg|\bd&d\b|dungeons|warhammer|miniatures?)\b/i; // other hobbies
const CROWD = /\b(kickstarter|crowdfund\w*|gamefound|backerkit|pledge|late pledge)\b/i;
const NEWGAME = /\b(new (trading )?card game|announc\w+ .*(trading card game|tcg)|(trading card game|tcg) (announced|revealed|launch\w*|debut\w*))\b/i;

const unent = s => String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&#8217;|&rsquo;/g, '’').replace(/&#8216;/g, '‘').replace(/&#8211;|&ndash;/g, '–').replace(/&#8212;|&mdash;/g, '—')
  .replace(/&#038;|&amp;/g, '&').replace(/&quot;|&#8220;|&#8221;/g, '"').replace(/&#039;|&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (x, n) => { const m = x.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`)); return m ? m[1] : ''; };
function parseFeed(xml) {
  return [...String(xml).matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/g)].map(m => {
    const x = m[0];
    const link = unent(tag(x, 'link')) || ((x.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '');
    const d = Date.parse(unent(tag(x, 'pubDate') || tag(x, 'published') || tag(x, 'updated') || tag(x, 'dc:date')));
    return { t: unent(tag(x, 'title')), u: link.trim(), d: isNaN(d) ? null : new Date(d).toISOString(), text: unent(tag(x, 'description') || tag(x, 'summary')).slice(0, 600), cats: [...x.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/g)].map(c => unent(c[1])).join(' ') };
  }).filter(i => i.t && /^https?:\/\//.test(i.u));
}
// Keep an item? Title about a TCG (or a card-game-only feed), not another hobby.
function keep(feed, it) {
  const head = it.t + ' ' + it.cats;
  if (NOT.test(it.t) || /\b(dies|obituary|passed away)\b/i.test(it.t)) return false;
  return feed.all || TCG.test(head) || (TCG.test(it.text) && /\bcard/i.test(it.t));
}
function itemOf(feed, it) {
  const all = it.t + ' ' + it.cats + ' ' + it.text;
  const g = GAMES.find(x => x[1].test(it.t)) || (feed.all ? null : GAMES.find(x => x[1].test(all)));
  return { t: it.t, u: it.u, d: it.d, src: feed.name, game: g ? g[0] : (feed.name === 'onepiece.gg' ? 'onepiece' : null), crowd: CROWD.test(all) ? 1 : 0, isNew: NEWGAME.test(it.t) ? 1 : 0 };
}
const keyOf = t => t.toLowerCase().replace(/\s*has been (updated|announced|released)\.?$/, '').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 3).slice(0, 8).join(' ');

async function runNews(env = {}) {
  const log = env.log || ((...a) => console.log(new Date().toISOString().slice(11, 19), 'news:', ...a));
  const fetchFn = env.fetch || fetch;
  const gh = env.gh || new GitHub({ repo: env.repo || process.env.GITHUB_REPOSITORY, token: env.token || process.env.GITHUB_TOKEN, fetch: fetchFn, log });
  const now = env.now || Date.now(), keepMs = 30 * 864e5;
  let prev = null; try { const b = await gh.download('prices', 'news.json'); prev = b ? JSON.parse(b) : null; } catch (_) {}
  if (!(env.force ?? process.env.RELEASES_FORCE) && prev && prev.v === NEWS_VERSION && now - Date.parse(prev.updated) < 6 * 3600000) { log('up to date'); return { skipped: true }; }
  const items = new Map(); // keep what we had (feeds only show their newest posts)
  for (const it of (prev && prev.v === NEWS_VERSION ? prev.items : [])) if (it.d && now - Date.parse(it.d) < keepMs) items.set(keyOf(it.t), it);
  const status = {};
  for (const f of FEEDS) {
    try {
      const r = await fetchFn(f.url, { headers: { 'user-agent': UA } });
      if (!r.ok) { status[f.name] = r.status; continue; }
      const list = parseFeed(await r.text()); let n = 0;
      for (const it of list) {
        if (!it.d || now - Date.parse(it.d) > keepMs || Date.parse(it.d) > now + 864e5 || !keep(f, it)) continue;
        const k = keyOf(it.t); if (!items.has(k)) { items.set(k, itemOf(f, it)); n++; }
      }
      status[f.name] = `${list.length} read, ${n} new`;
    } catch (e) { status[f.name] = e.message; }
    if (!env.fast) await sleep(200);
  }
  const out = { v: NEWS_VERSION, updated: new Date(now).toISOString(), items: [...items.values()].sort((a, b) => b.d.localeCompare(a.d)).slice(0, 150) };
  await gh.put('prices', 'news.json', Buffer.from(JSON.stringify(out)));
  log(`${out.items.length} items kept`, JSON.stringify(status));
  return { items: out.items.length, status };
}

module.exports = { runNews, parseFeed, keep, itemOf, FEEDS, NEWS_VERSION };
if (require.main === module) runNews().catch(e => { console.error(e); process.exit(1); });
