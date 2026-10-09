#!/usr/bin/env python3
"""Generate the four status icons for the DSH desktop tray tool.

Pure standard library (no Pillow needed to RUN this script): a minimal PNG
encoder (zlib + struct) plus 4x supersampled antialiased circles. The four
64x64 PNGs land in `icons/` next to this file:

    red.png    blocked  — 需人工处理 (approval / question / plan review pending)
    yellow.png running  — 运行中
    green.png  idle     — 空闲
    gray.png   unknown  — 无法连接 / DSH 未运行

Re-run any time to regenerate:  python3 make_icons.py
"""

import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
SIZE = 64          # output edge
SS = 4             # supersampling factor
RADIUS = SIZE * 0.42
MARGIN = SIZE * 0.06

# (filename, fill rgba, ring rgba) — a subtle darker ring reads better at
# small tray sizes than a flat disc.
ICONS = [
    ("red.png", (239, 68, 68, 255), (185, 28, 28, 255)),
    ("yellow.png", (245, 158, 11, 255), (217, 119, 6, 255)),
    ("green.png", (34, 197, 94, 255), (22, 163, 74, 255)),
    ("gray.png", (156, 163, 175, 255), (107, 114, 128, 255)),
]


def png_bytes(width, height, rows):
    """Encode RGBA rows (list of bytes) as a PNG — the only spec bits we
    need: 8-bit, color type 6, no interlace."""

    def chunk(tag, data):
        out = struct.pack(">I", len(data)) + tag + data
        out += struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return out

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    raw = b"".join(b"\x00" + row for row in rows)  # filter type 0 per row
    idat = zlib.compress(raw, 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def circle_rows(fill, ring):
    """One output pixel = box average of SS*SS supersampled subpixels.
    A subpixel is: fill inside radius-RING_W, ring inside radius, else
    transparent."""
    big = SIZE * SS
    cx = cy = big / 2.0
    r_fill = (RADIUS - MARGIN) * SS
    r_ring = RADIUS * SS
    rows = []
    for y in range(SIZE):
        row = bytearray()
        for x in range(SIZE):
            sr = sg = sb = sa = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    px = x * SS + sx + 0.5
                    py = y * SS + sy + 0.5
                    d = ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5
                    if d <= r_fill:
                        fr, fg, fb, fa = fill
                    elif d <= r_ring:
                        fr, fg, fb, fa = ring
                    else:
                        fr = fg = fb = fa = 0.0
                    sr += fr
                    sg += fg
                    sb += fb
                    sa += fa
            # Box-average the SS*SS subpixels: the averaged RGB is the disc
            # color and the averaged alpha is the disc coverage — exactly
            # right for a flat disc (straight alpha).
            n = float(SS * SS)
            row += bytes((int(sr / n + 0.5), int(sg / n + 0.5),
                          int(sb / n + 0.5), int(sa / n + 0.5)))
        rows.append(bytes(row))
    return rows


def main():
    out_dir = os.path.join(HERE, "icons")
    os.makedirs(out_dir, exist_ok=True)
    for name, fill, ring in ICONS:
        path = os.path.join(out_dir, name)
        with open(path, "wb") as f:
            f.write(png_bytes(SIZE, SIZE, circle_rows(fill, ring)))
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
