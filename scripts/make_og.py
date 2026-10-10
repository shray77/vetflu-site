#!/usr/bin/env python3
"""
vetflu make_og.py — OG-картинка витрины (1200×630) для соцсетей/мессенджеров.
Тёмный фон темы экосистемы, заголовок «VetFlu — окна риска ВПГП», дата + ISO-неделя,
4 строки флайвеев (short-имя, R крупно, доминирующий канал, цвет из migration.json),
футер «shray77.github.io/vetflu-site · ознакомительный индекс».
Данные — data/model.json + data/migration.json (пишет build_model.mjs).
Шрифт: DejaVuSans-Bold из /usr/share/fonts/truetype/dejavu/ (glob), fallback — дефолт PIL.
"""
import glob
import json
import os
from datetime import date

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W, H = 1200, 630

BG = (11, 14, 20)        # --bg #0b0e14
SURFACE = (18, 22, 31)   # --surface #12161f
BORDER = (31, 37, 48)    # --border #1f2530
TEXT = (232, 236, 243)   # --text #e8ecf3
MUTED = (147, 160, 180)  # --muted #93a0b4
FAINT = (93, 106, 125)   # --faint #5d6a7d

model = json.load(open(os.path.join(ROOT, "data", "model.json")))
migr = json.load(open(os.path.join(ROOT, "data", "migration.json")))


def iso_week(d: date) -> int:
    return d.isocalendar()[1]


def load_font(size: int):
    pats = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/**/DejaVuSans-Bold.ttf",
    ]
    for pat in pats:
        hits = glob.glob(pat, recursive=True)
        if hits:
            return ImageFont.truetype(hits[0], size)
    print("DejaVuSans-Bold не найден — fallback на дефолтный шрифт PIL")
    return ImageFont.load_default()


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def chan_label(cid):
    labels = {"transit": "транзит", "colonies": "колонии", "wintering": "зимовки"}
    return labels.get(cid, cid)


today = date.today()
week = iso_week(today)

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# лёгкий градиент шапки: акцентный тинт rgba(56,189,248,.07), как на витрине
for y in range(150):
    k = 1 - y / 150
    d.line([(0, y), (W, y)],
           fill=(11 + int((56 - 11) * 0.07 * k), 14 + int((189 - 14) * 0.07 * k), 20 + int((248 - 20) * 0.07 * k)))

f_title = load_font(52)
f_sub = load_font(24)
f_fw = load_font(28)
f_r = load_font(52)
f_meta = load_font(20)
f_foot = load_font(18)

d.text((60, 52), "VetFlu — окна риска ВПГП", font=f_title, fill=TEXT)
d.text((60, 122), f"{today.isoformat()} · ISO-неделя {week} · {model.get('version', 'v2.0')}",
       font=f_sub, fill=MUTED)

# карточки флайвеев: short-имя, R крупно, канал, мини-разложение
rows = []
for fw in model["flyways"]:
    s = model["series"][fw["id"]]["weeks"][week - 1]
    chan = s.get("chan", "transit")
    r = s.get("r")
    live = r is not None
    val = r if live else max(s["m"], s["c"], s["z"])
    rows.append((fw["short"], fw["label"], val, chan, hex_rgb(fw["color"]), s["m"], s["c"], s["z"], live))

card_h, gap, y0 = 88, 12, 170
for short, label, val, chan, color, m, c, z, live in rows:
    d.rounded_rectangle([60, y0, W - 60, y0 + card_h], radius=16, fill=SURFACE, outline=BORDER, width=1)
    d.rectangle([60, y0, 66, y0 + card_h], fill=color)  # цветовая полоска флайвея слева
    d.text((92, y0 + 14), short, font=f_fw, fill=color)
    d.text((92 + f_fw.getlength(short) + 18, y0 + 22), label, font=f_meta, fill=FAINT)
    d.text((W - 60 - 330, y0 + 10), f"{val}", font=f_r, fill=color)
    d.text((W - 60 - 330 + f_r.getlength(str(val)) + 14, y0 + 32),
           chan_label(chan) + ("" if live else " (статика)"), font=f_meta, fill=MUTED)
    d.text((92, y0 + 58), f"M {m} · C {c} · Z {z}", font=f_meta, fill=MUTED)
    y0 += card_h + gap

# футер
d.text((60, H - 56), "shray77.github.io/vetflu-site · ознакомительный индекс · не ветеринарный совет",
       font=f_foot, fill=FAINT)

out = os.path.join(ROOT, "og-image.png")
img.save(out)
print(f"OK {out} ({W}x{H}), неделя {week}: " + ", ".join(f"{s}={v}" for s, _, v, *_ in rows))
