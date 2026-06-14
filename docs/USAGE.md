# Vectile usage guide

This guide covers the full workflow, every major control, and engine parameters. For a quick overview, see the [README](../README.md).

---

## Workflow overview

1. **Upload** a raster image, PDF, or SVG.
2. **Vectorize** — adjust presets and parameters; preview updates live.
3. **Edit** (optional) — clean up paths, recolor, hide layers, set background.
4. **Download SVG** — export at full resolution when possible.
5. **Print** — tile across pages or export a single large PDF.

---

## Upload

Drop a file on the upload zone or click to browse.

| Format | Notes |
|--------|--------|
| PNG, JPG, WebP, BMP | Traced directly |
| PDF | Page selector and render DPI before tracing |
| SVG | Loaded for edit/print (Inkscape round-trip); optional re-trace |

---

## Preview tabs

| Tab | Purpose |
|-----|---------|
| **Original** | Source raster (or PDF page render). Pan: drag. Zoom: scroll wheel. Double-click: reset view. |
| **Vectorized** | Live SVG result. Same pan/zoom. Use Quick Edit tools here. |
| **Side by Side** | Original and vector synced pan/zoom for comparison. |
| **Print** | Poster canvas with tile grid, image placement, and assembly guides. |

---

## Vectorize controls (left panel)

### PDF settings
Shown only for PDF uploads.

- **Page** — previous/next page; re-traces the selected page.
- **Render DPI** — resolution used when rasterizing the PDF page (72–600). Higher = sharper trace, slower.

### Mode preset
Five built-in presets (Color Illustration, Outline, Pixel Art, Line Drawing, Photo Posterize). Choosing one sets engine, parameters, and pre-trace options. **Custom** keeps your manual settings.

### Engine

| Engine | Best for |
|--------|----------|
| **VTracer** | Color photos, illustrations, complex artwork |
| **B&W / Line Art** | Logos, sketches, signatures, laser-cut prep |

### Pre-trace

- **Resize for preview** — downscales large images (max 2048 px side) before tracing for faster preview. Download can still re-trace at full resolution if you have not edited the SVG.
- **Reduce colors** — optional palette quantization (0 = off, up to 32 colors) before tracing.

### Parameters

Engine-specific sliders and toggles. Changes debounce and re-trace automatically.

**VTracer**

| Parameter | Effect |
|-----------|--------|
| Color Mode | `color` or `binary` (B&W paths) |
| Hierarchy | `stacked` or `cutout` layer order |
| Curve Mode | `spline`, `polygon`, or `pixel` edges |
| Filter Speckle | Remove tiny noise blobs (px²) |
| Color Precision | Bits per channel — lower = fewer colors |
| Layer Difference | Minimum color delta to split layers |
| Corner Threshold | Preserve corners below this angle |
| Length Threshold | Minimum segment length |
| Splice Threshold | Angle to join curve segments |
| Path Precision | Decimal places in path coordinates |

**B&W / Line Art**

| Parameter | Effect |
|-----------|--------|
| Threshold | Pixels darker than this become black |
| Invert | Swap black and white |
| Sharpen edges | Pre-sharpen for crisper lines |
| Filter Speckle | Remove small noise |
| Corner / Length Threshold | Same idea as VTracer |

### Actions

- **Reset** — restore default parameters for the current engine.
- **Download SVG** — export the working SVG (includes Quick Edit and palette changes). Re-traces at full resolution when preview was downscaled and the SVG is unedited.

---

## Quick Edit (right panel, Vectorized tab)

Edits apply to the SVG on the **Vectorized** canvas and flow to download and print.

### Tools

| Tool | Action |
|------|--------|
| **Pan** | Default view navigation (drag to pan, wheel to zoom). |
| **Click erase** | Click a shape to delete it. |
| **Box erase** | Drag a rectangle to delete intersecting shapes. |
| **Pick color** | Click a shape to copy its fill into the paint color. |
| **Click paint** | Click a shape to fill it with the current paint color. |
| **Box paint** | Drag a rectangle to paint intersecting shapes. |

### Paint color picker

HSL square, hue slider, hex field, and recent colors. Used by click/box paint.

### Background

Click the **background swatch** — it loads into the paint picker above. Adjust color to update the canvas background live. Click the swatch again to finish.

### Remove speckles

Set a size threshold, then **Clean** to delete paths smaller than that (in screen pixels, scaled to SVG units).

### Undo / Redo

Up to 30 steps of edit history.

---

## Color palette (right panel)

Appears after tracing. Each swatch is one traced fill color.

| Action | How |
|--------|-----|
| **Hide layer** | Click the swatch — toggles visibility of all paths with that color. |
| **Recolor layer** | Click the **ring** on a swatch — loads that color into the paint picker above; adjust HSL/hex to recolor live. Click the ring again to finish. |
| **Set paint color** | Click the **●** button — sets the Quick Edit paint color (does not recolor the layer). |
| **Reset** | Restore the original trace colors and visibility. |

---

## Print tab (left panel)

Configure poster output after vectorizing. The **Print** preview tab shows the layout.

### Mode

- **Tile (multi-page)** — split across many sheets (A4, Letter, etc.) for home printers; tape or glue into a poster.
- **Single page** — one PDF at the chosen poster size for print shops or large-format printers.

### Paper

- Presets: A0–A6, Letter, Legal, Tabloid, custom size.
- **Orientation** — portrait or landscape.
- **Margin** — non-printable border on each sheet.
- **Units** — mm or inches (display only; internal math stays in mm).

### Poster size

- **Tile grid** — columns × rows of paper sheets.
- **Final dimensions** — total poster width × height.
- **Scale (%)** — percentage of source image size.

Aspect lock keeps poster proportions matched to the source when editing dimensions.

### Image placement (Print preview)

Interactions apply to the **image** on the poster canvas:

- **Drag** — move image.
- **Scroll wheel** — scale image.
- **Rotate grip** — rotate around image center.
- **Fit** — contain, cover, or manual placement.
- **Reset placement** — restore default position/scale/rotation.
- **Hide grid** — hide tile overlay to inspect the image.

### Image overlap (slack)

Extra duplicated image on interior seams (beyond the glue margin). Helps nudge alignment when taping. Use **0** for edge-to-edge printers.

### Decorations (tile mode)

Guides sit in margins or overlap bands that are trimmed or hidden in the finished poster.

| Decoration | Purpose |
|------------|---------|
| Overlap shade | Highlights overlap bands in preview |
| Page labels | Tile ID and page number (e.g. A1, 1/12) |
| Registration marks | Alignment crosses on covered edges |
| Scale indicator | Final poster dimensions on the start tile |
| Cut / glue guides | CUT HERE / GLUE HERE lines for assembly |

**Assembly model:** Cut white margin on left/top (covering edges). Glue each sheet onto the neighbour’s right/bottom glue strip.

### Generate PDF

Downloads `vectile-poster.pdf` — one page per tile in tile mode, or a single page in single-page mode.

---

## Status bar

Shows image dimensions, SVG file size, trace time, and path count after vectorizing.

---

## Tips

- Use **Side by Side** to judge trace quality before editing.
- Turn off **Resize for preview** for maximum detail in the live preview (slower).
- After Quick Edit, download exports your edits; full-res re-trace is skipped once the SVG is modified.
- For Inkscape: upload SVG → edit in Vectile → download → continue in Inkscape if needed.
