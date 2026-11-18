// Grading companies: every tier, price, wait and status, read once a day from each company's own price page.
// Several sites block automated readers, so each page is tried three ways: straight, through a text reader (r.jina.ai),
// and the newest copy on the Wayback Machine. A company that can't be read keeps what it showed last, with that date.
// Output: prices/grading.json  { v, updated, companies: { PSA: { checked, tried, from, archived?, tiers: [[name, price, cover, wait, min, status]] } } }
const { GitHub } = require('./gh');
const SEED = require('./grading-seed.json');

const GRADING_VERSION = 1;
const ORDER = ['PSA', 'CGC', 'BGS', 'SGC', 'TAG'];
const PAGES = {
  PSA: 'https://www.psacard.com/services/tradingcardgrading',
  CGC: 'https://www.cgccards.com/submit/services-fees/cgc-grading/',
  BGS: 'https://www.beckett.com/grading',
  SGC: 'https://gosgc.com/card-grading/services-pricing',
  TAG: 'https://taggrading.com/pages/pricing',
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const flat = s => String(s).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#36;|&dollar;/g, '$').replace(/&ndash;/g, '–').replace(/\s+/g, ' ').trim();
const money = s => { s = String(s).replace(/\.00(?=\D|$)/, ''); return s.startsWith('$') ? s : '$' + s; };
const days = (n, word) => n.replace(/\s*-\s*/, '–') + ' ' + word;

// ---- one reader per company: page text -> tiers (null when the page didn't look like a price list)
const READ = {
  PSA(text) {
    const t = flat(text), out = [];
    const re = /(Value Bulk|Value Plus|Value Max|Value|Standard|Priority|Super Express|Express|Premier|Premium \d+)\s*#*\s*\$([\d,.]+\+?)\s*\/\s*Card\s*Max Insured Value:\s*(.+?)\s*Estimated Turnaround Time:\s*([\d\s–-]+?)\s*Business Days/gi;
    let m;
    while ((m = re.exec(t))) {
      const cover = m[3].replace(/\s*or less/i, '').replace(/^\$([\d,]+) or higher.*$/i, 'over $$$1').replace(/†.*/, '').trim();
      out.push([m[1], money(m[2]), cover.replace(/^over \$250,001$/, 'over $250,000'), days(m[4].trim(), 'business days'), '', 'open']);
    }
    return out.length >= 3 ? out : null;
  },
  TAG(text) {
    const t = flat(text), out = [];
    const re = /(?:(\d+) card min\s+)?(?:Most popular\s+|Full service\s+)?(Value|Base|Standard|Priority|Express|Premier)\s+\$([\d,.]+)\s*\/\s*card(.*?)est\.\s*([\d–-]+)\s*biz days.*?up to\s+(?:\$10k avail\.\s+)?\$([\d,]+k?)/gi;
    let m;
    while ((m = re.exec(t))) out.push([m[2], money(m[3]), '$' + m[6], days(m[5], 'business days'), m[1] ? m[1] + ' cards' : '', /sold out|unavailable|paused/i.test(m[4]) ? 'sold' : 'open']);
    return out.length >= 3 ? out : null;
  },
  BGS(text) {
    const t = flat(text), out = [];
    const re = /(?:(Base|Standard|Express|Priority)\s+(\d+\+?)\s*business days\s+)?\$\s*([\d,.]+)\s*per card\s+(Sold Out|Submit Now|Notify me)?\s*(Without Subgrades|Subgrades)/gi;
    let m, name = '', wait = '';
    while ((m = re.exec(t))) {
      if (m[1]) { name = m[1]; wait = m[2] + ' business days'; }
      if (!name) continue;
      const label = name === 'Base' ? (/without/i.test(m[5]) ? 'Base' : 'Base + sub-grades') : name;
      out.push([label, money(m[3]), '', wait, label === 'Base' ? 'No sub-grades' : '', /sold out/i.test(m[4] || '') ? 'sold' : 'open']);
    }
    return out.length >= 3 ? out : null;
  },
  CGC(text) {
    const t = flat(text), out = [];
    const re = /(Bulk|Economy|Standard|Express|WalkThrough|Unlimited Value)\b(.{0,260}?)Max\. Value per Card \(USD\)\s*(\$[\d,]+|Unlimited)\s*Fee Per Card \(USD\)\s*\$([\d,.]+(?:\s*\+\s*1%\s*FMV)?)\s*Current Turnaround \(working days\)\s*(\d+)\s*days/gi;
    let m;
    while ((m = re.exec(t))) {
      const min = (m[2].match(/(\d+)-card minimum/i) || [])[1];
      out.push([m[1].replace(/ Value$/, ''), money(m[4]).replace(/\s*\+\s*1%\s*FMV$/i, ' + 1% of value'), /unlimited/i.test(m[3]) ? 'any value' : m[3], m[5] + ' working days', min ? min + ' cards' : '', 'open']);
    }
    return out.length >= 3 ? out : null;
  },
  SGC(text) {
    const t = flat(text), out = [];
    const re = /(Standard|Expedited)\s+\$([\d,]+)\s+(?:up to\s+)?\$([\d,]+)\s+([\d–+-]+)\s*business days/gi;
    let m;
    while ((m = re.exec(t))) out.push([m[1], money(m[2]), '$' + m[3], days(m[4], 'business days'), '', 'open']);
    return out.length >= 3 ? out : null;
  },
};

// Tiers the page no longer lists stay in the list as "not offered now", with the last price seen.
function mergeTiers(fresh, old) {
  const key = t => t[0] + '|' + t[1];
  const seen = new Set(fresh.map(t => t[0]));
  const kept = (old || []).filter(t => !seen.has(t[0])).map(t => { const c = t.slice(); c[5] = 'paused'; return c; });
  if (!kept.length) return fresh;
  // put each dropped tier back next to its old neighbour so the order still reads cheapest to fastest
  const out = fresh.slice();
  for (const t of kept) {
    const i = (old || []).findIndex(x => key(x) === key(t));
    const before = i > 0 ? old[i - 1][0] : null;
    const at = before ? out.findIndex(x => x[0] === before) + 1 : 0;
    out.splice(at > 0 ? at : 0, 0, t);
  }
  return out;
}

async function getText(fetchFn, url, way) {
  try {
    if (way === 'site') {
      const r = await fetchFn(url, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(40000) });
      return r.ok ? { text: await r.text() } : null;
    }
    if (way === 'reader') {
      const r = await fetchFn('https://r.jina.ai/' + url, { headers: { accept: 'text/plain' }, signal: AbortSignal.timeout(60000) });
      return r.ok ? { text: await r.text() } : null;
    }
    const a = await fetchFn('https://archive.org/wayback/available?url=' + encodeURIComponent(url), { signal: AbortSignal.timeout(40000) });
    const snap = a.ok ? ((await a.json()).archived_snapshots || {}).closest : null;
    if (!snap || !snap.url) return null;
    const r = await fetchFn(snap.url.replace(/^http:/, 'https:').replace(/\/web\/(\d+)\//, '/web/$1id_/'), { signal: AbortSignal.timeout(60000) });
    const ts = snap.timestamp;
    return r.ok ? { text: await r.text(), archived: `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10)}:${ts.slice(10, 12)}:00Z` } : null;
  } catch (_) { return null; }
}

async function readCompany(code, fetchFn, log) {
  for (const way of ['site', 'reader', 'archive']) {
    const got = await getText(fetchFn, PAGES[code], way);
    if (!got) continue;
    const tiers = READ[code](got.text);
    if (tiers) { log(`${code}: ${tiers.length} tiers (${way})`); return { tiers, from: way === 'archive' ? 'archive' : 'site', archived: got.archived }; }
  }
  log(`${code}: could not read the price page`);
  return null;
}

// Once per Eastern day, from 6 AM on.
function due(prev, now) {
  if (!prev || !prev.updated) return true;
  const et = d => new Date(new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const n = et(now), p = et(prev.updated);
  if (n.getHours() < 6) return false;
  return n.toDateString() !== p.toDateString() || p.getHours() < 6;
}

async function runGrading(env = {}) {
  const log = env.log || ((...a) => console.log(new Date().toISOString().slice(11, 19), 'grading:', ...a));
  const fetchFn = env.fetch || fetch;
  const gh = env.gh || new GitHub({ repo: env.repo || process.env.GITHUB_REPOSITORY, token: env.token || process.env.GITHUB_TOKEN, fetch: fetchFn, log });
  const now = env.now || Date.now();
  const buf = await gh.download('prices', 'grading.json');
  let prev = null; try { prev = buf ? JSON.parse(buf) : null; } catch (_) {}
  if (!env.force && !due(prev, now)) { log('already checked today'); return { skipped: true }; }
  const iso = new Date(now).toISOString();
  const companies = {};
  for (const code of ORDER) {
    const old = (prev && prev.companies && prev.companies[code]) || SEED.companies[code];
    const got = await readCompany(code, env.readFetch || fetchFn, log);
    if (got) {
      // an archive copy older than what we already have doesn't replace it
      if (got.from === 'archive' && old.checked && Date.parse(got.archived) <= Date.parse(old.checked)) { companies[code] = Object.assign({}, old, { tried: iso }); continue; }
      companies[code] = { checked: got.from === 'archive' ? got.archived : iso, tried: iso, from: got.from, archived: got.archived || undefined, tiers: mergeTiers(got.tiers, old.tiers) };
    } else companies[code] = Object.assign({}, old, { tried: iso });
  }
  const out = { v: GRADING_VERSION, updated: iso, companies };
  await gh.put('prices', 'grading.json', Buffer.from(JSON.stringify(out)));
  return out;
}

module.exports = { runGrading, READ, mergeTiers, due, flat, PAGES, ORDER, GRADING_VERSION };
if (require.main === module) runGrading({ force: process.argv.includes('--force') }).catch(e => { console.error(e); process.exit(1); });
