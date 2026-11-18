# Temporary: which unblocked sources give grading prices for CGC, Beckett and SGC.
import re, json, time, urllib.request, urllib.parse, os
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
os.makedirs('out', exist_ok=True)
log = []
def get(u, t=90):
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': UA}), timeout=t)
        return r.status, r.read()
    except Exception as e:
        return getattr(e, 'code', 0), b''
def blocked(b): return bool(re.search(rb'Just a moment|Attention Required|cf-browser-verification|challenge-platform', b[:20000]))
PAGES = {'cgc': 'https://www.cgccards.com/submit/services-fees/cgc-grading/', 'bgs': 'https://www.beckett.com/grading', 'sgc': 'https://www.gosgc.com/card-grading/services-pricing'}
# 1. ask the Archive for a fresh copy, then read the newest copy
for k, u in PAGES.items():
    s, b = get('https://web.archive.org/save/' + u, 180)
    log.append(f'{k} save-now status {s} bytes {len(b)} blocked-copy {blocked(b)}')
    time.sleep(20)
    s, a = get('https://archive.org/wayback/available?url=' + urllib.parse.quote(u, safe=''))
    try: snap = json.loads(a)['archived_snapshots']['closest']
    except Exception: snap = {}
    log.append(f'{k} newest copy {snap.get("timestamp")}')
    if snap.get('url'):
        s, b = get(re.sub(r'/web/(\d+)/', r'/web/\1id_/', snap['url'].replace('http:', 'https:')))
        open(f'out/{k}.newest.html', 'wb').write(b)
        log.append(f'{k} newest copy bytes {len(b)} blocked {blocked(b)} has$ {len(re.findall(rb"\$\s?\d", b))}')
# 2. SGC: the app's own scripts (prices may be inside), straight and from the Archive
for f in ['main-EAXSQEY6.js', 'chunk-SOCBGKAB.js', 'chunk-FK6H3RFT.js', 'chunk-XZCQGYIQ.js', 'chunk-TSRGIXR5.js']:
    for base in ['https://www.gosgc.com/', 'https://web.archive.org/web/2026id_/https://www.gosgc.com/']:
        s, b = get(base + f)
        tag = 'direct' if base.startswith('https://www.gosgc') else 'archive'
        log.append(f'sgc {f} {tag} status {s} bytes {len(b)} blocked {blocked(b)}')
        if b and not blocked(b):
            open(f'out/sgc-{tag}-{f}', 'wb').write(b)
            hosts = sorted(set(re.findall(rb'https?://[a-z0-9.-]*(?:gosgc|sgc)[a-z0-9.-]*\.[a-z]+[^"\'\s]{0,60}', b)))[:30]
            log.append('   hosts: ' + ' | '.join(h.decode('utf8', 'ignore') for h in hosts))
# 3. CGC price announcements on its own news pages and sister sites
for u in ['https://www.cgccards.com/news/', 'https://www.cgccomics.com/news/', 'https://www.cgcvideogames.com/en-US/news-and-events/news']:
    s, b = get(u)
    open('out/news-' + re.sub(r'\W+', '_', u)[:40] + '.html', 'wb').write(b)
    log.append(f'news {u} status {s} bytes {len(b)} blocked {blocked(b)} fee-words {len(re.findall(rb"(?i)fee", b))}')
open('out/log.txt', 'w').write('\n'.join(log))
print('\n'.join(log))
