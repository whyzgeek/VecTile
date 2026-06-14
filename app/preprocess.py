"""
Image preprocessing utilities: quantize, palette extraction, resize, SVG palette parsing.
"""
import re
import xml.etree.ElementTree as ET
from collections import Counter
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
    head = data[:4096].lstrip()
    if not head:
        return False
    if head.startswith(b"<?xml") or head.startswith(b"<svg"):
        return True
    return b"<svg" in head[:2048]


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
