# Temporary: round 2 – direct reads of the right pages, SGC's current app files.
import re, json, time, urllib.request, urllib.parse, os
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
os.makedirs('out', exist_ok=True)
log = []
def get(u, t=60):
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': UA, 'Accept': 'text/html,application/json,*/*'}), timeout=t)
        return r.status, r.read()
    except Exception as e:
        return getattr(e, 'code', 0), b''
def blocked(b): return bool(re.search(rb'Just a moment|Attention Required|challenge-platform|cf_chl', b[:30000]))
def save(name, b): open('out/' + name, 'wb').write(b)
for name, u in [('cgc-fees', 'https://www.cgccards.com/submit/services-fees/cgc-grading/'), ('cgc-fees2', 'https://www.cgccards.com/submit/services-fees/'),
                ('bgs', 'https://www.beckett.com/grading'), ('bgs2', 'https://beckett.com/grading'), ('bgs-gaming', 'https://www.beckett.com/gaming-grading'),
                ('sgc-home', 'https://www.gosgc.com/'), ('sgc-pricing', 'https://www.gosgc.com/card-grading/services-pricing'), ('sgc-pricing2', 'https://gosgc.com/card-grading/services-pricing')]:
    s, b = get(u); save(name + '.html', b)
    log.append(f'{name} {s} {len(b)} blocked={blocked(b)} dollars={len(re.findall(rb"\$\s?\d", b))}')
# SGC app: current scripts from its home page, then every chunk they load
s, b = get('https://www.gosgc.com/')
scripts = re.findall(rb'(?:src|href)="((?:main|chunk|polyfills)-[A-Z0-9]+\.js)"', b)
seen, todo = set(), [x.decode() for x in scripts]
while todo and len(seen) < 80:
    f = todo.pop(0)
    if f in seen: continue
    seen.add(f)
    s, js = get('https://www.gosgc.com/' + f)
    if not js or js.startswith(b'<!DOCTYPE'): continue
    save('sgc-' + f, js)
    todo += [x.decode() for x in re.findall(rb'(chunk-[A-Z0-9]+\.js)', js) if x.decode() not in seen]
    if re.search(rb'(?i)services-pricing|declared value|expedited', js): log.append(f'sgc pricing words in {f} ({len(js)} bytes)')
    for h in sorted(set(re.findall(rb'https?://[a-z0-9.-]+\.[a-z]{2,}(?:/[a-zA-Z0-9/_.-]{0,60})?', js))):
        if re.search(rb'sgc|api', h): log.append(f'   {f}: {h.decode()}')
log.append(f'sgc files read: {len(seen)}')
open('out/log.txt', 'w').write('\n'.join(log)); print('\n'.join(log))
