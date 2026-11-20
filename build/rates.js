// Exchange rates for Minty's currency setting (prices/rates.json.gz): the European Central Bank's daily reference
// rates – official, free, about 30 currencies – from 2010 on, so each day's price can be shown in another currency at
// that day's rate. Runs every hour; does work only when the bank has published a new day (working days, ~16:00 CET).
'use strict';
const zlib = require('zlib'), fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const { GitHub } = require('./gh');

const DAILY = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const HIST = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.zip';
const FROM = '2010-01-01';
// The currencies Minty offers (the bank's current list; EUR is the base).
const CUR = ['USD', 'JPY', 'CZK', 'DKK', 'GBP', 'HUF', 'PLN', 'RON', 'SEK', 'CHF', 'ISK', 'NOK', 'TRY', 'AUD', 'BRL', 'CAD', 'CNY', 'HKD', 'IDR', 'ILS', 'INR', 'KRW', 'MXN', 'MYR', 'NZD', 'PHP', 'SGD', 'THB', 'ZAR'];

// The bank's history file (CSV, newest day first, "N/A" where a currency had no rate) → oldest-first columns.
function parseHist(csv, from = FROM) {
  const lines = String(csv).trim().split(/\r?\n/);
  const head = lines[0].split(',').map(s => s.trim());
  const col = {}; head.forEach((h, i) => { col[h] = i; });
  const rows = lines.slice(1).map(l => l.split(',')).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r[0]) && r[0] >= from).sort((a, b) => a[0].localeCompare(b[0]));
  const out = { base: 'EUR', src: 'European Central Bank', dates: rows.map(r => r[0]), rates: {} };
  for (const c of CUR) { if (col[c] === undefined) continue; out.rates[c] = rows.map(r => { const v = parseFloat(r[col[c]]); return isFinite(v) && v > 0 ? v : null; }); }
  out.updated = out.dates[out.dates.length - 1] || null;
  return out;
}
const dailyDate = xml => (String(xml).match(/time=['"](\d{4}-\d{2}-\d{2})['"]/) || [])[1] || null;

async function main(env = {}) {
  const log = env.log || ((...a) => console.log(...a));
  const fetchFn = env.fetch || fetch;
  const gh = env.gh || new GitHub({ repo: env.repo || process.env.GITHUB_REPOSITORY, token: env.token || process.env.GITHUB_TOKEN, fetch: fetchFn, log });
  let have = null;
  try { const b = await gh.download('prices', 'rates.json.gz'); if (b) have = JSON.parse(zlib.gunzipSync(b)); } catch (e) { log('Rates: could not read the last copy –', e.message); }
  const day = dailyDate(await (await fetchFn(DAILY)).text());
  if (!day) { log('Rates: the bank\'s daily file has no date – nothing done.'); return { changed: false }; }
  if (have && have.updated >= day) { log('Rates: already have', day); return { changed: false }; }
  const zip = Buffer.from(await (await fetchFn(HIST)).arrayBuffer());
  const tmp = path.join(os.tmpdir(), 'ecb-hist.zip'); fs.writeFileSync(tmp, zip);
  const csv = env.unzip ? env.unzip(zip) : execFileSync('7z', ['x', '-so', tmp], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  const out = parseHist(csv);
  if (!out.updated || !out.rates.USD || out.dates.length < 1000) throw new Error('Rates: the history file looks wrong (' + out.dates.length + ' days)');
  out.checked = new Date().toISOString();
  await gh.put('prices', 'rates.json.gz', zlib.gzipSync(Buffer.from(JSON.stringify(out)), { level: 9 }));
  log(`Rates: ${out.dates.length} days to ${out.updated}, ${Object.keys(out.rates).length} currencies.`);
  return { changed: true, updated: out.updated };
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { parseHist, dailyDate, main, CUR };
