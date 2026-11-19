# Temporary: what PokeInvest's population tool returns.
import json, urllib.request, os
os.makedirs('out', exist_ok=True)
def call(method, params):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
    r = urllib.request.urlopen(urllib.request.Request('https://www.pokeinvest.io/mcp', data=body, headers={'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}), timeout=60)
    t = r.read().decode()
    if t.startswith('event:') or 'data:' in t[:20]: t = [l[5:].strip() for l in t.splitlines() if l.startswith('data:')][-1]
    return json.loads(t)
out = {}
try: out['tools'] = [{k: t.get(k) for k in ('name', 'description', 'inputSchema')} for t in call('tools/list', {})['result']['tools']]
except Exception as e: out['tools_err'] = str(e)
for args in ({'card': 'pi_12081'},):
    for tool in ('get_population', 'get_card_prices', 'get_population_history'):
        try: out[tool] = call('tools/call', {'name': tool, 'arguments': args})
        except Exception as e: out[tool + '_err'] = str(e)
try: out['search'] = call('tools/call', {'name': 'search_cards', 'arguments': {'query': 'charizard base set 4', 'limit': 3}})
except Exception as e: out['search_err'] = str(e)
open('out/pi.json', 'w').write(json.dumps(out, indent=1))
print(json.dumps(out)[:3000])
