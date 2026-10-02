"""Generate the DSH Page Bridge extension icons.

Two renderings are produced:
  * detailed  -> 128 / 48 px
  * simplified (bolder strokes, fewer lines) -> 32 / 16 px, where fine detail turns to mush
"""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "extension", "icons")
os.makedirs(OUT, exist_ok=True)

S = 512
BG_TOP = (72, 140, 255)
BG_BOTTOM = (28, 76, 216)
INK = (255, 255, 255)


def gradient(size, top, bottom):
    img = Image.new("RGB", (size, size), top)
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        row = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(size):
            px[x, y] = row
    return img


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def build_master(simple=False):
    base = gradient(S, BG_TOP, BG_BOTTOM).convert("RGBA")
    base.putalpha(rounded_mask(S, radius=int(S * 0.22)))

    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    stroke = int(S * (0.085 if simple else 0.06))
    left, top, right, bottom = int(S * 0.22), int(S * 0.14), int(S * 0.62), int(S * 0.76)
    d.rounded_rectangle([left, top, right, bottom], radius=int(S * 0.055),
                        outline=INK + (255,), width=stroke)

    line_x0, line_x1 = left + stroke + int(S * 0.05), right - stroke - int(S * 0.04)
    fractions = (0.30, 0.52) if simple else (0.25, 0.39, 0.53)
    thickness = int(S * (0.085 if simple else 0.05))
    for i, frac in enumerate(fractions):
        y = top + int(S * frac)
        x1 = line_x1 if i < len(fractions) - 1 else line_x0 + int((line_x1 - line_x0) * 0.55)
        d.rounded_rectangle([line_x0, y, x1, y + thickness],
                            radius=thickness // 2, fill=INK + (240,))

    cx, cy = int(S * (0.56 if simple else 0.58)), int(S * (0.52 if simple else 0.55))
    span = int(S * (0.40 if simple else 0.34))
    arrow = [
        (cx, cy),
        (cx, cy + span),
        (cx + span * 0.30, cy + span * 0.72),
        (cx + span * 0.52, cy + span * 0.99),
        (cx + span * 0.70, cy + span * 0.88),
        (cx + span * 0.48, cy + span * 0.60),
        (cx + span * 0.85, cy + span * 0.47),
    ]
    d.polygon(arrow, fill=INK + (255,))
    d.line(arrow + [arrow[0]], fill=BG_BOTTOM + (255,),
           width=max(2, int(S * (0.026 if simple else 0.018))), joint="curve")

    return Image.alpha_composite(base, layer)


detailed = build_master(simple=False)
detail_simple = build_master(simple=True)
detailed.save(os.path.join(OUT, "icon-master.png"))

for size, master in ((128, detailed), (48, detailed), (32, detail_simple), (16, detail_simple)):
    master.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, f"icon{size}.png"))
    print(f"wrote icon{size}.png ({'simplified' if master is detail_simple else 'detailed'})")
