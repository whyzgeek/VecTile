"""
Image preprocessing utilities: quantize, palette extraction, resize, SVG palette parsing.
"""
import re
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
