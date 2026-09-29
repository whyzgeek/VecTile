# Vectile usage guide

This guide covers the full workflow, every major control, and engine parameters. For a quick overview, see the [README](../README.md).

---

## Workflow overview

1. **Upload** a raster image, PDF, or SVG.
2. **Vectorize** — adjust presets and parameters; preview updates live.
3. **Edit** (optional) — choose which colors to trace (drop the background, merge similar shades, recolor), then touch up shapes with Quick Edit.
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
Built-in presets for the active engine: Color Illustration, Outline, Pixel Art and Photo Posterize (VTracer); Line Drawing and **Logo / Sign from Photo** (B&W). Choosing one sets parameters and pre-trace options. **Custom** keeps your manual settings.

**Logo / Sign from Photo** is for a logo photographed on a surface: an embossed or printed sign, paper, a wall. It evens out shadows and uneven lighting before thresholding, so thin strokes and small text survive without picking up cast shadows. If strokes come out broken, raise Threshold (e.g. 180); if shadow blotches appear, lower it (e.g. 160). Remove leftover frame edges with Box erase.

### Engine

| Engine | Best for |
|--------|----------|
| **VTracer** | Color photos, illustrations, complex artwork |
| **B&W / Line Art** | Logos, sketches, signatures, laser-cut prep |

### Pre-trace

- **Resize for preview** — downscales large images (max 2048 px side) before tracing for faster preview. Download can still re-trace at full resolution if you have not edited the SVG.

### Parameters

Engine-specific sliders and toggles. Changes debounce and re-trace automatically. Options that have no effect under the current settings are hidden (e.g. the corner/length/splice thresholds only appear in *Spline* curve mode; Hierarchy, Color Precision and Layer Difference only in VTracer *Color* mode). Presets are filtered to the active engine.

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
| Even out lighting | Remove shadows and light falloff first; Threshold then compares each pixel to its surroundings (~170–185 works well) |
| Smooth texture | Blur paper grain/noise before thresholding (0 = off; blurs small text) |
| Invert | Swap black and white |
| Sharpen edges | Pre-sharpen for crisper lines |
| Filter Speckle | Remove small noise |
| Corner / Length Threshold | Same idea as VTracer |

### Actions

- **Reset** — restore default parameters for the current engine.
- **Download SVG** — export the working SVG (includes Colors and Quick Edit changes). Re-traces at full resolution when preview was downscaled and the SVG is unedited.

---

## Colors (right panel)

Shown for color tracing (VTracer in *Color* mode) and for uploaded SVGs. Hidden for B&W output, where it has no effect.

For images and PDFs the colors are chosen **before** tracing, so they change the contours, not just the look:

1. Set **Colors to trace** (*All* = trace the image as-is). The image is snapped to that many dominant colors; near-identical shades are folded together, so you may get fewer. The color covering most of the image edge is tagged **Background**.
2. Each row shows the color and how much of the image it covers.

| Action | How |
|--------|-----|
| **Leave out a color** | Click the **eye**. The color becomes transparent and is not traced. On the Background row this removes the background. |
| **Merge colors** | Click the **swatch**, then pick a color under *Merge into*. Both become one region, which removes slivers and halos and gives cleaner outlines. |
| **Recolor** | Click the **swatch** and choose a new color under *Recolor*. |
| **Restore** | *Restore original* in the row's editor, or **Reset** for all colors. |

Every change re-traces. For an uploaded SVG (nothing to re-trace) the rows are the SVG's own fill colors, and hide/merge/recolor edit those fills directly.

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

HSL square, hue slider, hex field, and recent colors. Used by click/box paint. Paint tools are hidden for B&W output.

Quick Edit changes are made on the traced SVG, so any re-trace (a parameter or Colors change) discards them. Settle the colors first, then touch up.

### Remove speckles

Set a size threshold, then **Clean** to delete paths smaller than that (in screen pixels, scaled to SVG units).

### Undo / Redo

Up to 30 steps of edit history.

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
