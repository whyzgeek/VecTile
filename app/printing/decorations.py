"""Decoration drawing routines for printed tiles.

Each function operates on a reportlab Canvas whose origin (0, 0) is the
*bottom-left of the page* (reportlab's native coordinate system) and assumes
the canvas units are PDF points (1 mm = 2.83465 points).

All functions accept a `Layout` describing the page's printable area, plus
the relevant grid for context (used for things like page labels and
registration marks at interior corners only).

Decorations are intentionally subtle: faint grey, thin strokes, small labels,
so they don't compete with the printed art.
"""
from __future__ import annotations

from dataclasses import dataclass

from reportlab.lib.colors import Color
from reportlab.pdfgen.canvas import Canvas

from .tiler import TileGrid, TileRect, page_label

MM_TO_PT = 2.83464566929  # 1 mm in PDF points

# A margin narrower than this (pt) has no room for assembly text labels.
_MIN_LABEL_MARGIN_PT = 6.0

_GREY = Color(0.55, 0.55, 0.55)
_FAINT = Color(0.78, 0.78, 0.78)
_OVERLAP_FILL = Color(0.0, 0.45, 0.85, alpha=0.06)

# Prefer discard strips (right/bottom) so labels vanish after trim/tape;
# fall back to covering strips (left/top) on edge tiles with no discard band.
_LABEL_STRIP_PRIORITY = ("bottom", "right", "left", "top")


@dataclass
class OverlapStrip:
    """One overlap band on a tile page, in PDF point units (origin bottom-left)."""
    edge: str  # left | right | top | bottom
    x: float
    y: float
    w: float
    h: float


@dataclass
class Layout:
    """Geometry of the current page in PDF point units."""
    page_w_pt: float
    page_h_pt: float
    margin_pt: float
    printable_w_pt: float
    printable_h_pt: float

    @property
    def x_left(self) -> float:
        return self.margin_pt

    @property
    def x_right(self) -> float:
        return self.margin_pt + self.printable_w_pt

    @property
    def y_bottom(self) -> float:
        return self.margin_pt

    @property
    def y_top(self) -> float:
        return self.margin_pt + self.printable_h_pt


def make_layout(grid: TileGrid) -> Layout:
    return Layout(
        page_w_pt=grid.paper_w_mm * MM_TO_PT,
        page_h_pt=grid.paper_h_mm * MM_TO_PT,
        margin_pt=grid.margin_mm * MM_TO_PT,
        printable_w_pt=grid.printable_w_mm * MM_TO_PT,
        printable_h_pt=grid.printable_h_mm * MM_TO_PT,
    )


def intersection_on_page_pt(
    layout: Layout, tile: TileRect,
    ix: float, iy: float, iw: float, ih: float,
) -> tuple[float, float, float, float]:
    """Map a poster-mm intersection rect to page PDF points (x, y_bottom, w, h)."""
    x_left = layout.x_left + (ix - tile.poster_x_mm) * MM_TO_PT
    y_top = layout.y_top - (iy - tile.poster_y_mm) * MM_TO_PT
    w_pt = iw * MM_TO_PT
    h_pt = ih * MM_TO_PT
    return (x_left, y_top - h_pt, w_pt, h_pt)


def overlap_strips(layout: Layout, tile: TileRect, grid: TileGrid) -> list[OverlapStrip]:
    """Overlap bands on this tile — the only zones where printed guides may appear."""
    if grid.overlap_mm <= 0:
        return []
    o = grid.overlap_mm * MM_TO_PT
    strips: list[OverlapStrip] = []
    if tile.col < grid.cols - 1:
        strips.append(OverlapStrip("right", layout.x_right - o, layout.y_bottom, o, layout.printable_h_pt))
    if tile.col > 0:
        strips.append(OverlapStrip("left", layout.x_left, layout.y_bottom, o, layout.printable_h_pt))
    if tile.row > 0:
        strips.append(OverlapStrip("top", layout.x_left, layout.y_top - o, layout.printable_w_pt, o))
    if tile.row < grid.rows - 1:
        strips.append(OverlapStrip("bottom", layout.x_left, layout.y_bottom, layout.printable_w_pt, o))
    return strips


def _pick_label_strip(strips: list[OverlapStrip]) -> OverlapStrip | None:
    by_edge = {s.edge: s for s in strips}
    for edge in _LABEL_STRIP_PRIORITY:
        if edge in by_edge:
            return by_edge[edge]
    return None


def _discard_strips(strips: list[OverlapStrip]) -> list[OverlapStrip]:
    """Overlap bands on the page you trim away (right + bottom)."""
    return [s for s in strips if s.edge in ("bottom", "right")]


def _strip_text_position(strip: OverlapStrip, role: str) -> tuple[float, float]:
    """Place label and scale in the same band without overlapping."""
    cx = strip.x + strip.w / 2
    cy = strip.y + strip.h / 2
    if strip.edge in ("left", "right"):
        offset = strip.h * 0.22
        cy += offset if role == "label" else -offset
    else:
        offset = strip.w * 0.22
        cx -= offset if role == "label" else offset
    return cx, cy


def _draw_text_in_assembly_margin(
    canvas: Canvas, layout: Layout, edge: str, text: str,
    *, font: str = "Helvetica-Bold", size: float = 6.5,
    along: float = 0.16,
) -> None:
    """Draw text in a cut or glue margin, offset along the edge from CUT/GLUE."""
    m = layout.margin_pt
    if m < _MIN_LABEL_MARGIN_PT:
        return
    canvas.saveState()
    canvas.setFillColor(_GREY)
    canvas.setFont(font, size)
    if edge == "left":
        y = layout.y_bottom + layout.printable_h_pt * along
        canvas.translate(layout.x_left - m / 2, y)
        canvas.rotate(90)
        canvas.drawCentredString(0, -2.0, text)
    elif edge == "right":
        y = layout.y_bottom + layout.printable_h_pt * along
        canvas.translate(layout.x_right + m / 2, y)
        canvas.rotate(90)
        canvas.drawCentredString(0, -2.0, text)
    elif edge == "top":
        x = layout.x_left + layout.printable_w_pt * along
        canvas.drawCentredString(x, layout.y_top + m / 2 - 2.3, text)
    else:  # bottom
        x = layout.x_left + layout.printable_w_pt * along
        canvas.drawCentredString(x, layout.y_bottom - m / 2 - 2.3, text)
    canvas.restoreState()


def _tile_shows_scale(tile: TileRect, grid: TileGrid) -> bool:
    """Show the poster-size note once on the start tile's glue/cut margin."""
    if grid.total_pages <= 1:
        return False
    return tile.col == 0 and tile.row == 0


def _draw_edge_text(canvas: Canvas, text: str, edge: str, layout: Layout,
                    *, size: float = 5.5) -> None:
    """Write a small label centred in the margin (non-print area) along an edge.

    Runs vertically (rotated) on the left/right edges, horizontally on the
    top/bottom edges. Skipped if the margin is too narrow to hold text.
    """
    m = layout.margin_pt
    if m < _MIN_LABEL_MARGIN_PT:
        return
    cx_mid = (layout.x_left + layout.x_right) / 2
    cy_mid = (layout.y_bottom + layout.y_top) / 2
    canvas.saveState()
    canvas.setFillColor(_GREY)
    canvas.setFont("Helvetica-Bold", size)
    if edge == "left":
        canvas.translate(layout.x_left - m / 2, cy_mid)
        canvas.rotate(90)
        canvas.drawCentredString(0, -size * 0.35, text)
    elif edge == "right":
        canvas.translate(layout.x_right + m / 2, cy_mid)
        canvas.rotate(90)
        canvas.drawCentredString(0, -size * 0.35, text)
    elif edge == "top":
        canvas.drawCentredString(cx_mid, layout.y_top + m / 2 - size * 0.35, text)
    elif edge == "bottom":
        canvas.drawCentredString(cx_mid, layout.y_bottom - m / 2 - size * 0.35, text)
    canvas.restoreState()


def draw_cut_lines(canvas: Canvas, layout: Layout,
                   tile: TileRect, grid: TileGrid) -> None:
    """Cut guides on the covering edges (left if col>0, top if row>0).

    The line sits at the printable boundary (the image edge). Cut there to
    remove that white margin so the page's image reaches the edge, then lay it
    on top of the neighbour's glue strip. A "CUT HERE" label sits in the margin
    that gets discarded.
    """
    cuts_left = tile.col > 0
    cuts_top = tile.row > 0
    if not (cuts_left or cuts_top):
        return
    canvas.saveState()
    canvas.setStrokeColor(_FAINT)
    canvas.setLineWidth(0.5)
    canvas.setDash(3, 2)
    if cuts_left:
        canvas.line(layout.x_left, layout.y_bottom, layout.x_left, layout.y_top)
    if cuts_top:
        canvas.line(layout.x_left, layout.y_top, layout.x_right, layout.y_top)
    canvas.restoreState()
    if cuts_left:
        _draw_edge_text(canvas, "CUT HERE", "left", layout)
    if cuts_top:
        _draw_edge_text(canvas, "CUT HERE", "top", layout)


def draw_glue_lines(canvas: Canvas, layout: Layout,
                    tile: TileRect, grid: TileGrid) -> None:
    """Glue guides on the covered edges (right if col<cols-1, bottom if row<rows-1).

    The covered page is never cut. The glue line marks how far the neighbour's
    cut edge should reach (the inner edge of the glue strip = printable edge
    minus the image overlap/slack). The neighbour is glued on top, covering the
    strip and this page's white margin. A "GLUE HERE" label sits in the margin.
    """
    if grid.overlap_mm <= 0:
        return
    slack = grid.overlap_mm * MM_TO_PT
    glue_right = tile.col < grid.cols - 1
    glue_bottom = tile.row < grid.rows - 1
    if not (glue_right or glue_bottom):
        return
    canvas.saveState()
    canvas.setStrokeColor(_FAINT)
    canvas.setLineWidth(0.5)
    canvas.setDash(1, 2)
    if glue_right:
        x = layout.x_right - slack
        canvas.line(x, layout.y_bottom, x, layout.y_top)
    if glue_bottom:
        y = layout.y_bottom + slack
        canvas.line(layout.x_left, y, layout.x_right, y)
    canvas.restoreState()
    if glue_right:
        _draw_edge_text(canvas, "GLUE HERE", "right", layout)
    if glue_bottom:
        _draw_edge_text(canvas, "GLUE HERE", "bottom", layout)


def draw_overlap_registration_marks(canvas: Canvas, layout: Layout,
                                    tile: TileRect, grid: TileGrid,
                                    cross_len_mm: float = 2.0) -> None:
    """'+' alignment mark on the covered side, hidden under the neighbour.

    Placed at the glue-line crossing of the right + bottom edges so it sits in
    the glue strip that the next page covers, vanishing after assembly.
    """
    if grid.overlap_mm <= 0:
        return
    if not (tile.col < grid.cols - 1 and tile.row < grid.rows - 1):
        return
    slack = grid.overlap_mm * MM_TO_PT
    L = cross_len_mm * MM_TO_PT
    cx = layout.x_right - slack
    cy = layout.y_bottom + slack
    canvas.saveState()
    canvas.setStrokeColor(_GREY)
    canvas.setLineWidth(0.5)
    canvas.line(cx - L, cy, cx + L, cy)
    canvas.line(cx, cy - L, cx, cy + L)
    canvas.restoreState()


def _label_edge(tile: TileRect, grid: TileGrid) -> str | None:
    """Pick a margin that gets removed: a cut edge (left/top) or glue edge
    (right/bottom). Returns None only for a lone single tile."""
    if tile.col > 0:
        return "left"
    if tile.row > 0:
        return "top"
    if tile.col < grid.cols - 1:
        return "right"
    if tile.row < grid.rows - 1:
        return "bottom"
    return None


def draw_page_label_in_overlap(canvas: Canvas, layout: Layout,
                                 tile: TileRect, grid: TileGrid) -> None:
    """Page label in a cut or glue margin — trimmed or hidden after assembly."""
    edge = _label_edge(tile, grid)
    if edge is None:
        return
    text = f"{page_label(tile)} ({tile.page_index + 1}/{grid.total_pages})"
    _draw_text_in_assembly_margin(
        canvas, layout, edge, text, font="Helvetica-Bold", size=6.5, along=0.16,
    )


def draw_overlap_scale_indicator(canvas: Canvas, layout: Layout,
                                 tile: TileRect, grid: TileGrid) -> None:
    """Final poster size in a cut/glue margin on the start tile (once)."""
    if not _tile_shows_scale(tile, grid):
        return
    edge = _label_edge(tile, grid)
    if edge is None:
        return
    poster_w_in = grid.poster_w_mm / 25.4
    poster_h_in = grid.poster_h_mm / 25.4
    text = (
        f"{poster_w_in:.1f}\u00d7{poster_h_in:.1f} in "
        f"({grid.poster_w_mm:.0f}\u00d7{grid.poster_h_mm:.0f} mm)"
    )
    _draw_text_in_assembly_margin(
        canvas, layout, edge, text, font="Helvetica", size=5, along=0.84,
    )


def draw_registration_marks(canvas: Canvas, layout: Layout,
                            tile: TileRect, grid: TileGrid,
                            cross_len_mm: float = 4.0) -> None:
    """Small "+" symbols at every corner where this tile borders another tile.

    Drawn on the printable-area corners that touch interior grid intersections,
    so adjacent tiles overlay perfectly. The four-tile intersections are drawn
    on each of the four neighbours.
    """
    L = cross_len_mm * MM_TO_PT
    canvas.saveState()
    canvas.setStrokeColor(_GREY)
    canvas.setLineWidth(0.6)

    corners = [
        # (x, y, has_interior_corner_here?)
        (layout.x_left,  layout.y_bottom, tile.col > 0 and tile.row < grid.rows - 1),
        (layout.x_right, layout.y_bottom, tile.col < grid.cols - 1 and tile.row < grid.rows - 1),
        (layout.x_left,  layout.y_top,    tile.col > 0 and tile.row > 0),
        (layout.x_right, layout.y_top,    tile.col < grid.cols - 1 and tile.row > 0),
    ]
    for (cx, cy, draw) in corners:
        if not draw:
            continue
        canvas.line(cx - L, cy, cx + L, cy)
        canvas.line(cx, cy - L, cx, cy + L)
    canvas.restoreState()


def draw_page_label(canvas: Canvas, layout: Layout,
                    tile: TileRect, grid: TileGrid) -> None:
    """Page label printed in the TOP MARGIN so it gets trimmed off after assembly.
    Format: 'A1 (1 / 12)'. Drawn at the top-left of the printable area but
    OUTSIDE it, in the safe-margin zone. Bigger and bolder than before so the
    user can spot it while sorting pages before gluing.
    """
    text = f"{page_label(tile)}  ({tile.page_index + 1} / {grid.total_pages})"
    canvas.saveState()
    canvas.setFillColor(_GREY)
    canvas.setFont("Helvetica-Bold", 9)
    # Position: 2mm above the printable area's top, aligned to its left edge.
    canvas.drawString(layout.x_left, layout.y_top + 2 * MM_TO_PT, text)
    canvas.restoreState()


def draw_scale_indicator(canvas: Canvas, layout: Layout, grid: TileGrid) -> None:
    """Small footer text in the bottom margin: 'Final: 297x420 mm (A3) / 200%'.
    Drawn outside the printable area in the safe margin.
    """
    poster_w_in = grid.poster_w_mm / 25.4
    poster_h_in = grid.poster_h_mm / 25.4
    text = (
        f"Final size: {grid.poster_w_mm:.0f} \u00d7 {grid.poster_h_mm:.0f} mm  "
        f"({poster_w_in:.1f} \u00d7 {poster_h_in:.1f} in)  "
        f"\u2022 Page: {grid.paper_w_mm:.0f} \u00d7 {grid.paper_h_mm:.0f} mm "
        f"\u2022 Overlap: {grid.overlap_mm:.0f} mm"
    )
    canvas.saveState()
    canvas.setFillColor(_GREY)
    canvas.setFont("Helvetica", 6)
    # Centre the line in the bottom margin (below the printable area).
    y = max(2 * MM_TO_PT, (layout.margin_pt - 7) / 2)
    canvas.drawCentredString(layout.page_w_pt / 2, y, text)
    canvas.restoreState()


def shade_overlap(canvas: Canvas, layout: Layout,
                  tile: TileRect, grid: TileGrid) -> None:
    """Faint blue shading on the strips of this tile that overlap with neighbours,
    so the user can see at a glance where to trim/tape.
    """
    if grid.overlap_mm <= 0:
        return

    o_pt = grid.overlap_mm * MM_TO_PT
    canvas.saveState()
    canvas.setFillColor(_OVERLAP_FILL)
    canvas.setStrokeColor(_OVERLAP_FILL)

    # Right strip (overlaps tile to the right) - drawn on the inside-right of this tile
    if tile.col < grid.cols - 1:
        canvas.rect(layout.x_right - o_pt, layout.y_bottom,
                    o_pt, layout.printable_h_pt, fill=1, stroke=0)
    # Left strip (overlaps tile to the left)
    if tile.col > 0:
        canvas.rect(layout.x_left, layout.y_bottom,
                    o_pt, layout.printable_h_pt, fill=1, stroke=0)
    # Top strip (overlaps tile above)
    if tile.row > 0:
        canvas.rect(layout.x_left, layout.y_top - o_pt,
                    layout.printable_w_pt, o_pt, fill=1, stroke=0)
    # Bottom strip (overlaps tile below)
    if tile.row < grid.rows - 1:
        canvas.rect(layout.x_left, layout.y_bottom,
                    layout.printable_w_pt, o_pt, fill=1, stroke=0)
    canvas.restoreState()
