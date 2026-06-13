"""
VTracer engine — best for color images, illustrations, and photos.
Uses the `vtracer` Python binding (prebuilt wheels on all platforms).
"""
import tempfile
import os
import vtracer
from .base import int_param, float_param, select_param

_ALLOWED = {
    "colormode", "hierarchical", "mode",
    "filter_speckle", "color_precision", "layer_difference",
    "corner_threshold", "length_threshold", "splice_threshold", "path_precision",
}

_DEFAULTS = {
    "colormode": "color",
    "hierarchical": "stacked",
    "mode": "spline",
    "filter_speckle": 4,
    "color_precision": 6,
    "layer_difference": 16,
    "corner_threshold": 60,
    "length_threshold": 4.0,
    "splice_threshold": 45,
    "path_precision": 8,
}


class VtracerEngine:
    name = "vtracer"
    description = "Best for color images, illustrations and photos"
    param_schema = [
        select_param("colormode", "Color Mode", "color",
                     [{"value": "color", "label": "Color"},
                      {"value": "binary", "label": "Binary (B&W)"}],
                     "Color traces all hues; Binary reduces to black paths"),
        select_param("hierarchical", "Hierarchy", "stacked",
                     [{"value": "stacked", "label": "Stacked"},
                      {"value": "cutout", "label": "Cutout"}],
                     "Stacked layers paths; Cutout creates holes"),
        select_param("mode", "Curve Mode", "spline",
                     [{"value": "spline", "label": "Spline (smooth)"},
                      {"value": "polygon", "label": "Polygon (sharp)"},
                      {"value": "none", "label": "Pixel (no curves)"}],
                     "How path edges are approximated"),
        int_param("filter_speckle", "Filter Speckle", 4, 0, 128,
                  hint="Discard regions smaller than this many pixels"),
        int_param("color_precision", "Color Precision", 6, 1, 8,
                  hint="Number of significant bits per channel (lower = fewer colors)"),
        int_param("layer_difference", "Layer Difference", 16, 0, 256,
                  hint="Minimum color difference to split into separate layers"),
        int_param("corner_threshold", "Corner Threshold", 60, 0, 180,
                  hint="Angle in degrees below which corners are preserved"),
        float_param("length_threshold", "Length Threshold", 4.0, 0.0, 10.0, 0.5,
                    hint="Minimum path segment length"),
        int_param("splice_threshold", "Splice Threshold", 45, 0, 180,
                  hint="Angle at which to splice a curve segment"),
        int_param("path_precision", "Path Precision", 8, 1, 8,
                  hint="Decimal places in SVG path coordinates"),
    ]

    def vectorize(self, image_path: str, params: dict) -> str:
        merged = {**_DEFAULTS, **{k: v for k, v in params.items() if k in _ALLOWED}}

        with tempfile.NamedTemporaryFile(suffix=".svg", delete=False) as tf:
            out_path = tf.name

        try:
            vtracer.convert_image_to_svg_py(
                image_path,
                out_path,
                colormode=merged["colormode"],
                hierarchical=merged["hierarchical"],
                mode=merged["mode"],
                filter_speckle=int(merged["filter_speckle"]),
                color_precision=int(merged["color_precision"]),
                layer_difference=int(merged["layer_difference"]),
                corner_threshold=int(merged["corner_threshold"]),
                length_threshold=float(merged["length_threshold"]),
                splice_threshold=int(merged["splice_threshold"]),
                path_precision=int(merged["path_precision"]),
            )
            with open(out_path, "r", encoding="utf-8") as f:
                return f.read()
        finally:
            if os.path.exists(out_path):
                os.unlink(out_path)
