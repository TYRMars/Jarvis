#!/usr/bin/env python3
"""Generate the Jarvis desktop app icon set.

The vector source-of-truth is `icons/icon.svg`. Because we don't pin
a system SVG rasteriser (no libcairo / no rsvg on most contributor
machines), this script also draws a faithful PIL replica of the same
butler design and emits all the raster sizes Tauri's bundler needs.
If you tweak the SVG, mirror the change here too — both files are
hand-maintained until we have a deterministic rasteriser pinned.

Compared to first-party macOS icons, two design rules matter:

- **Padding.** Apple's HIG places the icon content inside an 824×824
  square centred on the 1024×1024 canvas. Without that, the icon
  reads as oversized in the Dock next to native apps.
- **Squircle.** macOS uses a superellipse, not a CSS round-rect.
  The cubic-Bézier approximation below produces noticeably softer
  shoulders than a `rounded_rectangle` would.

Run:

    python3 apps/jarvis-desktop/scripts/generate_icons.py
"""

from __future__ import annotations

import math
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


HERE = Path(__file__).resolve().parent
ICONS_DIR = HERE.parent / "icons"


# ----- Squircle (macOS Big Sur+ icon shape) ----------------------------

def _superellipse_points(cx: float, cy: float, r: float, n: int = 5, steps: int = 720) -> list[tuple[float, float]]:
    """Sample points on a superellipse |x|^n + |y|^n = r^n.

    n=5 gives the corner softness Apple uses for app icons; n=2
    would be a circle, n=∞ a square.
    """
    pts: list[tuple[float, float]] = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        ct = math.cos(t)
        st = math.sin(t)
        x = math.copysign(abs(ct) ** (2 / n) * r, ct)
        y = math.copysign(abs(st) ** (2 / n) * r, st)
        pts.append((cx + x, cy + y))
    return pts


def _squircle_mask(size: int, inset: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    cx = cy = size / 2
    r = (size - 2 * inset) / 2
    draw.polygon(_superellipse_points(cx, cy, r), fill=255)
    return mask


# ----- Butler glyph ----------------------------------------------------

INK = (26, 34, 48, 255)        # near-black indigo
BG_TOP = (255, 255, 255, 255)
BG_BOT = (238, 241, 246, 255)
ACCENT = (58, 166, 232, 255)   # Jarvis-cyan bowtie
ACCENT_KNOT = (31, 109, 157, 255)


def _vertical_gradient(size: int, top: tuple[int, int, int, int], bottom: tuple[int, int, int, int]) -> Image.Image:
    img = Image.new("RGBA", (size, size), 0)
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(top[0] + (bottom[0] - top[0]) * t)
        g = int(top[1] + (bottom[1] - top[1]) * t)
        b = int(top[2] + (bottom[2] - top[2]) * t)
        a = int(top[3] + (bottom[3] - top[3]) * t)
        for x in range(size):
            px[x, y] = (r, g, b, a)
    return img


def _draw_butler(canvas: Image.Image, cx: int, cy: int, scale: float) -> None:
    """Draw the butler glyph centered on (cx, cy) at unit scale.

    Coordinates inside the function are in "design units" matching
    the SVG; `scale` maps design units → pixels.
    """
    draw = ImageDraw.Draw(canvas)

    def s(v: float) -> float:
        return v * scale

    def at(x: float, y: float) -> tuple[float, float]:
        return (cx + s(x), cy + s(y))

    def line(p1, p2, width):
        draw.line([at(*p1), at(*p2)], fill=INK, width=max(1, int(s(width))))

    def stroke_circle(x, y, r, width):
        bbox = [at(x - r, y - r), at(x + r, y + r)]
        draw.ellipse(bbox, outline=INK, width=max(1, int(s(width))))

    def fill_circle(x, y, r, color=INK):
        bbox = [at(x - r, y - r), at(x + r, y + r)]
        draw.ellipse(bbox, fill=color)

    def fill_polygon(points, color=INK):
        draw.polygon([at(*p) for p in points], fill=color)

    # Head (white fill + ink outline).
    head_radius = 220
    fill_circle(0, 0, head_radius, color=(255, 255, 255, 255))
    stroke_circle(0, 0, head_radius, 14)

    # Bowler hat: filled dome with a thin brim.
    hat_top = [
        (-160, -184),
        (-150, -240),
        (-110, -290),
        (-40, -310),
        (40, -310),
        (110, -290),
        (150, -240),
        (160, -184),
    ]
    fill_polygon(hat_top)
    line((-210, -180), (210, -180), 14)

    # Eyes.
    fill_circle(-72, -30, 14)
    fill_circle(72, -30, 14)

    # Monocle around the right eye + chain dangle.
    stroke_circle(72, -30, 44, 6)
    line((116, -12), (150, 22), 6)

    # Handlebar moustache — two filled teardrops, wide at the
    # philtrum and tapering up-and-outward into a curl tip. Drawn
    # as solid polygons (not strokes) so they survive resampling
    # down to 32 px without breaking up.
    moustache_left = [
        (-6, 56),     # inner tip at the philtrum
        (-50, 78),    # belly of the moustache (sweeping down)
        (-110, 80),   # outer base
        (-148, 60),   # curl shoulder
        (-160, 28),   # curl peak
        (-150, 12),   # curl tip (highest point)
        (-138, 28),   # inside of the curl loop
        (-130, 50),
        (-100, 60),
        (-60, 56),
        (-30, 50),
    ]
    moustache_right = [(-x, y) for (x, y) in moustache_left]
    fill_polygon(moustache_left)
    fill_polygon(moustache_right)

    # Bowtie. Position it just below the head, in cyan.
    bow_y = 220
    fill_polygon(
        [
            (-110, bow_y - 40),
            (-16, bow_y - 12),
            (-16, bow_y + 12),
            (-110, bow_y + 40),
        ],
        color=ACCENT,
    )
    fill_polygon(
        [
            (110, bow_y - 40),
            (16, bow_y - 12),
            (16, bow_y + 12),
            (110, bow_y + 40),
        ],
        color=ACCENT,
    )
    fill_polygon(
        [(-16, bow_y - 14), (16, bow_y - 14), (16, bow_y + 14), (-16, bow_y + 14)],
        color=ACCENT_KNOT,
    )

    # Suit collar — V shape under the bowtie.
    collar = [
        (-150, 320),
        (0, 250),
        (150, 320),
        (150, 360),
        (0, 290),
        (-150, 360),
    ]
    fill_polygon(collar)


# ----- Master render ---------------------------------------------------

def render_master(size: int = 1024) -> Image.Image:
    """Render the icon at `size` with proper macOS padding + squircle.

    The icon content lives in an 824/1024 ≈ 80% safe area centred on
    the canvas; the rest is transparent so the OS can place us at
    the same visual size as native apps.
    """
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    inset = round(size * 100 / 1024)  # 100px padding at 1024
    safe = size - 2 * inset

    # Squircle background.
    bg = _vertical_gradient(size, BG_TOP, BG_BOT)
    mask = _squircle_mask(size, inset)
    canvas.paste(bg, (0, 0), mask)

    # Soft inner highlight along the top of the squircle.
    highlight = Image.new("RGBA", (size, size), 0)
    hd = ImageDraw.Draw(highlight)
    hd.ellipse(
        [(-size * 0.35, -size * 0.55), (size * 1.35, size * 0.55)],
        fill=(255, 255, 255, 28),
    )
    highlight = highlight.filter(ImageFilter.GaussianBlur(size * 0.04))
    highlight.putalpha(ImageChops_multiply_alpha(highlight, mask))
    canvas = Image.alpha_composite(canvas, highlight)

    # Drop shadow under the squircle for "lift". Pasted underneath
    # via a temporary canvas so we don't shadow the glyph too.
    shadow = Image.new("RGBA", (size, size), 0)
    sd = ImageDraw.Draw(shadow)
    sd.polygon(
        _superellipse_points(size / 2, size / 2 + size * 0.012, safe / 2),
        fill=(0, 0, 0, 60),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(size * 0.018))
    canvas = Image.alpha_composite(shadow, canvas)

    # Butler glyph. Design units are SVG-space; the SVG places the
    # butler at translate(0,28) inside the safe area, so apply the
    # same vertical bias here.
    glyph_layer = Image.new("RGBA", (size, size), 0)
    _draw_butler(glyph_layer, size // 2, size // 2 + int(size * 0.028), safe / 1024)
    canvas = Image.alpha_composite(canvas, glyph_layer)

    return canvas


def ImageChops_multiply_alpha(rgba: Image.Image, mask: Image.Image) -> Image.Image:
    """Return rgba's alpha channel multiplied by `mask` (both 'L'-sized)."""
    a = rgba.split()[3]
    out = Image.new("L", rgba.size, 0)
    a_data = a.load()
    m_data = mask.load()
    o_data = out.load()
    for y in range(rgba.height):
        for x in range(rgba.width):
            o_data[x, y] = (a_data[x, y] * m_data[x, y]) // 255
    return out


# ----- Output ---------------------------------------------------------

def write_png(img: Image.Image, path: Path, size: int) -> None:
    if img.size != (size, size):
        img = img.resize((size, size), Image.LANCZOS)
    img.save(path, format="PNG")


def write_iconset_macos(master: Image.Image, out_dir: Path) -> None:
    iconset = out_dir / "icon.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir(parents=True, exist_ok=True)

    sizes = [16, 32, 64, 128, 256, 512, 1024]
    for size in sizes:
        scaled = master.resize((size, size), Image.LANCZOS)
        scaled.save(iconset / f"icon_{size}x{size}.png", format="PNG")
        if size <= 512:
            scaled2x = master.resize((size * 2, size * 2), Image.LANCZOS)
            scaled2x.save(iconset / f"icon_{size}x{size}@2x.png", format="PNG")

    if shutil.which("iconutil"):
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(out_dir / "icon.icns")],
            check=True,
        )
        shutil.rmtree(iconset)
    else:
        print("iconutil not found; leaving icon.iconset/ in place", file=sys.stderr)


def write_ico(master: Image.Image, path: Path) -> None:
    sizes = [(s, s) for s in (16, 24, 32, 48, 64, 128, 256)]
    master.save(path, format="ICO", sizes=sizes)


def main() -> int:
    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    master = render_master(1024)

    write_png(master, ICONS_DIR / "icon.png", 1024)
    write_png(master, ICONS_DIR / "32x32.png", 32)
    write_png(master, ICONS_DIR / "128x128.png", 128)
    write_png(master, ICONS_DIR / "128x128@2x.png", 256)
    write_png(master, ICONS_DIR / "Square30x30Logo.png", 30)
    write_png(master, ICONS_DIR / "Square44x44Logo.png", 44)
    write_png(master, ICONS_DIR / "Square71x71Logo.png", 71)
    write_png(master, ICONS_DIR / "Square89x89Logo.png", 89)
    write_png(master, ICONS_DIR / "Square107x107Logo.png", 107)
    write_png(master, ICONS_DIR / "Square142x142Logo.png", 142)
    write_png(master, ICONS_DIR / "Square150x150Logo.png", 150)
    write_png(master, ICONS_DIR / "Square284x284Logo.png", 284)
    write_png(master, ICONS_DIR / "Square310x310Logo.png", 310)
    write_png(master, ICONS_DIR / "StoreLogo.png", 50)

    write_iconset_macos(master, ICONS_DIR)
    write_ico(master, ICONS_DIR / "icon.ico")

    print(f"Wrote icons to {ICONS_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
