#!/usr/bin/env python3
"""
Generate the Human Typer app icon.

Draws a keyboard on the indigo->violet brand gradient and exports:
  - icon.icns  (macOS app bundle)
  - icon.ico   (Windows executable)
  - icon_1024.png (master, for stores/web)

Requires Pillow.  Run:  python make_icon.py
"""

import os
import subprocess
import sys

from PIL import Image, ImageDraw

S = 1024
TOP = (99, 102, 241)    # indigo  #6366f1
BOT = (139, 92, 246)    # violet  #8b5cf6


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(size):
    col = Image.new("RGB", (1, size))
    for y in range(size):
        col.putpixel((0, y), lerp(TOP, BOT, y / (size - 1)))
    return col.resize((size, size))


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def make_master():
    img = gradient(S).convert("RGBA")
    draw = ImageDraw.Draw(img, "RGBA")

    # Soft top highlight for depth.
    draw.ellipse([-S * 0.2, -S * 0.55, S * 1.2, S * 0.35], fill=(255, 255, 255, 26))

    # Keyboard body.
    kb_w, kb_h = int(S * 0.64), int(S * 0.40)
    kx = (S - kb_w) // 2
    ky = (S - kb_h) // 2 + int(S * 0.03)
    draw.rounded_rectangle([kx, ky, kx + kb_w, ky + kb_h],
                           radius=int(S * 0.055), fill=(255, 255, 255, 40))

    cols, rows = 5, 3
    pad = int(S * 0.030)
    gap = int(S * 0.020)
    inner_x = kx + pad
    inner_y = ky + pad
    inner_w = kb_w - 2 * pad
    spacebar_h = int(S * 0.045)
    key_area_h = kb_h - 2 * pad - spacebar_h - gap
    key_w = (inner_w - (cols - 1) * gap) / cols
    key_h = (key_area_h - (rows - 1) * gap) / rows
    r = int(key_h * 0.28)
    white = (255, 255, 255, 238)

    for rr in range(rows):
        for cc in range(cols):
            x0 = inner_x + cc * (key_w + gap)
            y0 = inner_y + rr * (key_h + gap)
            draw.rounded_rectangle([x0, y0, x0 + key_w, y0 + key_h], radius=r, fill=white)

    # Spacebar.
    sb_y0 = inner_y + rows * (key_h + gap)
    sb_x0 = inner_x + key_w * 0.9
    sb_x1 = inner_x + inner_w - key_w * 0.9
    draw.rounded_rectangle([sb_x0, sb_y0, sb_x1, sb_y0 + spacebar_h], radius=r, fill=white)

    # Squircle mask.
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(img, (0, 0), rounded_mask(S, int(S * 0.225)))
    return out


def main():
    master = make_master()
    master.save("icon_1024.png")

    iconset = "AppIcon.iconset"
    os.makedirs(iconset, exist_ok=True)
    for base in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            px = base * scale
            suffix = "" if scale == 1 else "@2x"
            master.resize((px, px), Image.LANCZOS).save(
                os.path.join(iconset, f"icon_{base}x{base}{suffix}.png"))

    if sys.platform == "darwin":
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", "icon.icns"], check=True)
        print("Wrote icon.icns")

    master.save("icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("Wrote icon.ico and icon_1024.png")


if __name__ == "__main__":
    main()
