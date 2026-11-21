// The makers' own product lists: release dates and what is inside, straight from the companies that make the games.
// Read by the Releases step. The maker's date wins over TCGplayer's; the maker's contents fill products TCGplayer has no
// text for; a product the maker has announced and TCGplayer does not list yet is added on its own.
// Only makers whose sites allow it: no robots.txt rules against reading, no terms against bots, plain pages (checked 21 Nov 2026).
//   Bandai: One Piece, Digimon, Dragon Ball Super Fusion World, Union Arena, Gundam.   Konami: Yu-Gi-Oh!
// Left out: Wizards (Magic) and Riot (Riftbound) – their terms forbid robots and scraping; Pokémon – no dated product
// list on its site (news tiles only); WeirdCo (Cyberpunk) – no products with dates on its site.
const { sleep } = require('./gh');

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';
const DATE = new RegExp(`((?:${MONTHS})\\.?\\s+\\d{1,2},\\s*20\\d\\d|\\d{1,2}/\\d{1,2}/20\\d\\d|20\\d\\d-\\d\\d-\\d\\d)`, 'i');
const pad = n => String(n).padStart(2, '0');
// "December 18, 2026", "12/18/2026" or "2026-12-18" → "2026-12-18"
function isoDay(s) {
  s = String(s || '').trim();
  let m = s.match(/^(20\d\d)-(\d\d)-(\d\d)$/); if (m) return s;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(20\d\d)$/); if (m) return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
  m = s.match(new RegExp(`^(${MONTHS})\\.?\\s+(\\d{1,2}),\\s*(20\\d\\d)$`, 'i'));
  if (m) return `${m[3]}-${pad(MONTHS.split('|').indexOf(m[1].toLowerCase()) + 1)}-${pad(m[2])}`;
  return null;
}
const ent = t => String(t).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&rsquo;|&#8217;/g, '’').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
// page text, one line per block
function textOf(html) {
  return ent(String(html).replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|dd|dt|h\d|div|tr|section|article)>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .split('\n').map(l => l.replace(/[ \t　]+/g, ' ').trim()).filter(Boolean).join('\n');
}
// the release day in a product's text: "Release Date …", never the pre-release day; else (no label) the first date
function releaseOf(text) {
  const t = String(text).replace(/\n/g, ' ');
  const re = new RegExp(`(pre-?\\s*)?release(?:\\s+date)?\\s*:?\\s*${DATE.source}`, 'ig');
  let m; while ((m = re.exec(t))) if (!m[1]) return isoDay(m[2]);
  if (/release/i.test(t) && !/pre-?\s*release/i.test(t)) return null; // a release line with a month only ("June 2027"): no day
  const f = t.match(DATE); return f && !/pre-?\s*release/i.test(t) ? isoDay(f[1]) : null;
}
const abs = (base, u) => { try { return u ? new URL(ent(u), base).href : ''; } catch (_) { return ''; } };
const codeOf = t => { const m = String(t).match(/\[([A-Z]{1,6}-?\d{1,3}[A-Z]{0,3})\]/i); return m ? m[1].toUpperCase() : ''; };
// Title Case for the makers' ALL-CAPS names; names already in mixed case are kept
const tidy = t => { t = String(t).replace(/\s+/g, ' ').trim(); return t === t.toUpperCase() ? t.toLowerCase().replace(/(^|[\s\-–(/"“])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(Of|The|And|In|On|To|A|An|For|Vs)\b/g, (w, _a, i) => i ? w.toLowerCase() : w).replace(/\b(x|[ivx]{2,5})\b/gi, w => /^[ivx]+$/i.test(w) && (w.length > 1 || w === 'x' || w === 'X') ? w.toUpperCase() : w) : t; };

// one product list: split into blocks, read each block. sel: block start, title, picture, link
function readList(html, base, sel) {
  const out = [], parts = String(html).split(sel.block).slice(1);
  for (const b of parts) {
    const tm = b.match(sel.title); if (!tm) continue;
    const title = textOf(tm[1]).replace(/\n/g, ' ').trim(); if (!title) continue;
    const lm = sel.link ? b.match(sel.link) : null, im = b.match(/data-src="([^"]+)"/) || b.match(/<img[^>]+src="([^"]+)"/);
    const img = im && !/noimage|thumbnail_sq|spacer|blank/i.test(im[1]) ? abs(base, im[1]) : '';
    const dt = b.match(/datetime="(20\d\d-\d\d-\d\d)"/);
    out.push({ title, code: codeOf(title) || (sel.slugCode && lm ? (lm[1].match(sel.slugCode) || [])[1] || '' : '').toUpperCase(), date: dt ? dt[1] : releaseOf(textOf(sel.dateIn ? (b.match(sel.dateIn) || [b])[0] : b)), url: lm ? abs(base, lm[1]) : '', img });
  }
  return out;
}

// what's inside a product, from its own page: the lines under "Contents" / "Configuration", as the maker wrote them
const STOP = /^(contents open|point\s*\d*$|rarity|msrp|release|pre-?release|related|back|features|view|learn|explore|card list|\*|※|price|available|product details|what is|what's next)/i;
function contentsOf(html) {
  const lines = textOf(html).split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^(product\s+)?(contents?|configuration)$/i.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length && out.length < 6; j++) {
      const l = lines[j].replace(/^[・･•·\-*]\s*/, '').trim();
      if (!l || STOP.test(lines[j]) || /^(product\s+)?(contents?|configuration)$/i.test(l)) break;
      for (const part of (l.length > 90 && l.includes(', ') ? l.split(/,\s+/) : [l])) if (out.length < 6 && !out.includes(part)) out.push(part.length > 90 ? part.slice(0, 89).replace(/\s+\S*$/, '') + '…' : part);
    }
  }
  return out;
}

// cat = TCGplayer category. pages: the product lists to read (newest first). sel: how a list is laid out.
const MAKERS = [
  { cat: 68, maker: 'Bandai', game: 'One Piece', pages: ['https://en.onepiece-cardgame.com/products/', 'https://en.onepiece-cardgame.com/products/?page=2'],
    sel: { block: /<li class="linkListColBox"/, title: /class="linkListColTitle">([\s\S]*?)<\/h4>/, link: /<a href="([^"]+)"/ } },
  { cat: 63, maker: 'Bandai', game: 'Digimon', pages: ['https://world.digimoncard.com/products/'],
    sel: { block: /<article class="genrecol-/, title: /class="prodname">([\s\S]*?)<\/h4>/, link: /data-url="([^"]+)"/ } },
  { cat: 80, maker: 'Bandai', game: 'Dragon Ball Super Fusion World', pages: ['https://www.dbs-cardgame.com/fw/en/products/'],
    sel: { block: /<li class="prpductListItem/, title: /class="cardText">([\s\S]*?)<\/h3>/, link: /<a href="([^"]+)"/ } },
  { cat: 81, maker: 'Bandai', game: 'Union Arena', pages: ['https://www.unionarena-tcg.com/na/products/'],
    sel: { block: /<li class="productsDetail/, title: /class="js_productsTit">([\s\S]*?)<\/span>/, link: /<a href="([^"]+)"/ } },
  { cat: 86, maker: 'Bandai', game: 'Gundam', pages: ['https://www.gundam-gcg.com/en/products/'],
    sel: { block: /<div class="swiper-slide">\s*<div class="(?:boosterMvCol|mvBox)/, title: /class="title">([\s\S]*?)<\/h2>/, link: /href="((?:\.\.\/products\/)?[a-z0-9_-]+\.html)" class="btn"/, number: true } },
  { cat: 2, maker: 'Konami', game: 'Yu-Gi-Oh!', pages: ['https://www.yugioh-card.com/en/products/booster-pack/', 'https://www.yugioh-card.com/en/products/structure-deck/', 'https://www.yugioh-card.com/en/products/tins/', 'https://www.yugioh-card.com/en/products/others/'],
    sel: { block: /<section class="detail clear">/, title: /<h3>([\s\S]*?)<\/h3>/, link: /class="btn" href="([^"]+)"/, slugCode: /\/products\/([a-z0-9-]+)\/?$/i } },
];
// Gundam's list puts the code in its own line ("[GD06]") above the title
function fixGundam(html, base, sel) {
  return String(html).split(sel.block).slice(1).map(b => {
    const tm = b.match(sel.title), nm = b.match(/class="number">\s*\[([^\]]+)\]/), lm = b.match(sel.link), dm = b.match(/class="date">([^<]+)</), im = b.match(/<img src="([^"]+)"/);
    if (!tm) return null;
    return { title: textOf(tm[1]).replace(/\n/g, ' ') + (nm ? ` [${nm[1]}]` : ''), code: nm ? nm[1].toUpperCase() : '', date: dm ? isoDay(dm[1]) : null, url: lm ? abs(base, lm[1]) : '', img: im ? abs(base, im[1]) : '' };
  }).filter(Boolean);
}

// Not a release to show on its own: accessories, web-shop exclusives, reprint collections
const SKIP = /sleeve|playmat|play mat|card case|binder|deck case|storage|dice|premium bandai|loader|\bmat\b|card set -|anniversary set/i;
const kindOf = t => /\b(starter|structure|deck|ultra deck|advanced deck)\b/i.test(t) ? 'deck' : /\btin\b/i.test(t) ? 'tin' : /\b(booster|pack|display|box)\b/i.test(t) ? 'pack' : 'other';

// Read every maker's list (and the pages of products inside the window, for their contents).
async function readMakers({ fetchFn = fetch, ua, log = () => {}, fast = false, today, ahead = 100, back = 14 } = {}) {
  const t = Date.parse(today.slice(0, 10) + 'T00:00:00Z'), out = [];
  const get = async u => { const r = await fetchFn(u, { headers: { 'user-agent': ua, accept: 'text/html' } }); if (!r.ok) throw new Error(u + ' ' + r.status); return r.text(); };
  for (const m of MAKERS) {
    const seen = new Set(); let n = 0;
    for (const page of m.pages) {
      try {
        const html = await get(page);
        const list = m.sel.number ? fixGundam(html, page, m.sel) : readList(html, page, m.sel);
        for (const p of list) {
          const key = p.code || p.url || p.title; if (seen.has(key)) continue; seen.add(key);
          const d = p.date ? (Date.parse(p.date + 'T00:00:00Z') - t) / 864e5 : null;
          if (d === null || d > ahead || d < -back) continue; // undated or outside the window
          out.push(Object.assign({ cat: m.cat, maker: m.maker, kind: kindOf(p.title), inc: [] }, p)); n++;
        }
      } catch (e) { log(m.game, e.message); }
      if (!fast) await sleep(1500);
    }
    log(`${m.game}: ${n} products in the window`);
  }
  for (const p of out) { // what is inside: from the product's own page
    if (!p.url || SKIP.test(p.title)) continue;
    try { const h = await get(p.url); p.inc = contentsOf(h); if (!p.code) { const tm = h.match(/<title>([^<]*)<\/title>/i); p.code = tm ? codeOf(ent(tm[1])) : ''; } } // Union Arena gives its code on the product page only
    catch (e) { log(p.title, e.message); }
    if (!fast) await sleep(1500);
  }
  return out;
}

// ---- matching a maker's product to a TCGplayer set ----
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const GENERIC = new Set(['starter', 'deck', 'decks', 'booster', 'boosters', 'pack', 'packs', 'box', 'display', 'set', 'extra', 'special', 'premium', 'the', 'and', 'of', 'vol', 'release', 'event', 'cards', 'card', 'game', 'digimon', 'union', 'arena', 'one', 'piece', 'dragon', 'ball', 'super', 'fusion', 'world', 'gundam', 'yu', 'gi', 'oh', 'trading', 'tcg', 'structure', 'tin', 'theme', 'story', 'manga', 'advanced', 'ultra', 'retail', 'collection']);
const words = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 2 && !GENERIC.has(w) && !/^\d+$/.test(w));
// the maker's products for one TCGplayer set: same code, or (no code match) every distinctive word of the set's name in the
// maker's title and the dates within 60 days of each other
function makerFor(r, list) {
  const same = list.filter(p => p.cat === r.cat);
  const byCode = r.abbr ? same.filter(p => p.code && norm(p.code) === norm(r.abbr)) : [];
  if (byCode.length) return byCode;
  const w = words(String(r.set).replace(/^[A-Za-z]{1,6}\d{0,3}[A-Za-z]{0,3}:\s*/, ''));
  if (!w.length) return [];
  return same.filter(p => { const tw = new Set(words(p.title)); return w.every(x => tw.has(x)) && (!p.date || !r.date || Math.abs(Date.parse(p.date) - Date.parse(r.date)) <= 60 * 864e5); });
}
const PKIND = { box: 'pack', half: 'pack', pack: 'pack', bundle: 'pack', deck: 'deck', side: 'deck', kit: 'deck', etb: 'pack', other: 'other' };
const prodKind = name => /\b(starter|structure|deck)\b/i.test(name) ? 'deck' : /\btin\b/i.test(name) ? 'tin' : /\b(booster|pack|display|box|bundle)\b/i.test(name) ? 'pack' : 'other';

// Put the makers' facts into the Releases sets. Returns the sets the maker has and TCGplayer doesn't list yet.
function mergeMakers(sets, list, games = {}) {
  const used = new Set();
  for (const r of sets) {
    const mk = makerFor(r, list); if (!mk.length) continue;
    mk.forEach(p => used.add(p));
    const want = /\b(starter|structure|deck)\b/i.test(r.set + ' ' + (r.items || []).map(i => i.name).join(' ')) && !/\bbooster\b/i.test(r.set) ? 'deck' : 'pack';
    const main = mk.find(p => !SKIP.test(p.title) && p.date && p.kind === want) || mk.find(p => !SKIP.test(p.title) && p.date) || mk.find(p => p.date);
    if (main) { if (main.date !== r.date) { r.tcgDate = r.date; r.date = main.date; } r.maker = { name: main.maker, u: main.url }; r.mk = 'm-' + (main.code || norm(main.title).slice(0, 24)); }
    const info = r.info; if (!info || !info.products) continue;
    for (const p of info.products) {
      const k = prodKind(p.name), from = mk.find(x => x.inc.length && x.kind === k) || (k === 'pack' ? null : null);
      if ((!p.inc || !p.inc.length) && from) p.inc = from.inc.slice(); // the maker's contents where TCGplayer gives none
      if (!p.img) { const pic = mk.find(x => x.img && x.kind === k) || mk.find(x => x.img); if (pic) p.img = pic.img; }
    }
  }
  // announced by the maker, not on TCGplayer yet: a set of its own (no price yet – prices come only from the market)
  const extra = [], byKey = new Map();
  for (const p of list) {
    if (used.has(p) || SKIP.test(p.title) || !p.date) continue;
    const bare = p.title.replace(/\[[^\]]*\]/g, '').replace(/^(digimon card game|union arena|dragon ball super card game( fusion world)?)\s*/i, '').trim();
    const inner = (bare.match(/\s-\s*([^-]+?)\s*-\s*$|-([^-]+)-\s*$/) || []).slice(1).find(Boolean);
    const name = tidy(bare.replace(/\s*-\s*([^-]+?)\s*-\s*$/, ' $1')).replace(/\s+/g, ' ').trim().replace(/^(premium extra booster|special booster pack|starter deck ex|starter deck|booster pack|extra booster|structure deck)\b/i, w => tidy(w.toUpperCase())); // "STARTER DECK -Baroque Works-" → "Starter Deck Baroque Works"
    const set = (inner ? tidy(inner.trim()) : name.replace(/^(special booster pack|booster pack|starter deck( ex)?|extra booster|premium booster|digimon alysion)\s*/i, '').trim()) || name;
    const g = 'm-' + (p.code || norm(p.title).slice(0, 24)), key = p.cat + '|' + g;
    if (byKey.has(key)) continue;
    const r = { cat: p.cat, set, g, mk: g, date: p.date, maker: { name: p.maker, u: p.url }, game: games[p.cat] || null,
      items: [{ id: null, name, price: null, k: p.kind === 'deck' ? 'deck' : 'box' }],
      info: { about: '', size: null, revealed: 0, products: [{ id: null, name, price: null, img: p.img || '', inc: p.inc.slice() }], cards: [] } };
    byKey.set(key, r); extra.push(r);
  }
  return extra;
}

module.exports = { readMakers, mergeMakers, makerFor, readList, fixGundam, contentsOf, releaseOf, isoDay, textOf, tidy, MAKERS };
