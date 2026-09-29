"""
Image preprocessing utilities: quantize, palette extraction, resize, SVG palette parsing.
"""
import re
import xml.etree.ElementTree as ET
from collections import Counter
import numpy as np
from PIL import Image


MAX_PREVIEW_SIDE = 2048  # max px for live-preview resize


def resize_for_preview(img: Image.Image) -> Image.Image:
    """Downscale if the image exceeds MAX_PREVIEW_SIDE on either dimension."""
    w, h = img.size
    if w <= MAX_PREVIEW_SIDE and h <= MAX_PREVIEW_SIDE:
        return img
    ratio = MAX_PREVIEW_SIDE / max(w, h)
    return img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)


def quantize(img: Image.Image, n_colors: int) -> Image.Image:
    """Reduce the image to at most n_colors using Pillow adaptive palette."""
    if n_colors < 2:
        return img
    n_colors = max(2, min(256, n_colors))
    rgb = img.convert("RGB")
    quantized = rgb.quantize(colors=n_colors, method=Image.Quantize.MEDIANCUT, dither=0)
    return quantized.convert("RGB")


ANALYZE_SAMPLE_SIDE = 400  # px; color analysis runs on a downscaled copy


def _hex(rgb) -> str:
    return "#{:02x}{:02x}{:02x}".format(*rgb[:3])


def _hex_to_rgb(value: str) -> tuple[int, int, int]:
    v = value.lstrip("#")
    if len(v) != 6:
        raise ValueError(f"Invalid color: {value}")
    return int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16)


# Colors closer than this (RGB distance) are treated as one: they are usually
# noise or anti-aliasing variants of the same ink, and keeping them separate
# only fragments the trace.
NEAR_DUPLICATE_DIST = 24


def analyze_colors(img: Image.Image, n_colors: int) -> tuple[list[dict], str | None]:
    """Find up to n dominant colors of an image for pre-trace color editing.

    Returns ([{color, pct}] sorted by area, background_hex). Near-duplicate
    shades are folded together, so fewer than n colors may come back. The
    background is the color covering most of the image border.
    """
    n_colors = max(2, min(64, n_colors))
    sample = img.convert("RGB")
    sample.thumbnail((ANALYZE_SAMPLE_SIDE, ANALYZE_SAMPLE_SIDE), Image.LANCZOS)
    q = sample.quantize(colors=n_colors, method=Image.Quantize.MEDIANCUT,
                        kmeans=2, dither=Image.Dither.NONE)
    pal = np.array(q.getpalette()[:256 * 3], dtype=np.float64).reshape(-1, 3)
    idx = np.asarray(q)
    counts = np.bincount(idx.ravel(), minlength=len(pal)).astype(np.float64)
    border = np.concatenate([idx[0, :], idx[-1, :], idx[:, 0], idx[:, -1]])
    border_counts = np.bincount(border, minlength=len(pal)).astype(np.float64)

    # Greedy merge, largest first: each smaller color folds into the first
    # kept color within NEAR_DUPLICATE_DIST (area-weighted mean color).
    kept = []  # [rgb, area, border_area]
    for i in np.argsort(-counts):
        if counts[i] == 0:
            break
        for k in kept:
            if np.linalg.norm(k[0] - pal[i]) < NEAR_DUPLICATE_DIST:
                total = k[1] + counts[i]
                k[0] = (k[0] * k[1] + pal[i] * counts[i]) / total
                k[1] = total
                k[2] += border_counts[i]
                break
        else:
            kept.append([pal[i].copy(), counts[i], border_counts[i]])

    total_px = idx.size
    kept.sort(key=lambda k: -k[1])
    colors = [
        {"color": _hex(np.rint(k[0]).astype(int)), "pct": round(float(100.0 * k[1] / total_px), 2)}
        for k in kept
    ]
    bg = max(range(len(kept)), key=lambda j: kept[j][2]) if kept else None
    background = colors[bg]["color"] if bg is not None else None
    return colors, background


# Candidate placeholder colors for dropped layers (loud, rarely in artwork).
_KEY_CANDIDATES = [
    (255, 0, 255), (0, 255, 0), (0, 255, 255), (255, 0, 0),
    (0, 0, 255), (255, 255, 0), (128, 0, 255), (0, 128, 128),
]


def apply_color_layers(img: Image.Image, layers: list[dict]) -> tuple[Image.Image, str | None]:
    """Snap every pixel to its nearest layer color, then recolor or drop it.

    layers: [{color, output, enabled}]. Enabled layers are painted with
    `output`; giving two layers the same output merges them into one region
    before tracing. Disabled layers are painted with an opaque placeholder
    ("key") color, returned alongside the image, whose shapes the caller strips
    from the traced SVG with remove_key_paths().

    A key color is used instead of transparency because VTracer hangs, with
    unbounded memory growth, on transparent input in Cutout mode.
    """
    if not layers:
        return img, None
    src = np.array([_hex_to_rgb(l["color"]) for l in layers], dtype=np.uint8)
    out = np.array([_hex_to_rgb(l.get("output") or l["color"]) for l in layers], dtype=np.uint8)
    disabled = np.array([not l.get("enabled", True) for l in layers])

    key = None
    if disabled.any():
        kept = out[~disabled].astype(np.int32)
        def clearance(c):
            return np.linalg.norm(kept - np.array(c), axis=1).min() if len(kept) else 1e9
        key = max(_KEY_CANDIDATES, key=clearance)
        out[disabled] = key

    pal_img = Image.new("P", (1, 1))
    flat = src.ravel().tolist()
    # Pad with the first color so unused slots never win the nearest match.
    flat += flat[:3] * (256 - len(layers))
    pal_img.putpalette(flat)
    idx = np.asarray(img.convert("RGB").quantize(palette=pal_img, dither=Image.Dither.NONE))
    return Image.fromarray(out[idx], "RGB"), (_hex(key) if key else None)


# How far (RGB distance) a traced fill may drift from the key color and still
# be removed. The tracer averages merged speckles into a region's color, so
# the key region's fill can shift slightly; keys sit far from real colors.
KEY_MATCH_DIST = 40

_PATH_WITH_FILL = re.compile(r'<path\b[^>]*?\bfill="(#[0-9a-fA-F]{6})"[^>]*?/>\s*')


def remove_key_paths(svg: str, key: str | None) -> str:
    """Drop traced shapes painted with the key color (the disabled layers)."""
    if not key:
        return svg
    k = np.array(_hex_to_rgb(key))
    def keep(m):
        near = np.linalg.norm(np.array(_hex_to_rgb(m.group(1))) - k) < KEY_MATCH_DIST
        return "" if near else m.group(0)
    return _PATH_WITH_FILL.sub(keep, svg)


def extract_palette(img: Image.Image, n: int = 16) -> list[str]:
    """Return up to n dominant hex colors from the image."""
    small = img.convert("RGB").resize((200, 200), Image.LANCZOS)
    quantized = small.quantize(colors=n, method=Image.Quantize.MEDIANCUT, dither=0)
    palette_data = quantized.getpalette()  # flat R,G,B list
    counts = Counter(quantized.getdata())
    # Sort by frequency
    sorted_colors = sorted(counts.keys(), key=lambda idx: -counts[idx])
    result = []
    for idx in sorted_colors[:n]:
        r = palette_data[idx * 3]
        g = palette_data[idx * 3 + 1]
        b = palette_data[idx * 3 + 2]
        result.append(f"#{r:02x}{g:02x}{b:02x}")
    return result


def _parse_svg_length_raw(value: str) -> float:
    """Parse an SVG length attribute into a numeric value (unit suffix stripped)."""
    if not value:
        return float("nan")
    m = re.match(r"^\s*([+-]?[\d.]+)\s*([a-zA-Z%]*)\s*$", value.strip())
    if not m:
        return float("nan")
    return float(m.group(1))


def parse_svg_user_units(svg_str: str) -> tuple[float, float]:
    """Return (width, height) in SVG user units from viewBox or width/height attrs.

    Prefers viewBox (true user-space units). Falls back to width/height when no
    viewBox is present — typical for Inkscape exports that always include one.
    """
    try:
        root = ET.fromstring(svg_str)
    except ET.ParseError as exc:
        raise ValueError(f"Invalid SVG: {exc}") from exc

    if not root.tag.endswith("svg"):
        raise ValueError("Not an SVG document")

    vb = root.get("viewBox") or root.get("viewbox")
    if vb:
        parts = re.split(r"[\s,]+", vb.strip())
        if len(parts) >= 4:
            w, h = float(parts[2]), float(parts[3])
            if w > 0 and h > 0:
                return w, h

    w_attr = root.get("width")
    h_attr = root.get("height")
    if w_attr and h_attr:
        w = _parse_svg_length_raw(w_attr)
        h = _parse_svg_length_raw(h_attr)
        if w > 0 and h > 0:
            return w, h

    raise ValueError("SVG is missing viewBox or width/height")


def is_svg_bytes(data: bytes) -> bool:
    """Heuristic: true when bytes look like an SVG document."""
    # Strip a UTF-8 BOM and leading whitespace; an SVG must begin with markup.
    # (Raster files like PNG can embed "<svg" in XMP metadata, so a bare
    # substring search is not enough.)
    head = data[:4096].removeprefix(b"\xef\xbb\xbf").lstrip()
    if not head.startswith(b"<"):
        return False
    if b"\x00" in head:
        return False
    return head.startswith(b"<svg") or b"<svg" in head[:2048]


def extract_palette_from_svg(svg_str: str) -> list[dict]:
    """Parse all fill="#rrggbb" and fill="rgb(r,g,b)" values from an SVG.
    Returns list of {color, count} sorted by descending count.
    """
    hex_colors = re.findall(r'fill="(#[0-9a-fA-F]{6})"', svg_str)
    rgb_colors_raw = re.findall(r'fill="rgb\((\d+),\s*(\d+),\s*(\d+)\)"', svg_str)
    rgb_colors = [f"#{int(r):02x}{int(g):02x}{int(b):02x}"
                  for r, g, b in rgb_colors_raw]

    all_colors = [c.lower() for c in hex_colors] + rgb_colors
    counter = Counter(all_colors)

    # Exclude pure white and black from the palette panel (not useful to edit)
    excluded = {"#ffffff", "#000000"}
    result = [
        {"color": color, "count": count}
        for color, count in counter.most_common()
        if color not in excluded
    ]
    # Put white/black at the end if present
    for color in ("#ffffff", "#000000"):
        if color in counter:
            result.append({"color": color, "count": counter[color]})

    return result
