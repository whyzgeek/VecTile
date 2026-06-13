"""Standard ISO/ANSI page sizes in millimetres (portrait orientation).

The dictionary is ordered from smallest to largest so the dropdown reads
top-down naturally.
"""

PAPER_SIZES: dict[str, tuple[float, float]] = {
    "A6":      (105.0, 148.0),
    "A5":      (148.0, 210.0),
    "A4":      (210.0, 297.0),
    "A3":      (297.0, 420.0),
    "A2":      (420.0, 594.0),
    "A1":      (594.0, 841.0),
    "A0":      (841.0, 1189.0),
    "Letter":  (215.9, 279.4),
    "Legal":   (215.9, 355.6),
    "Tabloid": (279.4, 431.8),
}


def get_paper_size(name: str) -> tuple[float, float]:
    """Return (width_mm, height_mm) for a known preset name.
    Raises KeyError if name is not a preset.
    """
    if name not in PAPER_SIZES:
        raise KeyError(f"Unknown paper size: {name!r}")
    return PAPER_SIZES[name]
