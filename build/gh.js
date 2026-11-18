// GitHub: release downloads (where the data files live) and one small file in the repository (index.json).
const API = 'https://api.github.com', UP = 'https://uploads.github.com';

class GitHub {
  constructor({ repo, token, fetch, log }) { this.repo = repo; this.token = token; this.fetch = fetch; this.log = log || (() => {}); this.rel = {}; this.calls = 0; }
  async api(method, url, body, headers = {}) {
    for (let t = 0; ; t++) {
      this.calls++;
      const r = await this.fetch(url.startsWith('http') ? url : API + url, {
        method, headers: Object.assign({ authorization: 'Bearer ' + this.token, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'minty-prices' }, headers),
        body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
      });
      if (r.status === 404 && method === 'GET') return null;
      if ((r.status >= 500 || r.status === 403 || r.status === 429) && t < 4) { this.log('GitHub', method, url, r.status, '– waiting'); await sleep(15000 * (t + 1)); continue; }
      if (!r.ok) throw new Error(`GitHub ${method} ${url}: ${r.status} ${(await r.text()).slice(0, 300)}`);
      return r.status === 204 ? null : r.json();
    }
  }
  async release(tag) {
    if (this.rel[tag]) return this.rel[tag];
    let r = await this.api('GET', `/repos/${this.repo}/releases/tags/${tag}`);
    if (!r) r = await this.api('POST', `/repos/${this.repo}/releases`, { tag_name: tag, name: tag, body: 'Data files for Minty TCG Portfolio Tracker. Updated automatically.', make_latest: 'false' });
    r.assetList = null;
    return (this.rel[tag] = r);
  }
  async assets(tag) {
    const r = await this.release(tag);
    if (r.assetList) return r.assetList;
    let all = [];
    for (let p = 1; ; p++) { const a = await this.api('GET', `/repos/${this.repo}/releases/${r.id}/assets?per_page=100&page=${p}`); all = all.concat(a || []); if (!a || a.length < 100) break; }
    return (r.assetList = all);
  }
  async download(tag, name) {
    const a = (await this.assets(tag)).find(x => x.name === name);
    if (!a) return null;
    for (let t = 0; ; t++) {
      const r = await this.fetch(a.browser_download_url, { headers: { 'user-agent': 'minty-prices' } });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      if (t >= 3) throw new Error('download ' + name + ': ' + r.status);
      await sleep(10000 * (t + 1));
    }
  }
  // Replace a file: upload it under a temporary name, delete the old one, then rename – so it is missing for a moment only.
  async put(tag, name, buf) {
    const r = await this.release(tag);
    const list = await this.assets(tag);
    for (const a of list.filter(x => x.name === name + '.new')) await this.api('DELETE', `/repos/${this.repo}/releases/assets/${a.id}`);
    const up = await this.api('POST', `${UP}/repos/${this.repo}/releases/${r.id}/assets?name=${encodeURIComponent(name + '.new')}`, buf, { 'content-type': 'application/octet-stream' });
    const old = list.find(x => x.name === name);
    if (old) await this.api('DELETE', `/repos/${this.repo}/releases/assets/${old.id}`);
    const done = await this.api('PATCH', `/repos/${this.repo}/releases/assets/${up.id}`, { name });
    r.assetList = list.filter(x => x.name !== name && x.name !== name + '.new').concat([done]);
    return done;
  }
  async remove(tag, name) {
    const r = await this.release(tag);
    const list = await this.assets(tag);
    for (const a of list.filter(x => x.name === name)) await this.api('DELETE', `/repos/${this.repo}/releases/assets/${a.id}`);
    r.assetList = list.filter(x => x.name !== name);
  }
  // A small text file in the repository itself (one commit).
  async writeFile(path, text, message) {
    const cur = await this.api('GET', `/repos/${this.repo}/contents/${path}`);
    if (cur && Buffer.from(cur.content || '', 'base64').toString() === text) return false;
    await this.api('PUT', `/repos/${this.repo}/contents/${path}`, { message, content: Buffer.from(text).toString('base64'), sha: cur ? cur.sha : undefined });
    return true;
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
module.exports = { GitHub, sleep };
