"""Puts the AR logo (with its name) in place of the old wave mark on the logos the team made.

    python tools/logos/swap-mark.py <in.png> <out.png>

Finds the old blue mark in the top third, paints that area with the logo's own background colour
and places tools/logos/ar-logo-text.png there, centred, at the same height."""
import sys, os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGBA')
w, h = im.size
px = im.load()
xs, ys = [], []
for y in range(int(h * 0.27)):
    for x in range(int(w * 0.33), int(w * 0.67)):
        r, g, b, a = px[x, y]
        if b > 120 and r < 120 and b - r > 60:
            xs.append(x); ys.append(y)
if not xs:
    im.save(dst); print('no mark found', src); sys.exit()
x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
pad = int(0.03 * w)
bg = px[5, 5]
box = (max(0, x0 - pad), max(0, y0 - pad), min(w, x1 + pad), min(h, y1 + pad))
im.paste(bg[:3] + (255,), box)
logo = Image.open(os.path.join(HERE, 'ar-logo-text.png'))
lh = int((y1 - y0) * 1.25)
lw = int(logo.width * lh / logo.height)
logo = logo.resize((lw, lh), Image.LANCZOS)
cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
im.alpha_composite(logo, (cx - lw // 2, max(0, cy - lh // 2)))
im.convert('RGB').save(dst)
print('swapped', os.path.basename(src), box)
