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

_GREY = Color(0.55, 0.55, 0.55)
_FAINT = Color(0.78, 0.78, 0.78)
_OVERLAP_FILL = Color(0.0, 0.45, 0.85, alpha=0.06)


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


def draw_border_box(canvas: Canvas, layout: Layout) -> None:
    """A thin grey rectangle around the printable area showing the trim line."""
    canvas.saveState()
    canvas.setStrokeColor(_FAINT)
    canvas.setLineWidth(0.4)
    canvas.rect(layout.x_left, layout.y_bottom,
                layout.printable_w_pt, layout.printable_h_pt, fill=0, stroke=1)
    canvas.restoreState()


def draw_crop_marks(canvas: Canvas, layout: Layout,
                    mark_len_mm: float = 5.0, offset_mm: float = 2.0) -> None:
    """L-shaped corner ticks just outside the trim line."""
    L = mark_len_mm * MM_TO_PT
    o = offset_mm * MM_TO_PT
    canvas.saveState()
    canvas.setStrokeColor(_GREY)
    canvas.setLineWidth(0.5)

    corners = [
        (layout.x_left,  layout.y_bottom, -1, -1),  # bottom-left
        (layout.x_right, layout.y_bottom,  1, -1),  # bottom-right
        (layout.x_left,  layout.y_top,    -1,  1),  # top-left
        (layout.x_right, layout.y_top,     1,  1),  # top-right
    ]
    for (cx, cy, dx, dy) in corners:
        # Horizontal stroke
        canvas.line(cx + dx * o, cy, cx + dx * (o + L), cy)
        # Vertical stroke
        canvas.line(cx, cy + dy * o, cx, cy + dy * (o + L))
    canvas.restoreState()


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
