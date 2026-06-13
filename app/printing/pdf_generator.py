"""Top-level PDF generation for tiled poster printing.

Stitches together:
  - svglib (parse the source SVG into a reportlab Drawing)
  - tiler (compute the page grid)
  - reportlab.pdfgen.canvas (draw each tile on its own page)
  - decorations (overlay crop marks, page labels, etc.)

The drawing approach for each tile:
  1. Save the canvas state.
  2. Set a clip rectangle to the printable area.
  3. Translate so the drawing's bottom-left ends up at the right offset on
     the page so only the tile's portion of the source image is visible
     inside the printable area.
  4. Apply uniform scale (poster size in mm -> source SVG units).
  5. Draw the full Drawing at (0, 0) - the clip ensures only the tile shows.
  6. Restore state, then draw decorations on top.
"""
from __future__ import annotations

import io
from dataclasses import dataclass, field
from typing import Optional

from reportlab.graphics import renderPDF
from reportlab.pdfgen.canvas import Canvas
from svglib.svglib import svg2rlg

from . import decorations as deco
from .decorations import MM_TO_PT, Layout, make_layout
from .paper_sizes import get_paper_size
from .tiler import TileGrid, compute_grid

# Print bleed in mm — image content extends this far past the printable area
# on every side so a slightly imprecise cut still has image right up to the
# edge instead of a white halo. The user trims along the crop marks (which
# remain at the printable-area corners) and any small inaccuracy is forgiven.
BLEED_MM = 3.0


@dataclass
class PrintSettings:
    """All knobs the UI exposes for the Print tab."""
    paper_name: str = "A4"               # one of PAPER_SIZES, or "Custom"
    paper_w_mm: Optional[float] = None    # used when paper_name == "Custom"
    paper_h_mm: Optional[float] = None
    orientation: str = "portrait"         # "portrait" | "landscape"
    poster_w_mm: float = 420.0            # final printed dimensions
    poster_h_mm: float = 594.0
    overlap_mm: float = 10.0
    margin_mm: float = 10.0
    single_page: bool = False             # if True, ignore tile grid and use one page

    # Image placement on the poster. All in poster-mm coords (top-left origin,
    # y growing down). When the three core fields are None, the PDF generator
    # falls back to the legacy "fit-contain, centered" behavior. The frontend
    # computes these explicitly so the preview and the PDF stay in lockstep.
    image_x_mm: Optional[float] = None
    image_y_mm: Optional[float] = None
    image_scale: Optional[float] = None   # mm per source-SVG user unit
    image_rotation_deg: float = 0.0       # rotates the image around its centre

    # Grid offset (mm) — slides the tile boundaries on the poster so the user
    # can choose where page seams fall relative to image features. Positive x
    # shifts the grid right, positive y shifts down.
    grid_offset_x_mm: float = 0.0
    grid_offset_y_mm: float = 0.0

    decorations: dict = field(default_factory=lambda: {
        "overlap_shade": True,
        "crop_marks": True,
        "page_labels": True,
        "registration_marks": True,
        "scale_indicator": True,
        "border_box": True,
    })


def _resolve_paper(settings: PrintSettings) -> tuple[float, float]:
    if settings.paper_name == "Custom":
        if not settings.paper_w_mm or not settings.paper_h_mm:
            raise ValueError("Custom paper requires paper_w_mm and paper_h_mm")
        return settings.paper_w_mm, settings.paper_h_mm
    return get_paper_size(settings.paper_name)


def compute_settings_grid(svg_view_w: float, svg_view_h: float,
                           settings: PrintSettings) -> TileGrid:
    """Convenience: resolve paper preset + run compute_grid."""
    paper_w, paper_h = _resolve_paper(settings)
    return compute_grid(
        svg_view_w=svg_view_w,
        svg_view_h=svg_view_h,
        paper_w_mm=paper_w,
        paper_h_mm=paper_h,
        poster_w_mm=settings.poster_w_mm,
        poster_h_mm=settings.poster_h_mm,
        overlap_mm=settings.overlap_mm,
        margin_mm=settings.margin_mm,
        orientation=settings.orientation,
        single_page=settings.single_page,
        grid_offset_x_mm=settings.grid_offset_x_mm,
        grid_offset_y_mm=settings.grid_offset_y_mm,
    )


def _drawing_from_svg(svg_str: str):
    """Parse SVG bytes into a reportlab Drawing. Returns the Drawing."""
    fp = io.StringIO(svg_str)
    drawing = svg2rlg(fp)
    if drawing is None:
        raise ValueError("Failed to parse SVG (svglib returned None)")
    return drawing


def _draw_tile(canvas: Canvas, drawing, grid: TileGrid, tile, settings: PrintSettings) -> None:
    """Draw one page: clipped SVG content + decorations."""
    layout = make_layout(grid)

    # Native drawing extents — svglib gives the Drawing in PDF points already.
    dwg_w = float(drawing.width) if drawing.width else 1.0
    dwg_h = float(drawing.height) if drawing.height else 1.0

    # ---- Image placement on the poster (in mm) ------------------------------
    if (settings.image_scale is not None
            and settings.image_x_mm is not None
            and settings.image_y_mm is not None):
        # Explicit placement from the UI (WYSIWYG path)
        img_scale_mm_per_unit = float(settings.image_scale)
        img_x_mm = float(settings.image_x_mm)
        img_y_mm = float(settings.image_y_mm)  # top-left in y-down poster coords
    else:
        # Legacy fallback: fit-contain, centered.
        img_scale_mm_per_unit = min(grid.poster_w_mm / dwg_w, grid.poster_h_mm / dwg_h)
        img_x_mm = (grid.poster_w_mm - dwg_w * img_scale_mm_per_unit) / 2.0
        img_y_mm = (grid.poster_h_mm - dwg_h * img_scale_mm_per_unit) / 2.0

    img_scale_pt_per_unit = img_scale_mm_per_unit * MM_TO_PT  # what canvas.scale() needs
    dwg_h_drawn_mm = dwg_h * img_scale_mm_per_unit

    # Drawing's bottom-left on the poster, in pt (PDF y-up: top of poster = high y).
    img_bl_x_poster_pt = img_x_mm * MM_TO_PT
    img_bl_y_poster_pt = (grid.poster_h_mm - img_y_mm - dwg_h_drawn_mm) * MM_TO_PT

    # Tile's bottom-left in poster coords (PDF y-up).
    tile_bl_x_pt = tile.poster_x_mm * MM_TO_PT
    tile_bl_y_pt = (grid.poster_h_mm - tile.poster_y_mm - tile.printable_h_mm) * MM_TO_PT

    # On the actual page, the drawing's bottom-left lands at:
    page_dwg_x = layout.x_left + img_bl_x_poster_pt - tile_bl_x_pt
    page_dwg_y = layout.y_bottom + img_bl_y_poster_pt - tile_bl_y_pt
    scale = img_scale_pt_per_unit

    # ---- 1. Overlap shading is intentionally a PREVIEW-ONLY guide. -----------
    # We don't draw it in the printed PDF because anything drawn here would
    # appear on top of the artwork in the overlap zone, defeating the purpose
    # of a clean printed surface for gluing.

    # ---- 2. Clipped, scaled, translated, rotated SVG content ---------------
    # Clip to the printable area PLUS a small bleed on every side, but never
    # past the physical paper bounds. Image content can flow into the safe
    # margin slightly so cuts on the trim line don't show white halos.
    canvas.saveState()
    bleed_pt = BLEED_MM * MM_TO_PT
    clip_left   = max(0.0, layout.x_left - bleed_pt)
    clip_bottom = max(0.0, layout.y_bottom - bleed_pt)
    clip_right  = min(layout.page_w_pt, layout.x_right + bleed_pt)
    clip_top    = min(layout.page_h_pt, layout.y_top + bleed_pt)
    clip = canvas.beginPath()
    clip.rect(clip_left, clip_bottom, clip_right - clip_left, clip_top - clip_bottom)
    canvas.clipPath(clip, stroke=0, fill=0)

    rot = float(getattr(settings, "image_rotation_deg", 0.0) or 0.0)
    if rot != 0.0:
        # Rotate around the image's centre on the page. Centre of the
        # drawn image (pre-rotation) sits at the bottom-left + half size in pt.
        cx_pt = page_dwg_x + (dwg_w * scale) / 2.0
        cy_pt = page_dwg_y + (dwg_h * scale) / 2.0
        canvas.translate(cx_pt, cy_pt)
        canvas.rotate(rot)
        canvas.translate(-cx_pt, -cy_pt)

    canvas.translate(page_dwg_x, page_dwg_y)
    canvas.scale(scale, scale)
    renderPDF.draw(drawing, canvas, 0, 0)

    canvas.restoreState()

    # ---- 3. Decorations over the art ---------------------------------------
    if settings.decorations.get("border_box", True):
        deco.draw_border_box(canvas, layout)
    if settings.decorations.get("registration_marks", True):
        deco.draw_registration_marks(canvas, layout, tile, grid)
    if settings.decorations.get("crop_marks", True):
        deco.draw_crop_marks(canvas, layout)
    if settings.decorations.get("page_labels", True):
        deco.draw_page_label(canvas, layout, tile, grid)
    if settings.decorations.get("scale_indicator", True):
        deco.draw_scale_indicator(canvas, layout, grid)


def build_pdf(svg_str: str, settings: PrintSettings) -> bytes:
    """Generate a multi-page PDF for the given SVG and print settings."""
    drawing = _drawing_from_svg(svg_str)

    grid = compute_settings_grid(
        svg_view_w=float(drawing.width or 1.0),
        svg_view_h=float(drawing.height or 1.0),
        settings=settings,
    )

    buf = io.BytesIO()
    page_size_pt = (grid.paper_w_mm * MM_TO_PT, grid.paper_h_mm * MM_TO_PT)
    canvas = Canvas(buf, pagesize=page_size_pt)
    canvas.setTitle("Vectile Poster")

    for tile in grid.tiles:
        canvas.setPageSize(page_size_pt)
        _draw_tile(canvas, drawing, grid, tile, settings)
        canvas.showPage()

    canvas.save()
    return buf.getvalue()
