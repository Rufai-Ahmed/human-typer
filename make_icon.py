#!/usr/bin/env python3
"""
Generate the Human Typer app icon — "Terminal Refined" look.

A flat near-black squircle (the keyboard deck) with a 1px hairline edge and a
phosphor-green terminal prompt `>_`. No gradients, no glow — matches the app's
design tokens (bg #0a0c0d, surface #101314, hairline #242a2b, accent #34c07d).

Exports:
  - icon.icns       (macOS app bundle, via iconutil)
  - icon.ico        (Windows executable)
  - icon_1024.png   (master, for stores/web)
  - landing/icon.png (favicon / og image)

Requires Pillow + macOS iconutil (for the .icns). Run:  python make_icon.py
"""

import os
import shutil
import subprocess

from PIL import Image, ImageDraw

SS = 4                        # supersample factor for crisp antialiased edges
DECK = (10, 12, 13, 255)      # #0a0c0d  page/deck
HAIRLINE = (45, 52, 53, 255)  # slightly lifted edge so the squircle reads as a panel
ACCENT = (52, 192, 125, 255)  # #34c07d phosphor green


def _thick(draw, points, width, fill):
    """A thick polyline with round caps + joins."""
    draw.line(points, fill=fill, width=width, joint="curve")
    r = width / 2
    for x, y in (points[0], points[-1]):
        draw.ellipse([x - r, y - r, x + r, y + r], fill=fill)


def render(px):
    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Squircle "deck" (macOS-grid-ish margin + corner radius).
    m = px * 0.092
    side = px - 2 * m
    radius = side * 0.2237
    box = [m, m, px - m, px - m]
    d.rounded_rectangle(box, radius=radius, fill=DECK)
    d.rounded_rectangle(box, radius=radius, outline=HAIRLINE, width=max(1, int(px * 0.004)))

    cx, cy = px / 2, px / 2
    w = px * 0.055                      # stroke weight of the prompt glyph
    ox = -px * 0.055                    # shift `>_` group left so it reads centred
    chx, chy = px * 0.085, px * 0.125   # `>` chevron half-width / half-height
    _thick(d, [(cx + ox - chx, cy - chy), (cx + ox + chx, cy), (cx + ox - chx, cy + chy)], int(w), ACCENT)
    uy = cy + px * 0.135                # `_` caret, lower-right, like a waiting prompt
    _thick(d, [(cx + ox + px * 0.115, uy), (cx + ox + px * 0.265, uy)], int(w), ACCENT)
    return img


def main():
    root = os.path.dirname(os.path.abspath(__file__))
    os.chdir(root)

    master = render(1024 * SS).resize((1024, 1024), Image.LANCZOS)
    master.save("icon_1024.png")
    print("wrote icon_1024.png")

    master.save("icon.ico", sizes=[(s, s) for s in (16, 32, 48, 64, 128, 256)])
    print("wrote icon.ico")

    os.makedirs("landing", exist_ok=True)
    master.resize((512, 512), Image.LANCZOS).save("landing/icon.png")
    print("wrote landing/icon.png")

    if shutil.which("iconutil"):
        iconset = "icon.iconset"
        shutil.rmtree(iconset, ignore_errors=True)
        os.makedirs(iconset)
        specs = [(16, ""), (16, "@2x"), (32, ""), (32, "@2x"),
                 (128, ""), (128, "@2x"), (256, ""), (256, "@2x"),
                 (512, ""), (512, "@2x")]
        for base, suffix in specs:
            px = base * (2 if suffix else 1)
            master.resize((px, px), Image.LANCZOS).save(f"{iconset}/icon_{base}x{base}{suffix}.png")
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", "icon.icns"], check=True)
        shutil.rmtree(iconset, ignore_errors=True)
        print("wrote icon.icns")
    else:
        print("iconutil not found — skipping icon.icns (build on macOS to generate it)")


if __name__ == "__main__":
    main()
