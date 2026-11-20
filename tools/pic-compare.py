# One-off check: eBay's catalog picture of each matched card next to TCGplayer's picture of the same product.
# For every card in prices/epid.json.gz that has an eBay picture: download both, compare them (perceptual hash distance
# 0 = same picture, colour difference), and draw side-by-side sheets. Results go to the "checks" release:
# pic-compare.json and pic-compare-N.jpg (TCGplayer left, eBay right).
import gzip, io, json, urllib.request, sys
from PIL import Image, ImageDraw, ImageOps
import imagehash

MIRROR = 'https://github.com/earnviacrypto/minty-prices/releases/download'
def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'minty-prices'})
    with urllib.request.urlopen(req, timeout=60) as r: return r.read()
epid = json.loads(gzip.decompress(get(MIRROR + '/prices/epid.json.gz')))['items']
pairs = [(pid, e) for pid, lst in epid.items() for e in lst[:1] if e[1]]
out, tiles = [], []
for pid, (ep, img, title) in pairs:
    row = {'pid': pid, 'epid': ep, 'title': title}
    try:
        a = Image.open(io.BytesIO(get(f'https://tcgplayer-cdn.tcgplayer.com/product/{pid}_in_1000x1000.jpg'))).convert('RGB')
        b = Image.open(io.BytesIO(get(img.split('?')[0].replace('$_57', '$_10') if '$_57' in img else img))).convert('RGB')
    except Exception as ex:
        row['error'] = str(ex)[:120]; out.append(row); continue
    # trim plain borders so framing differences do not count
    def trim(im):
        bg = Image.new('RGB', im.size, im.getpixel((0, 0)))
        from PIL import ImageChops
        box = ImageChops.difference(im, bg).convert('L').point(lambda v: 255 if v > 25 else 0).getbbox()
        return im.crop(box) if box else im
    ta, tb = trim(a), trim(b)
    row['ph'] = int(imagehash.phash(ta) - imagehash.phash(tb))
    row['dh'] = int(imagehash.dhash(ta) - imagehash.dhash(tb))
    sa, sb = ta.resize((32, 44)), tb.resize((32, 44))
    row['col'] = round(sum(abs(x - y) for p, q in zip(sa.getdata(), sb.getdata()) for x, y in zip(p, q)) / (32 * 44 * 3), 1)
    row['ratio'] = [round(ta.width / ta.height, 3), round(tb.width / tb.height, 3)]
    out.append(row)
    tiles.append((row, ta, tb))
# sheets: 4 pairs per row, 5 rows per sheet
W, H = 150, 210
sheets = []
for s in range(0, len(tiles), 20):
    chunk = tiles[s:s + 20]
    sheet = Image.new('RGB', (4 * (2 * W + 30), 5 * (H + 46)), 'white'); d = ImageDraw.Draw(sheet)
    for i, (row, ta, tb) in enumerate(chunk):
        x, y = (i % 4) * (2 * W + 30), (i // 4) * (H + 46)
        sheet.paste(ImageOps.contain(ta, (W, H)), (x + 5, y + 5)); sheet.paste(ImageOps.contain(tb, (W, H)), (x + W + 10, y + 5))
        d.text((x + 5, y + H + 8), f"{row['pid']} ph{row['ph']} col{row['col']}", fill='black')
        d.text((x + 5, y + H + 22), row['title'][:44], fill='gray')
    buf = io.BytesIO(); sheet.save(buf, 'JPEG', quality=85); sheets.append(buf.getvalue())
open('pic-compare.json', 'w').write(json.dumps({'pairs': len(pairs), 'compared': len(tiles), 'rows': out}, indent=1))
for i, b in enumerate(sheets): open(f'pic-compare-{i + 1}.jpg', 'wb').write(b)
print(len(pairs), 'pairs,', len(tiles), 'compared,', len(sheets), 'sheets')
