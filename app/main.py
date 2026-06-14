"""
Vectile — main FastAPI application.
Routes:
  GET  /                       -> static/index.html
  POST /api/upload             -> upload an image or PDF; returns image_id + metadata
  POST /api/pdf-render         -> re-rasterize a PDF at a different page/DPI
  POST /api/vectorize          -> trace the image; returns SVG + palette
  GET  /api/engines            -> list engines + their param schemas
  GET  /api/presets            -> named presets (engine + params)
  GET  /api/print/paper-sizes  -> standard paper presets
  POST /api/print/calculate    -> compute the tile grid + preview overlay
  POST /api/print/tile         -> generate the multi-page poster PDF
  GET  /api/health             -> { "ok": true }
"""
import io
import os
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile, File, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel, Field

from .engines import ENGINES
from .preprocess import (
    extract_palette,
    extract_palette_from_svg,
    is_svg_bytes,
    parse_svg_user_units,
    quantize,
    resize_for_preview,
)
from .pdf_input import is_pdf, get_page_count, render_page
from . import session as sess
from .printing import (
    PAPER_SIZES,
    PrintSettings,
    build_pdf,
    compute_grid,
    get_paper_size,
)
from .printing.pdf_generator import compute_settings_grid
from .printing.tiler import page_label as tile_page_label, poster_intersection_mm

MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # 20 MB

ALLOWED_MIME = {
    "image/png", "image/jpeg", "image/bmp", "image/webp",
    "image/gif", "image/tiff", "image/svg+xml", "application/pdf",
}

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="Vectile", version="1.0.0")


# ---------- Presets -----------------------------------------------------------

PRESETS = [
    {
        "id": "color_illustration",
        "label": "Color Illustration",
        "engine": "vtracer",
        "params": {
            "colormode": "color", "hierarchical": "stacked", "mode": "spline",
            "filter_speckle": 4, "color_precision": 6, "layer_difference": 16,
            "corner_threshold": 60, "length_threshold": 4.0,
            "splice_threshold": 45, "path_precision": 8,
        },
        "quantize_colors": 0,
        "resize_preview": True,
    },
    {
        "id": "outline",
        "label": "Outline / Shapes",
        "engine": "vtracer",
        "params": {
            "colormode": "color", "hierarchical": "cutout", "mode": "spline",
            "filter_speckle": 8, "color_precision": 4, "layer_difference": 32,
            "corner_threshold": 90, "length_threshold": 5.0,
            "splice_threshold": 45, "path_precision": 6,
        },
        "quantize_colors": 8,
        "resize_preview": True,
    },
    {
        "id": "pixel_art",
        "label": "Pixel Art",
        "engine": "vtracer",
        "params": {
            "colormode": "color", "hierarchical": "stacked", "mode": "none",
            "filter_speckle": 1, "color_precision": 8, "layer_difference": 1,
            "corner_threshold": 60, "length_threshold": 1.0,
            "splice_threshold": 45, "path_precision": 2,
        },
        "quantize_colors": 0,
        "resize_preview": False,
    },
    {
        "id": "line_drawing",
        "label": "Line Drawing / Sketch",
        "engine": "potrace",
        "params": {
            "threshold": 140, "invert": False, "sharpen": True,
            "mode": "spline", "filter_speckle": 6, "corner_threshold": 60,
            "length_threshold": 3.0, "splice_threshold": 45, "path_precision": 8,
        },
        "quantize_colors": 0,
        "resize_preview": True,
    },
    {
        "id": "photo_posterize",
        "label": "Photo Posterize",
        "engine": "vtracer",
        "params": {
            "colormode": "color", "hierarchical": "stacked", "mode": "spline",
            "filter_speckle": 16, "color_precision": 3, "layer_difference": 48,
            "corner_threshold": 90, "length_threshold": 6.0,
            "splice_threshold": 45, "path_precision": 4,
        },
        "quantize_colors": 12,
        "resize_preview": True,
    },
]


# ---------- Routes ------------------------------------------------------------

@app.get("/api/health")
async def health():
    return {"ok": True}


@app.get("/api/engines")
async def list_engines():
    return [
        {
            "id": engine_id,
            "name": engine.name,
            "description": engine.description,
            "param_schema": engine.param_schema,
        }
        for engine_id, engine in ENGINES.items()
    ]


@app.get("/api/presets")
async def list_presets():
    return PRESETS


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    data = await file.read()

    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "File exceeds 20 MB limit")

    content_type = (file.content_type or "").lower().split(";")[0].strip()

    # Sniff PDF / SVG by magic bytes regardless of MIME
    if is_pdf(data):
        content_type = "application/pdf"
    elif is_svg_bytes(data):
        content_type = "image/svg+xml"

    if content_type not in ALLOWED_MIME:
        raise HTTPException(415, f"Unsupported file type: {content_type}")

    if content_type == "image/svg+xml":
        try:
            svg_str = data.decode("utf-8")
        except UnicodeDecodeError:
            raise HTTPException(400, "SVG must be UTF-8 encoded")
        try:
            view_w, view_h = parse_svg_user_units(svg_str)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        palette = extract_palette_from_svg(svg_str)
        # Minimal raster placeholder so the session shape stays compatible.
        pil_img = Image.new("RGB", (max(1, int(view_w)), max(1, int(view_h))), "white")
        w, h = pil_img.size
        raster_path = sess.save_raster_to_temp(pil_img)
        entry = sess.create_entry(
            original_bytes=data,
            raster_path=raster_path,
            kind="svg",
            page_count=1,
            width=int(view_w),
            height=int(view_h),
        )
        return {
            "image_id": entry.image_id,
            "kind": "svg",
            "width": int(view_w),
            "height": int(view_h),
            "page_count": 1,
            "palette": palette,
            "svg": svg_str,
        }

    if content_type == "application/pdf":
        page_count = get_page_count(data)
        pil_img = render_page(data, page_index=0, dpi=200)
        kind = "pdf"
    else:
        try:
            pil_img = Image.open(io.BytesIO(data))
            pil_img.verify()
            pil_img = Image.open(io.BytesIO(data))
        except Exception:
            raise HTTPException(400, "Invalid or corrupt image file")
        page_count = 1
        kind = "image"

    pil_img = pil_img.convert("RGBA")
    w, h = pil_img.size
    palette = extract_palette(pil_img)

    raster_path = sess.save_raster_to_temp(pil_img.convert("RGB"))
    entry = sess.create_entry(
        original_bytes=data,
        raster_path=raster_path,
        kind=kind,
        page_count=page_count,
        width=w,
        height=h,
    )

    return {
        "image_id": entry.image_id,
        "kind": kind,
        "width": w,
        "height": h,
        "page_count": page_count,
        "palette": palette,
    }


class PdfRenderRequest(BaseModel):
    image_id: str
    page: int = 0
    dpi: int = 200


@app.post("/api/pdf-render")
async def pdf_render(req: PdfRenderRequest):
    entry = sess.get_entry(req.image_id)
    if entry is None:
        raise HTTPException(404, "Session not found — please re-upload")
    if entry.kind != "pdf":
        raise HTTPException(400, "This session is not a PDF")

    pil_img = render_page(entry.original_bytes, page_index=req.page, dpi=req.dpi)
    w, h = pil_img.size
    palette = extract_palette(pil_img)

    new_path = sess.save_raster_to_temp(pil_img)
    sess.update_raster(req.image_id, new_path, w, h)

    return {"width": w, "height": h, "palette": palette}


class VectorizeRequest(BaseModel):
    image_id: str
    engine: str = "vtracer"
    params: dict = {}
    quantize_colors: int = 0
    resize_preview: bool = True


@app.post("/api/vectorize")
async def vectorize(req: VectorizeRequest):
    entry = sess.get_entry(req.image_id)
    if entry is None:
        raise HTTPException(404, "Session not found — please re-upload")

    engine = ENGINES.get(req.engine)
    if engine is None:
        raise HTTPException(400, f"Unknown engine: {req.engine}")

    img = Image.open(entry.raster_path).convert("RGB")

    if req.resize_preview:
        img = resize_for_preview(img)

    if req.quantize_colors >= 2:
        img = quantize(img, req.quantize_colors)

    # Write the (possibly modified) image to a temp path for the engine
    import tempfile
    fd, tmp_path = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    try:
        img.save(tmp_path)
        t0 = time.perf_counter()
        svg = engine.vectorize(tmp_path, req.params)
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)

    palette = extract_palette_from_svg(svg)

    return {"svg": svg, "palette": palette, "elapsed_ms": elapsed_ms}


# ---------- Print / poster tiling ---------------------------------------------

class PrintSettingsRequest(BaseModel):
    """Mirror of printing.PrintSettings, used for the calculate + tile endpoints."""
    paper_name: str = "Letter"
    paper_w_mm: float | None = None
    paper_h_mm: float | None = None
    orientation: str = "portrait"
    poster_w_mm: float = 420.0
    poster_h_mm: float = 594.0
    overlap_mm: float = 2.0
    margin_mm: float = 10.0
    single_page: bool = False
    image_x_mm: float | None = None
    image_y_mm: float | None = None
    image_scale: float | None = None  # mm per source-SVG user unit
    image_rotation_deg: float = 0.0
    grid_offset_x_mm: float = 0.0
    grid_offset_y_mm: float = 0.0
    poster_mode: str = "dimensions"
    grid_cols: int | None = None
    grid_rows: int | None = None
    trim_guides_to_poster: bool = True
    decorations: dict[str, bool] = Field(default_factory=lambda: {
        "overlap_shade": True,
        "crop_marks": True,
        "page_labels": True,
        "registration_marks": True,
        "scale_indicator": True,
        "border_box": True,
    })

    def to_settings(self) -> PrintSettings:
        return PrintSettings(
            paper_name=self.paper_name,
            paper_w_mm=self.paper_w_mm,
            paper_h_mm=self.paper_h_mm,
            orientation=self.orientation,
            poster_w_mm=self.poster_w_mm,
            poster_h_mm=self.poster_h_mm,
            overlap_mm=self.overlap_mm,
            margin_mm=self.margin_mm,
            single_page=self.single_page,
            image_x_mm=self.image_x_mm,
            image_y_mm=self.image_y_mm,
            image_scale=self.image_scale,
            image_rotation_deg=self.image_rotation_deg,
            grid_offset_x_mm=self.grid_offset_x_mm,
            grid_offset_y_mm=self.grid_offset_y_mm,
            poster_mode=self.poster_mode,
            grid_cols=self.grid_cols,
            grid_rows=self.grid_rows,
            trim_guides_to_poster=self.trim_guides_to_poster,
            decorations=dict(self.decorations),
        )


class CalculatePrintRequest(BaseModel):
    """Body for /api/print/calculate.
    Either svg_view_w/h are given, or image_id is given (we read the cached raster's size).
    """
    settings: PrintSettingsRequest
    svg_view_w: float | None = None
    svg_view_h: float | None = None
    image_id: str | None = None


class TilePdfRequest(BaseModel):
    """Body for /api/print/tile."""
    settings: PrintSettingsRequest
    svg: str  # the (possibly palette-edited) SVG to tile


@app.get("/api/print/paper-sizes")
async def list_paper_sizes():
    return [
        {"name": name, "width_mm": w, "height_mm": h}
        for name, (w, h) in PAPER_SIZES.items()
    ]


@app.post("/api/print/calculate")
async def calculate_print(req: CalculatePrintRequest):
    if req.svg_view_w and req.svg_view_h:
        view_w = req.svg_view_w
        view_h = req.svg_view_h
    elif req.image_id:
        entry = sess.get_entry(req.image_id)
        if entry is None:
            raise HTTPException(404, "Session not found")
        view_w = entry.width
        view_h = entry.height
    else:
        raise HTTPException(400, "Provide svg_view_w/svg_view_h or image_id")

    try:
        grid = compute_settings_grid(view_w, view_h, req.settings.to_settings())
    except (ValueError, KeyError) as e:
        raise HTTPException(400, str(e))

    tiles = []
    for t in grid.tiles:
        if req.settings.trim_guides_to_poster:
            if poster_intersection_mm(t, grid.poster_w_mm, grid.poster_h_mm) is None:
                continue
        tiles.append(
            {
                "col": t.col,
                "row": t.row,
                "page_index": t.page_index,
                "label": tile_page_label(t),
                "poster_x_mm": t.poster_x_mm,
                "poster_y_mm": t.poster_y_mm,
                "printable_w_mm": t.printable_w_mm,
                "printable_h_mm": t.printable_h_mm,
            }
        )
    return {
        "cols": grid.cols,
        "rows": grid.rows,
        "total_pages": len(tiles),
        "paper_w_mm": grid.paper_w_mm,
        "paper_h_mm": grid.paper_h_mm,
        "poster_w_mm": grid.poster_w_mm,
        "poster_h_mm": grid.poster_h_mm,
        "printable_w_mm": grid.printable_w_mm,
        "printable_h_mm": grid.printable_h_mm,
        "step_x_mm": grid.step_x_mm,
        "step_y_mm": grid.step_y_mm,
        "overlap_mm": grid.overlap_mm,
        "margin_mm": grid.margin_mm,
        "scale": grid.scale,
        "tiles": tiles,
    }


@app.post("/api/print/tile")
async def generate_print_pdf(req: TilePdfRequest):
    if not req.svg.strip():
        raise HTTPException(400, "svg payload is empty")

    try:
        pdf_bytes = build_pdf(req.svg, req.settings.to_settings())
    except (ValueError, KeyError) as e:
        raise HTTPException(400, str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"PDF generation failed: {e}")

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="vectile-poster.pdf"'},
    )


# ---------- Static files (must be last) ---------------------------------------

app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
