// Grading companies: every tier, price, wait and status, read once a day from each company's own price page.
// Several sites block automated readers, so each page is tried three ways: straight, through a text reader (r.jina.ai),
// and the newest copy on the Wayback Machine. A company that can't be read keeps what it showed last, with that date.
// Beckett and SGC block all of those, so for them hobby price-guide sites that print a dated copy of the price list are read too
// (only sites GitHub can open with no Cloudflare/Vercel challenge). The newest dated report is used only when a second source
// shows the same tiers and prices, and only a site that marks a tier sold out or open can change that tier's status.
// Output: prices/grading.json  { v, updated, companies: { PSA: { checked, tried, from, archived?, tiers: [[name, price, cover, wait, min, status]] } } }
const { GitHub } = require('./gh');
const SEED = require('./grading-seed.json');

const GRADING_VERSION = 2; // 2: Beckett and SGC also read from dated report sites
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

// ---- report sites for the companies whose own pages can't be read ----
const MONTHS = 'January February March April May June July August September October November December'.split(' ');
const isoDay = s => { const m = String(s).match(/([A-Z][a-z]+)\.? (\d{1,2}),? (\d{4})/); if (!m) return null; const i = MONTHS.findIndex(x => x.startsWith(m[1].slice(0, 3))); return i < 0 ? null : `${m[3]}-${String(i + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`; };
const wait = s => String(s).replace(/\s*(?:-|to)\s*/, '–') + ' business days';
const BGS_NAME = s => /no subgrades|no sub/i.test(s) ? 'Base' : /base/i.test(s) ? 'Base + sub-grades' : s;
const REPORTS = {
  SGC: [
    { by: 'TheLines', url: 'https://www.thelines.com/card-rips/grading/sgc/', read(text) {
      const t = flat(text), date = isoDay((t.match(/Last Updated on (\w+ \d+, \d{4})/) || [])[1]), out = [];
      const re = /(Standard|Expedited) \$([\d,]+)(\+?) (?:Up to )?\$([\d,]+) (\d+\+|\d+\s*-\s*\d+) business days/g; let m;
      while ((m = re.exec(t))) out.push([m[1], money(m[4]), m[3] ? 'over $' + m[2] : '$' + m[2], wait(m[5]), '', null]);
      return date && out.length >= 3 ? { date, tiers: out } : null;
    } },
    { by: 'AA Mint Store', url: 'https://www.aamintstore.com/sgc-grading-cost-and-how-to-submit-your-cards/', read(text) {
      const t = flat(text), date = isoDay((t.match(/prices SGC lists as of (\w+ \d+, \d{4})/) || [])[1]), out = [];
      const re = /(Standard|Expedited) \$([\d,]+) (over )?\$([\d,]+) (\d+\+|\d+ to \d+) business days/g; let m;
      while ((m = re.exec(t))) out.push([m[1], money(m[2]), (m[3] ? 'over ' : '') + '$' + m[4], wait(m[5]), '', null]);
      return date && out.length >= 3 ? { date, tiers: out } : null;
    } },
    { by: 'CardGrade', url: 'https://cardgrade.io/sgc-grading', read(text) {
      const t = flat(text), date = isoDay((t.match(/last verified (\w+ \d+, \d{4})/) || [])[1]), out = [];
      const re = /(Standard|Expedited) \$([\d,]+)\+? (?:per card|base fee) (\d+\+|\d+\s*[–-]\s*\d+) business days (?:\$([\d,]+) maximum declared value|More than \$([\d,]+))/g; let m;
      while ((m = re.exec(t))) out.push([m[1], money(m[2]), m[4] ? '$' + m[4] : 'over $' + m[5], wait(m[3]), '', null]);
      return date && out.length >= 3 ? { date, tiers: out } : null;
    } },
  ],
  BGS: [
    { by: 'CardGrading.app', url: 'https://cardgrading.app/beckett-grading-cost', read(text) {
      const t = flat(text), date = isoDay((t.match(/Availability as of (\w+ \d+, \d{4})/) || t.match(/As of (\w+ \d+, \d{4}), Beckett lists/) || [])[1]), out = [];
      const re = /(Base \(no subgrades\)|Base \(with subgrades\)|Standard|Express|Priority) (Sold out \([^)]*\) |Open \([^)]*\) )?\$([\d.]+) (\d+\+?) (?:Not included|Included)/g; let m;
      while ((m = re.exec(t)) && out.length < 5) out.push([BGS_NAME(m[1]), money(m[3]), '', wait(m[4]), '', !m[2] ? null : /sold/i.test(m[2]) ? 'sold' : 'open']);
      return date && out.length >= 3 ? { date, tiers: out } : null;
    } },
    { by: 'CardGrade', url: 'https://cardgrade.io/beckett-grading', read(text) {
      const t = flat(text), date = isoDay((t.match(/last verified (\w+ \d+, \d{4})/) || [])[1]), out = [], seen = new Set();
      const re = /(Base - No Subgrades|Base - With Subgrades|Standard|Express|Priority) \$([\d.]+) per card (\d+\+?) business days (.{0,90})/g; let m;
      while ((m = re.exec(t))) {
        const name = BGS_NAME(m[1]); if (seen.has(name)) continue; seen.add(name);
        out.push([name, money(m[2]), '', wait(m[3]), '', /paused|sold out/i.test(m[4]) ? 'sold' : /^Open\b/.test(m[4]) ? 'open' : null]);
      }
      return date && out.length >= 3 ? { date, tiers: out } : null;
    } },
    // shows Beckett's prices but never marks a Beckett tier paused, so it only ever confirms prices
    { by: 'TCGrader', url: 'https://www.tcgrader.com/card-grading-costs', confirmOnly: true, read(text) {
      const t = flat(text), i = t.indexOf('Beckett (BGS) grading cost'), out = [];
      if (i < 0) return null;
      const re = /(Base with Subgrades|Base|Standard|Express|Priority) \$([\d.]+) ~/g; re.lastIndex = i; let m;
      while ((m = re.exec(t)) && out.length < 5) out.push([m[1] === 'Base with Subgrades' ? 'Base + sub-grades' : m[1], money(m[2]), '', '', '', null]);
      return out.length >= 3 ? { date: isoDay((t.match(/updated (\d{1,2}) (\w+) (\d{4})/) || []).slice(1).reverse().join(' ').replace(/^(\d{4}) (\w+) (\d+)$/, '$2 $3, $1')), tiers: out } : null;
    } },
  ],
};

// Same tiers at the same prices (status, wording and waits aside)?
const num = p => (String(p).replace(/,/g, '').match(/\d+(?:\.\d+)?/) || [''])[0];
const sig = tiers => tiers.filter(t => t[5] !== 'paused').map(t => t[0] + '|' + num(t[1])).sort().join(';');
const agree = (a, b) => !!a && !!b && sig(a) === sig(b);

// Newest dated report that a second source (another report, or what we already show) agrees with.
async function readReports(code, fetchFn, old, log) {
  const got = [];
  for (const r of REPORTS[code] || []) {
    let text = null;
    try { const res = await fetchFn(r.url, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(40000) }); text = res.ok ? await res.text() : null; } catch (_) {}
    const rep = text && r.read(text);
    log(`${code}: ${r.by} ${rep ? rep.tiers.length + ' tiers, ' + (rep.date || 'no date') : 'unreadable'}`);
    if (rep) got.push(Object.assign({ by: r.by, url: r.url, confirmOnly: !!r.confirmOnly }, rep));
  }
  const oldTiers = old && old.tiers;
  const picks = got.filter(r => !r.confirmOnly && r.date).sort((a, b) => b.date.localeCompare(a.date));
  for (const p of picks) {
    if (got.some(r => r !== p && agree(r.tiers, p.tiers)) || agree(oldTiers, p.tiers)) return p;
    log(`${code}: ${p.by} (${p.date}) not confirmed by a second source`);
  }
  return null;
}

// A report's tiers in our wording: a tier we already show keeps its text; status comes from the report only where it marks one.
function fromReport(rep, oldTiers) {
  const pool = (oldTiers || []).slice();
  return rep.tiers.map(t => {
    const i = pool.findIndex(o => o[0] === t[0] && num(o[1]) === num(t[1]));
    const o = i >= 0 ? pool.splice(i, 1)[0] : null;
    const row = o ? o.slice() : t.slice();
    row[5] = t[5] || (o && o[5] !== 'paused' ? o[5] : 'open');
    return row;
  });
}

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
  if (!prev || !prev.updated || (prev.v || 1) < GRADING_VERSION) return true; // a new reader runs at once
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
    const oldAt = old.checked ? Date.parse(old.checked) : 0;
    const got = await readCompany(code, env.readFetch || fetchFn, log);
    if (got && got.from === 'site') { companies[code] = { checked: iso, tried: iso, from: 'site', tiers: mergeTiers(got.tiers, old.tiers) }; continue; }
    // no live read: take the newest of an archive copy and a confirmed report, if it is newer than what we already show
    let best = null;
    if (got && Date.parse(got.archived) > oldAt) best = { checked: got.archived, from: 'archive', archived: got.archived, tiers: mergeTiers(got.tiers, old.tiers) };
    const rep = REPORTS[code] ? await readReports(code, env.readFetch || fetchFn, old, log) : null;
    const repAt = rep ? `${rep.date}T12:00:00Z` : null;
    if (rep && Date.parse(repAt) > oldAt && (!best || Date.parse(repAt) > Date.parse(best.checked))) best = { checked: repAt, from: 'report', by: rep.by, byUrl: rep.url, tiers: mergeTiers(fromReport(rep, old.tiers), old.tiers) };
    companies[code] = best ? Object.assign({ tried: iso }, best) : Object.assign({}, old, { tried: iso });
  }
  const out = { v: GRADING_VERSION, updated: iso, companies };
  await gh.put('prices', 'grading.json', Buffer.from(JSON.stringify(out)));
  return out;
}

module.exports = { runGrading, READ, REPORTS, readReports, fromReport, agree, isoDay, mergeTiers, due, flat, PAGES, ORDER, GRADING_VERSION };
if (require.main === module) runGrading({ force: process.argv.includes('--force') }).catch(e => { console.error(e); process.exit(1); });
