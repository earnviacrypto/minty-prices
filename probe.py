# Temporary: can GitHub read the report sites for Beckett and SGC?
import re, urllib.request, os
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
os.makedirs('out', exist_ok=True); log = []
def get(u):
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': UA, 'Accept': 'text/html'}), timeout=60)
        return r.status, r.read(), dict(r.headers)
    except Exception as e:
        return getattr(e, 'code', 0), (e.read() if hasattr(e, 'read') else b''), {}
for name, u in [('thelines-sgc', 'https://www.thelines.com/card-rips/grading/sgc/'),
                ('aamint-sgc', 'https://www.aamintstore.com/sgc-grading-cost-and-how-to-submit-your-cards/'),
                ('tcn-sgc', 'https://thecollectornation.com/grading/sgc'),
                ('tcn-bgs', 'https://thecollectornation.com/grading/beckett'),
                ('cga-bgs', 'https://cardgrading.app/beckett-grading-cost'),
                ('cga-sgc', 'https://cardgrading.app/sgc-grading-cost'),
                ('tcgrader', 'https://www.tcgrader.com/card-grading-costs'),
                ('cgio-bgs', 'https://cardgrade.io/beckett-grading'),
                ('cgio-sgc', 'https://cardgrade.io/sgc-grading')]:
    s, b, h = get(u); open('out/' + name + '.html', 'wb').write(b)
    cf = bool(re.search(rb'Just a moment|Attention Required|challenge-platform|cf_chl|captcha', b[:40000], re.I))
    log.append(f"{name} {s} {len(b)} challenge={cf} server={h.get('Server') or h.get('server')} dollars={len(re.findall(rb'\$\s?\d', b))}")
open('out/log.txt', 'w').write('\n'.join(log)); print('\n'.join(log))
