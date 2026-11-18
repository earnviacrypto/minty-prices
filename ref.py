import re, sys, os, json, urllib.parse, urllib.request
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
os.makedirs('out', exist_ok=True)
def get(u):
    try:
        return urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': UA}), timeout=40).read()
    except Exception as e:
        print('fail', u, e); return b''
log = []
for line in open('ref.txt'):
    if '|' not in line: continue
    name, base = line.strip().split('|', 1)
    h = get(base).decode('utf8', 'ignore')
    open(f'out/{name}.html', 'w').write(h)
    log.append(f'{name} {len(h)}')
    seen = []
    for m in re.findall(r'(?:src|data-src|srcset|href|content)=["\']([^"\']+?\.(?:jpg|jpeg|png|webp)[^"\'\s,]*)', h, re.I):
        u = urllib.parse.urljoin(base, m.split(' ')[0])
        if re.search(r'slab|label|holder|graded|grade|psa|cgc|bgs|sgc|tag|pokemon|card|upload|optimized|wp-content', u, re.I) and u not in seen: seen.append(u)
    for k, u in enumerate(seen[40:120], 41):
        b = get(u)
        if len(b) > 3000:
            ext = re.sub(r'\?.*', '', u).rsplit('.', 1)[-1][:4]
            open(f'out/{name}-{k}.{ext}', 'wb').write(b); log.append(f'  {name}-{k} {u}')
c = get('https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=graded%20card%20slab&gsrlimit=20&prop=imageinfo&iiprop=url&iiurlwidth=900&format=json')
open('out/commons.json', 'wb').write(c)
open('out/log.txt', 'w').write('\n'.join(log))
print('\n'.join(log))
