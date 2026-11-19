# Temporary: PokeInvest search answers for TCGplayer-style card names.
import json, urllib.request, os
os.makedirs('out', exist_ok=True)
def call(tool, args):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': tool, 'arguments': args}}).encode()
    t = urllib.request.urlopen(urllib.request.Request('https://www.pokeinvest.io/mcp', data=body, headers={'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}), timeout=60).read().decode()
    if 'data:' in t[:20]: t = [l[5:].strip() for l in t.splitlines() if l.startswith('data:')][-1]
    r = json.loads(t)['result']; return r.get('structuredContent') or json.loads(r['content'][0]['text'])
qs = ['Lugia EX (94 Full Art) 94 Ancient Origins', 'Lugia EX 94 Ancient Origins', 'Lugia EX 94', 'Charizard ex 199 151', 'Charizard ex 199', 'Greninja ex 21', 'Greninja ex 214 Twilight Masquerade', 'Umbreon ex 161 Prismatic Evolutions', 'Rayquaza 138', 'Pikachu ex 238 Surging Sparks', 'Mewtwo 10 Base Set', 'Gengar ex 108 FireRed LeafGreen']
out = {}
for q in qs:
    try: out[q] = call('search_cards', {'query': q, 'limit': 10})
    except Exception as e: out[q] = {'error': str(e)}
open('out/pi.json', 'w').write(json.dumps(out, indent=1)); print(json.dumps(out)[:1500])
