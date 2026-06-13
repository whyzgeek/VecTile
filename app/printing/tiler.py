"""Tile-grid geometry for poster printing.

Pure functions, no IO and no external deps. All distances are in millimetres
unless noted otherwise.

Coordinate convention:
  - The poster is laid out with origin (0, 0) at the top-left, x growing to
    the right and y growing downwards.
  - Each tile maps to one PDF page. Tile (col=i, row=j) prints the rectangle
    with top-left at (i * step_x, j * step_y) on the poster (where step is
    the printable area minus the overlap that's repeated on the next tile).
  - The "printable area" of a tile is the page minus the printer-safe margins
    on all four sides. Decorations (crop marks etc.) are drawn outside the
    printable area, in the margin.

The "overlap" is the strip of poster that gets repeated on adjacent tiles,
so the user can trim and tape pages without seams.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from math import ceil


@dataclass
class TileRect:
    """One tile's location on the poster (mm) and which page it sits on (0-indexed).
    poster_x/y are the top-left of the tile's printable region, on the poster.
    The printable region's size is (printable_w, printable_h).
    Adjacent tiles overlap by the grid's `overlap_mm` value.
    """
    col: int
    row: int
    page_index: int
    poster_x_mm: float
    poster_y_mm: float
    printable_w_mm: float
    printable_h_mm: float


@dataclass
class TileGrid:
    """Result of compute_grid: everything the PDF generator and UI overlay need."""
    cols: int
    rows: int
    paper_w_mm: float        # full sheet
    paper_h_mm: float
    margin_mm: float
    overlap_mm: float
    poster_w_mm: float
    poster_h_mm: float
    printable_w_mm: float    # paper - 2*margin
    printable_h_mm: float
    step_x_mm: float         # how far right each tile shifts on the poster
    step_y_mm: float
    scale: float             # source-svg-unit -> mm (uniform; preserves aspect)
    tiles: list[TileRect] = field(default_factory=list)

    @property
    def total_pages(self) -> int:
        return self.cols * self.rows


def _maybe_swap(w: float, h: float, orientation: str) -> tuple[float, float]:
    if orientation == "landscape" and h > w:
        return h, w
    if orientation == "portrait" and w > h:
        return h, w
    return w, h


def compute_grid(
    svg_view_w: float,
    svg_view_h: float,
    paper_w_mm: float,
    paper_h_mm: float,
    poster_w_mm: float,
    poster_h_mm: float,
    overlap_mm: float = 10.0,
    margin_mm: float = 10.0,
    orientation: str = "portrait",
    *,
    single_page: bool = False,
    grid_offset_x_mm: float = 0.0,
    grid_offset_y_mm: float = 0.0,
) -> TileGrid:
    """Compute the tile grid for the requested poster.

    Args:
        svg_view_w/h: source SVG viewBox dimensions (any units; only the ratio matters)
        paper_w_mm/paper_h_mm: paper preset (portrait orientation by default)
        poster_w_mm/poster_h_mm: final desired poster dimensions in mm
        overlap_mm: strip each tile extends into its neighbours (ignored in single_page)
        margin_mm: printer-safe margin (white space on each tile's edge)
        orientation: "portrait" or "landscape" - swaps paper width/height
        single_page: if True, force a 1x1 grid and use poster size as the paper size

    The returned TileGrid contains a `tiles` list with one TileRect per page,
    in row-major order (left-to-right, top-to-bottom).
    """
    if single_page:
        # The poster IS the page. Margins still apply for crop/border decorations.
        paper_w = poster_w_mm + 2 * margin_mm
        paper_h = poster_h_mm + 2 * margin_mm
        cols = rows = 1
        printable_w = poster_w_mm
        printable_h = poster_h_mm
        step_x = poster_w_mm
        step_y = poster_h_mm
        eff_overlap = 0.0
    else:
        paper_w, paper_h = _maybe_swap(paper_w_mm, paper_h_mm, orientation)
        printable_w = paper_w - 2 * margin_mm
        printable_h = paper_h - 2 * margin_mm

        if printable_w <= 0 or printable_h <= 0:
            raise ValueError("Margin too large for the chosen paper size")

        eff_overlap = max(0.0, min(overlap_mm, min(printable_w, printable_h) - 1.0))

        # Each printable area covers `printable_w` of poster, but overlap_mm is
        # repeated on the next tile, so the *step* between tiles is smaller.
        step_x = printable_w - eff_overlap
        step_y = printable_h - eff_overlap

        if step_x <= 0 or step_y <= 0:
            raise ValueError("Overlap too large relative to paper size")

        cols = max(1, ceil((poster_w_mm - eff_overlap) / step_x))
        rows = max(1, ceil((poster_h_mm - eff_overlap) / step_y))

    # Uniform scale: poster area / svg viewBox area, preserving aspect.
    # If poster aspect != svg aspect, we use the *minimum* scale so the whole
    # SVG fits inside the poster; the leftover edge will be blank tiles.
    scale_x = poster_w_mm / svg_view_w if svg_view_w else 1.0
    scale_y = poster_h_mm / svg_view_h if svg_view_h else 1.0
    scale = min(scale_x, scale_y)

    tiles: list[TileRect] = []
    page_index = 0
    for row in range(rows):
        for col in range(cols):
            tiles.append(
                TileRect(
                    col=col,
                    row=row,
                    page_index=page_index,
                    poster_x_mm=col * step_x + grid_offset_x_mm,
                    poster_y_mm=row * step_y + grid_offset_y_mm,
                    printable_w_mm=printable_w,
                    printable_h_mm=printable_h,
                )
            )
            page_index += 1

    return TileGrid(
        cols=cols,
        rows=rows,
        paper_w_mm=paper_w,
        paper_h_mm=paper_h,
        margin_mm=margin_mm,
        overlap_mm=eff_overlap,
        poster_w_mm=poster_w_mm,
        poster_h_mm=poster_h_mm,
        printable_w_mm=printable_w,
        printable_h_mm=printable_h,
        step_x_mm=step_x,
        step_y_mm=step_y,
        scale=scale,
        tiles=tiles,
    )


def col_label(col: int) -> str:
    """Spreadsheet-style column label: 0->A, 25->Z, 26->AA, ..."""
    label = ""
    n = col
    while True:
        label = chr(ord("A") + (n % 26)) + label
        n = n // 26 - 1
        if n < 0:
            break
    return label


def page_label(tile: TileRect) -> str:
    """Human-readable label like 'A1', 'B3', 'AA12' (col letter + row number)."""
    return f"{col_label(tile.col)}{tile.row + 1}"
