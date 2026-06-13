"""
Potrace-style engine — best for B&W logos, line art, sketches, and laser-cut prep.
Uses vtracer in binary/spline mode with Pillow preprocessing (threshold, invert, sharpen)
to produce crisp single-color output without requiring native libpotrace.
"""
import tempfile
import os
import vtracer
from PIL import Image, ImageFilter, ImageEnhance
from .base import int_param, float_param, bool_param, select_param

_DEFAULTS = {
    "threshold": 128,
    "invert": False,
    "sharpen": True,
    "filter_speckle": 8,
    "corner_threshold": 60,
    "length_threshold": 3.0,
    "splice_threshold": 45,
    "path_precision": 8,
    "mode": "spline",
}


class PotraceEngine:
    name = "potrace"
    description = "Best for B&W logos, line art, sketches and laser-cut prep"
    param_schema = [
        int_param("threshold", "Threshold", 128, 0, 255,
                  hint="Pixels darker than this become black; lighter become white"),
        bool_param("invert", "Invert", False,
                   hint="Swap black and white before tracing"),
        bool_param("sharpen", "Sharpen edges", True,
                   hint="Apply edge sharpening before thresholding for crisper results"),
        select_param("mode", "Curve Mode", "spline",
                     [{"value": "spline", "label": "Spline (smooth)"},
                      {"value": "polygon", "label": "Polygon (sharp)"}],
                     "How path edges are approximated"),
        int_param("filter_speckle", "Filter Speckle", 8, 0, 128,
                  hint="Discard regions smaller than this many pixels"),
        int_param("corner_threshold", "Corner Threshold", 60, 0, 180,
                  hint="Angle below which corners are preserved"),
        float_param("length_threshold", "Length Threshold", 3.0, 0.0, 10.0, 0.5,
                    hint="Minimum path segment length"),
        int_param("splice_threshold", "Splice Threshold", 45, 0, 180,
                  hint="Angle at which to splice a curve segment"),
        int_param("path_precision", "Path Precision", 8, 1, 8,
                  hint="Decimal places in SVG path coordinates"),
    ]

    def vectorize(self, image_path: str, params: dict) -> str:
        merged = {**_DEFAULTS, **params}

        img = Image.open(image_path).convert("RGBA")
        # Composite over white so transparent areas become white
        bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
        bg.paste(img, mask=img.split()[3])
        img = bg.convert("RGB")

        # Optionally sharpen
        if merged.get("sharpen", True):
            img = img.filter(ImageFilter.SHARPEN)
            img = ImageEnhance.Contrast(img).enhance(1.3)

        # Convert to grayscale → binary via threshold
        gray = img.convert("L")
        threshold = int(merged["threshold"])
        binary = gray.point(lambda p: 255 if p > threshold else 0, "L")

        if merged.get("invert", False):
            binary = binary.point(lambda p: 255 - p, "L")

        # Convert back to RGB so vtracer accepts it
        rgb_binary = binary.convert("RGB")

        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tf:
            in_path = tf.name
        with tempfile.NamedTemporaryFile(suffix=".svg", delete=False) as tf:
            out_path = tf.name

        try:
            rgb_binary.save(in_path)
            vtracer.convert_image_to_svg_py(
                in_path,
                out_path,
                colormode="binary",
                hierarchical="stacked",
                mode=str(merged.get("mode", "spline")),
                filter_speckle=int(merged["filter_speckle"]),
                color_precision=1,
                layer_difference=128,
                corner_threshold=int(merged["corner_threshold"]),
                length_threshold=float(merged["length_threshold"]),
                splice_threshold=int(merged["splice_threshold"]),
                path_precision=int(merged["path_precision"]),
            )
            with open(out_path, "r", encoding="utf-8") as f:
                return f.read()
        finally:
            for p in (in_path, out_path):
                if os.path.exists(p):
                    os.unlink(p)
