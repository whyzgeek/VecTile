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
import re
from dataclasses import dataclass, field
from typing import Optional

from reportlab.graphics import renderPDF
from reportlab.pdfgen.canvas import Canvas
from svglib.svglib import svg2rlg

from . import decorations as deco
from .decorations import MM_TO_PT, Layout, make_layout
from .paper_sizes import get_paper_size
from .tiler import TileGrid, compute_grid, poster_intersection_mm, _maybe_swap


@dataclass
class PrintSettings:
    """All knobs the UI exposes for the Print tab."""
    paper_name: str = "Letter"           # one of PAPER_SIZES, or "Custom"
    paper_w_mm: Optional[float] = None    # used when paper_name == "Custom"
    paper_h_mm: Optional[float] = None
    orientation: str = "portrait"         # "portrait" | "landscape"
    poster_w_mm: float = 420.0            # final printed dimensions
    poster_h_mm: float = 594.0
    overlap_mm: float = 2.0               # image overlap / slack (glue strip absorbs the margin)
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
    poster_mode: str = "dimensions"  # "grid" | "dimensions" | "scale"
    grid_cols: int | None = None
    grid_rows: int | None = None
    trim_guides_to_poster: bool = True  # hide guides on the poster's outer edge

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


def _poster_mm_for_settings(settings: PrintSettings) -> tuple[float, float]:
    """Poster canvas size in mm.

    Single-page mode: the printable area of the chosen paper sheet.
    Tile mode: explicit poster dimensions from the UI (grid / dimensions / scale).
    """
    if settings.single_page:
        paper_w, paper_h = _resolve_paper(settings)
        paper_w, paper_h = _maybe_swap(paper_w, paper_h, settings.orientation)
        m = settings.margin_mm
        return max(1.0, paper_w - 2 * m), max(1.0, paper_h - 2 * m)
    return settings.poster_w_mm, settings.poster_h_mm


def compute_settings_grid(svg_view_w: float, svg_view_h: float,
                           settings: PrintSettings) -> TileGrid:
    """Convenience: resolve paper preset + run compute_grid."""
    paper_w, paper_h = _resolve_paper(settings)
    poster_w, poster_h = _poster_mm_for_settings(settings)
    return compute_grid(
        svg_view_w=svg_view_w,
        svg_view_h=svg_view_h,
        paper_w_mm=paper_w,
        paper_h_mm=paper_h,
        poster_w_mm=poster_w,
        poster_h_mm=poster_h,
        overlap_mm=settings.overlap_mm,
        margin_mm=settings.margin_mm,
        orientation=settings.orientation,
        single_page=settings.single_page,
        grid_offset_x_mm=settings.grid_offset_x_mm,
        grid_offset_y_mm=settings.grid_offset_y_mm,
        poster_mode=settings.poster_mode,
        grid_cols=settings.grid_cols,
        grid_rows=settings.grid_rows,
    )


def _drawing_from_svg(svg_str: str):
    """Parse SVG bytes into a reportlab Drawing. Returns the Drawing."""
    fp = io.StringIO(svg_str)
    drawing = svg2rlg(fp)
    if drawing is None:
        raise ValueError("Failed to parse SVG (svglib returned None)")
    return drawing


def _parse_svg_viewbox_dims(svg_str: str) -> tuple[float, float] | None:
    m = re.search(r'viewBox\s*=\s*["\']([^"\']+)["\']', svg_str, re.I)
    if m:
        parts = [float(x) for x in re.split(r"[\s,]+", m.group(1).strip()) if x]
        if len(parts) == 4 and parts[2] > 0 and parts[3] > 0:
            return parts[2], parts[3]
    m = re.search(r'width\s*=\s*["\']?([\d.]+)', svg_str, re.I)
    n = re.search(r'height\s*=\s*["\']?([\d.]+)', svg_str, re.I)
    if m and n:
        w, h = float(m.group(1)), float(n.group(1))
        if w > 0 and h > 0:
            return w, h
    return None


def _svg_user_units(svg_str: str, drawing) -> tuple[float, float]:
    """Return SVG user-space width/height (viewBox when present).

    svglib honors inline CSS width/height and can shrink the Drawing to the
    on-screen preview size. Placement math must use viewBox units instead.
    """
    dims = _parse_svg_viewbox_dims(svg_str)
    if dims:
        return dims
    return float(drawing.width or 1.0), float(drawing.height or 1.0)


def _prepare_svg_for_pdf(svg_str: str) -> str:
    """Strip preview CSS and ensure width/height match viewBox for svglib."""
    dims = _parse_svg_viewbox_dims(svg_str)
    # Drop inline style on the root <svg> — preview tabs set pixel width/height here.
    svg_str = re.sub(
        r"(<svg\b[^>]*?)\sstyle=(['\"])[^'\"]*\2",
        r"\1",
        svg_str,
        count=1,
        flags=re.I | re.S,
    )
    if not dims:
        return svg_str
    user_w, user_h = dims

    def _set_attr(text: str, name: str, value: float) -> str:
        pat = rf'{name}\s*=\s*["\'][^"\']*["\']'
        repl = f'{name}="{value:g}"'
        if re.search(pat, text, re.I):
            return re.sub(pat, repl, text, count=1, flags=re.I)
        return re.sub(r"(<svg\b)", rf'\1 {repl}', text, count=1, flags=re.I)

    svg_str = _set_attr(svg_str, "width", user_w)
    svg_str = _set_attr(svg_str, "height", user_h)
    return svg_str


def _draw_tile(canvas: Canvas, drawing, grid: TileGrid, tile, settings: PrintSettings,
               *, svg_user_w: float, svg_user_h: float) -> None:
    """Draw one page: clipped SVG content + decorations."""
    layout = make_layout(grid)

    # User-space extents — must match the viewBox the UI used for placement.
    dwg_w = svg_user_w
    dwg_h = svg_user_h

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
    canvas.saveState()

    inter = None
    if settings.trim_guides_to_poster:
        inter = poster_intersection_mm(tile, grid.poster_w_mm, grid.poster_h_mm)
        if inter is None:
            canvas.restoreState()
            return

    clip = canvas.beginPath()
    clip.rect(layout.x_left, layout.y_bottom,
              layout.printable_w_pt, layout.printable_h_pt)
    canvas.clipPath(clip, stroke=0, fill=0)

    if inter is not None:
        ix, iy, iw, ih = inter
        bx, by, bw, bh = deco.intersection_on_page_pt(layout, tile, ix, iy, iw, ih)
        poster_clip = canvas.beginPath()
        poster_clip.rect(bx, by, bw, bh)
        canvas.clipPath(poster_clip, stroke=0, fill=0)

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

    # ---- 3. Decorations — overlap bands only (hidden after trim/tape) --------
    if settings.single_page or grid.overlap_mm <= 0:
        return

    if settings.decorations.get("border_box", True):
        deco.draw_cut_lines(canvas, layout, tile, grid)
        deco.draw_glue_lines(canvas, layout, tile, grid)
    if settings.decorations.get("registration_marks", True):
        deco.draw_overlap_registration_marks(canvas, layout, tile, grid)
    if settings.decorations.get("page_labels", True):
        deco.draw_page_label_in_overlap(canvas, layout, tile, grid)
    if settings.decorations.get("scale_indicator", True):
        deco.draw_overlap_scale_indicator(canvas, layout, tile, grid)


def build_pdf(svg_str: str, settings: PrintSettings) -> bytes:
    """Generate a multi-page PDF for the given SVG and print settings."""
    svg_str = _prepare_svg_for_pdf(svg_str)
    drawing = _drawing_from_svg(svg_str)
    svg_w, svg_h = _svg_user_units(svg_str, drawing)

    grid = compute_settings_grid(
        svg_view_w=svg_w,
        svg_view_h=svg_h,
        settings=settings,
    )

    buf = io.BytesIO()
    page_size_pt = (grid.paper_w_mm * MM_TO_PT, grid.paper_h_mm * MM_TO_PT)
    canvas = Canvas(buf, pagesize=page_size_pt)
    canvas.setTitle("Vectile Poster")

    for tile in grid.tiles:
        if settings.trim_guides_to_poster:
            if poster_intersection_mm(tile, grid.poster_w_mm, grid.poster_h_mm) is None:
                continue
        canvas.setPageSize(page_size_pt)
        _draw_tile(canvas, drawing, grid, tile, settings,
                   svg_user_w=svg_w, svg_user_h=svg_h)
        canvas.showPage()

    canvas.save()
    return buf.getvalue()
