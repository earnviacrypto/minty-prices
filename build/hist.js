// Price history of one TCGplayer category: for every product and printing ("productId|subType"), the TCGplayer
// market price of each day, in cents (0 = no price that day). Days are counted from the first archive day.
const zlib = require('zlib');

const DAY = 86400000;
const dayIndex = (start, date) => Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / DAY);
const dateOf = (start, i) => new Date(Date.parse(start + 'T00:00:00Z') + i * DAY).toISOString().slice(0, 10);

class Hist {
  constructor(start) { this.start = start; this.series = new Map(); this.changed = false; }
  // s = { g: groupId, base: first day stored, a: Uint32Array (a[i] = day base + i) }
  set(key, g, day, cents) {
    if (!(cents > 0) || day < 0) return;
    let s = this.series.get(key);
    if (!s) { s = { g, base: day, a: new Uint32Array(32) }; this.series.set(key, s); }
    if (g) s.g = g;
    if (day < s.base) { // an earlier day (the archive filled in after the daily pulls began)
      const n = new Uint32Array(s.a.length + (s.base - day));
      n.set(s.a, s.base - day); s.a = n; s.base = day;
    }
    const i = day - s.base;
    if (i >= s.a.length) { const n = new Uint32Array(Math.max(i + 1, s.a.length * 2)); n.set(s.a); s.a = n; }
    if (s.a[i] !== cents) { s.a[i] = cents; this.changed = true; }
  }
  get(key, day) { const s = this.series.get(key); if (!s) return 0; const i = day - s.base; return i >= 0 && i < s.a.length ? s.a[i] : 0; }
  // last day with a value + 1 (trailing empty days are not stored)
  static used(s) { let n = s.a.length; while (n > 0 && !s.a[n - 1]) n--; return n; }
  days() { let m = 0; for (const s of this.series.values()) m = Math.max(m, s.base + Hist.used(s)); return m; }

  // Stored form: gzip( 4-byte header length + header JSON + all values as little-endian uint32 )
  encode() {
    const keys = [], parts = [];
    let total = 0;
    for (const [k, s] of this.series) {
      const n = Hist.used(s);
      if (!n) continue;
      keys.push([k, s.g, s.base, n]); parts.push(s.a.subarray(0, n)); total += n;
    }
    const head = Buffer.from(JSON.stringify({ v: 1, start: this.start, keys }));
    const body = Buffer.alloc(4 + head.length + total * 4);
    body.writeUInt32LE(head.length, 0); head.copy(body, 4);
    let o = 4 + head.length;
    for (const p of parts) { Buffer.from(p.buffer, p.byteOffset, p.byteLength).copy(body, o); o += p.byteLength; }
    return zlib.gzipSync(body, { level: 6 });
  }
  static decode(buf, start) {
    const body = zlib.gunzipSync(buf);
    const hl = body.readUInt32LE(0);
    const head = JSON.parse(body.subarray(4, 4 + hl).toString());
    const h = new Hist(head.start || start);
    let o = 4 + hl;
    for (const [k, g, base, n] of head.keys) {
      const a = new Uint32Array(n);
      Buffer.from(a.buffer).set(body.subarray(o, o + n * 4)); o += n * 4;
      h.series.set(k, { g, base, a });
    }
    return h;
  }

  // What Minty reads: one file per bunch of sets. series["productId|subType"] = [first day, first price in dollars,
  // then the change from the last price for each later day (null = no price that day)], all in cents.
  bucketJson(groups) {
    const want = new Set(groups.map(Number));
    const series = {};
    for (const [k, s] of this.series) {
      if (!want.has(Number(s.g))) continue;
      const n = Hist.used(s);
      let i0 = 0; while (i0 < n && !s.a[i0]) i0++;
      if (i0 >= n) continue;
      const out = [s.base + i0, s.a[i0]];
      let last = s.a[i0];
      for (let i = i0 + 1; i < n; i++) { const v = s.a[i]; if (!v) out.push(null); else { out.push(v - last); last = v; } }
      series[k] = out;
    }
    return series;
  }
  // Unpack one series of a bucket file (used by the tests and by Minty): [[date, dollars], …]
  static unpack(start, arr) {
    if (!arr || !arr.length) return [];
    const out = [];
    let day = arr[0], last = arr[1];
    out.push([dateOf(start, day), last / 100]);
    for (let i = 2; i < arr.length; i++) { day++; if (arr[i] === null) continue; last += arr[i]; out.push([dateOf(start, day), last / 100]); }
    return out;
  }
}

module.exports = { Hist, dayIndex, dateOf, DAY };
