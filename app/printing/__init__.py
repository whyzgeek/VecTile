"""
Vectile printing package.
Phase 2: turn a traced SVG into a print-ready multi-page PDF.

  paper_sizes  - standard ISO/ANSI page presets
  tiler        - pure-geometry tile grid math
  decorations  - crop marks, registration marks, page labels, etc.
  pdf_generator - top-level: stitches everything into a PDF
"""
from .paper_sizes import PAPER_SIZES, get_paper_size
from .tiler import TileGrid, TileRect, compute_grid
from .pdf_generator import build_pdf, PrintSettings

__all__ = [
    "PAPER_SIZES",
    "get_paper_size",
    "TileGrid",
    "TileRect",
    "compute_grid",
    "build_pdf",
    "PrintSettings",
]
