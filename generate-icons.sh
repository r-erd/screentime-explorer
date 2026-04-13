#!/usr/bin/env bash
# generate-icons.sh
# Usage:
#   ./generate-icons.sh --app path/to/app-icon-1024.png --menubar path/to/menubar-icon.png
#
# --app      A 1024x1024 PNG for the app icon (Finder, Dock, FDA list, DMG)
# --menubar  A PNG with your icon design. Can be black-on-white, black-on-transparent,
#            or any greyscale/color PNG — this script converts it to a proper
#            macOS template image (black marks on transparent background).
#
# Requires: sips, iconutil (built into macOS), python3 (pre-installed on macOS)

set -euo pipefail

APP_SRC=""
MB_SRC=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)      APP_SRC="$2"; shift 2 ;;
    --menubar)  MB_SRC="$2";  shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

if [[ -z "$APP_SRC" && -z "$MB_SRC" ]]; then
  echo "Usage: $0 --app <1024x1024.png> --menubar <icon.png>"
  echo "       Either or both flags can be provided."
  exit 1
fi

ASSETS_DIR="$(dirname "$0")/assets"
mkdir -p "$ASSETS_DIR"

# ── Python helper: convert any PNG to a proper RGBA template image ────────────
# Dark pixels → opaque black, light pixels → transparent.
# Works whether the source is RGB, RGBA, or greyscale.
CONVERT_PY='
import sys, struct, zlib

def parse_png(path):
    with open(path, "rb") as f:
        data = f.read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "Not a PNG"
    chunks = []
    i = 8
    while i < len(data):
        length = struct.unpack(">I", data[i:i+4])[0]
        ctype  = data[i+4:i+8]
        cdata  = data[i+8:i+8+length]
        chunks.append((ctype, cdata))
        i += 12 + length
    ihdr  = next(d for t,d in chunks if t == b"IHDR")
    w, h  = struct.unpack(">II", ihdr[:8])
    bdepth, ctype_img = ihdr[8], ihdr[9]
    idat  = b"".join(d for t,d in chunks if t == b"IDAT")
    return w, h, bdepth, ctype_img, zlib.decompress(idat)

def write_png(path, w, h, pixels_rgba):
    def crc(d): return zlib.crc32(d) & 0xFFFFFFFF
    def chunk(t, d):
        body = t + d
        return struct.pack(">I", len(d)) + body + struct.pack(">I", crc(body))
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            raw.extend(pixels_rgba[y*w+x])
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    out  = b"\x89PNG\r\n\x1a\n"
    out += chunk(b"IHDR", ihdr)
    out += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    out += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(out)

def apply_filter(row, prev, ftype, bpp):
    """Reverse PNG row filter."""
    out = bytearray(row)
    if ftype == 0:
        pass
    elif ftype == 1:  # Sub
        for i in range(bpp, len(out)):
            out[i] = (out[i] + out[i-bpp]) & 0xFF
    elif ftype == 2:  # Up
        for i in range(len(out)):
            out[i] = (out[i] + prev[i]) & 0xFF
    elif ftype == 3:  # Average
        for i in range(len(out)):
            a = out[i-bpp] if i >= bpp else 0
            b = prev[i]
            out[i] = (out[i] + (a+b)//2) & 0xFF
    elif ftype == 4:  # Paeth
        for i in range(len(out)):
            a = out[i-bpp] if i >= bpp else 0
            b_ = prev[i]
            c = prev[i-bpp] if i >= bpp else 0
            p = a + b_ - c
            pa, pb, pc = abs(p-a), abs(p-b_), abs(p-c)
            pr = a if pa<=pb and pa<=pc else b_ if pb<=pc else c
            out[i] = (out[i] + pr) & 0xFF
    return bytes(out)

def to_template(src, dst):
    w, h, bdepth, ct, raw = parse_png(src)
    assert bdepth == 8, f"Only 8-bit PNGs supported (got {bdepth})"
    bpp = {0:1, 2:3, 6:4}.get(ct)
    assert bpp, f"Unsupported color type {ct}"
    stride = w * bpp
    rows = []
    prev = bytes(stride)
    pos = 0
    for _ in range(h):
        ftype = raw[pos]; pos += 1
        row   = apply_filter(raw[pos:pos+stride], prev, ftype, bpp)
        rows.append(row); prev = row; pos += stride
    pixels = []
    for y in range(h):
        for x in range(w):
            base = x * bpp
            if ct == 2:    # RGB  → use luminance for alpha
                r,g,b = rows[y][base:base+3]
                grey  = (r*299 + g*587 + b*114) // 1000
                alpha = 255 - grey
            elif ct == 6:  # RGBA → combine existing alpha with luminance
                r,g,b,a = rows[y][base:base+4]
                grey  = (r*299 + g*587 + b*114) // 1000
                alpha = (255 - grey) * a // 255
            else:          # Grey → invert directly
                grey  = rows[y][base]
                alpha = 255 - grey
            pixels.append((0, 0, 0, alpha))
    write_png(dst, w, h, pixels)
    print(f"  converted {src} → RGBA template")

to_template(sys.argv[1], sys.argv[2])
'

# ── App icon ──────────────────────────────────────────────────────────────────
if [[ -n "$APP_SRC" ]]; then
  echo "→ Generating app icon from: $APP_SRC"

  ICONSET="$ASSETS_DIR/icon.iconset"
  rm -rf "$ICONSET"
  mkdir -p "$ICONSET"

  sips -z 16   16   "$APP_SRC" --out "$ICONSET/icon_16x16.png"      > /dev/null
  sips -z 32   32   "$APP_SRC" --out "$ICONSET/icon_16x16@2x.png"   > /dev/null
  sips -z 32   32   "$APP_SRC" --out "$ICONSET/icon_32x32.png"      > /dev/null
  sips -z 64   64   "$APP_SRC" --out "$ICONSET/icon_32x32@2x.png"   > /dev/null
  sips -z 128  128  "$APP_SRC" --out "$ICONSET/icon_128x128.png"    > /dev/null
  sips -z 256  256  "$APP_SRC" --out "$ICONSET/icon_128x128@2x.png" > /dev/null
  sips -z 256  256  "$APP_SRC" --out "$ICONSET/icon_256x256.png"    > /dev/null
  sips -z 512  512  "$APP_SRC" --out "$ICONSET/icon_256x256@2x.png" > /dev/null
  sips -z 512  512  "$APP_SRC" --out "$ICONSET/icon_512x512.png"    > /dev/null
  sips -z 1024 1024 "$APP_SRC" --out "$ICONSET/icon_512x512@2x.png" > /dev/null

  iconutil -c icns "$ICONSET" -o "$ASSETS_DIR/icon.icns"
  rm -rf "$ICONSET"

  echo "✓ App icon → assets/icon.icns"
fi

# ── Menu bar template icon ────────────────────────────────────────────────────
if [[ -n "$MB_SRC" ]]; then
  echo "→ Generating menu bar icon from: $MB_SRC"

  TMP1X="/tmp/mb_1x_raw.png"
  TMP2X="/tmp/mb_2x_raw.png"

  # Step 1: resize with sips
  sips -z 22 22 "$MB_SRC" --out "$TMP1X" > /dev/null
  sips -z 44 44 "$MB_SRC" --out "$TMP2X" > /dev/null

  # Step 2: convert to RGBA template (dark=opaque, light=transparent)
  python3 -c "$CONVERT_PY" "$TMP1X" "$ASSETS_DIR/iconTemplate.png"
  python3 -c "$CONVERT_PY" "$TMP2X" "$ASSETS_DIR/iconTemplate@2x.png"

  rm -f "$TMP1X" "$TMP2X"

  echo "✓ Menu bar icons → assets/iconTemplate.png + iconTemplate@2x.png"
fi

echo ""
echo "Done. Rebuild the app:"
echo "  CSC_IDENTITY_AUTO_DISCOVERY=false npm run build"
