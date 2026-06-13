"""
PDF input handling using pypdfium2.
Converts a PDF page to a PIL Image at a chosen DPI, composited on a white background.
"""
from PIL import Image
import io


def is_pdf(data: bytes) -> bool:
    return data[:5] == b"%PDF-"


def get_page_count(data: bytes) -> int:
    try:
        import pypdfium2 as pdfium
        doc = pdfium.PdfDocument(data)
        return len(doc)
    except Exception:
        return 1


def render_page(data: bytes, page_index: int = 0, dpi: int = 200) -> Image.Image:
    """Render one PDF page to a PIL Image at the requested DPI."""
    import pypdfium2 as pdfium

    dpi = max(72, min(600, dpi))

    doc = pdfium.PdfDocument(data)
    page_index = max(0, min(page_index, len(doc) - 1))
    page = doc[page_index]

    scale = dpi / 72.0
    bitmap = page.render(scale=scale, rotation=0)
    pil_image = bitmap.to_pil()

    # Composite over white if the image has an alpha channel
    if pil_image.mode in ("RGBA", "LA"):
        bg = Image.new("RGB", pil_image.size, (255, 255, 255))
        bg.paste(pil_image, mask=pil_image.split()[-1])
        return bg

    return pil_image.convert("RGB")
