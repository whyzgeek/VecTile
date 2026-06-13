# Vectile

**Vectile** is a local-first web app for vectorizing raster images (and PDFs) into clean SVGs and
**tiling them into poster-sized prints** for any printer, inspired by [vectorizer.io](https://www.vectorizer.io/) —
but free, offline, and open.

The pipeline is two stages: **vectorize** (raster -> SVG) and **tile** (SVG -> multi-page print-ready PDF). The
name is a portmanteau of "vector" + "tile".

---

## Features

### Vectorize
- Upload PNG, JPG, BMP, WebP, or **PDF**
- Two vectorization engines:
  - **VTracer** — best for color illustrations, photos, and complex artwork
  - **B&W / Line Art** — best for logos, sketches, signatures, and laser-cut prep
- Five mode presets: Color Illustration / Outline / Pixel Art / Line Drawing / Photo Posterize
- **Live debounced preview** — re-traces automatically as you adjust parameters
- **Interactive color palette** — click to hide or recolor any traced color in real time
- Side-by-side Original vs Vectorized view with synced zoom + pan
- Download clean SVG output (full resolution even when previewing downscaled)
- PDF: multi-page support with page selector and render DPI control

### Print (Phase 2)
- **Tile mode**: split the SVG across many pages (A4 / Letter / etc.) and tape them into a poster
- **Single-page mode**: one big PDF at the chosen poster size, ready for a print shop or large-format printer
- Pick poster size by final dimensions (mm), tile grid (cols x rows), or scale percentage
- Standard paper presets: A0-A6, Letter, Legal, Tabloid, plus custom dimensions
- Configurable overlap so pages can be taped without seams
- Optional decorations: crop marks, page labels (A1, A2, ...), registration marks, scale indicator, border box, overlap shading
- Live tile-overlay preview directly on the vectorized image
- One-click multi-page PDF download

---

## Installation

Three install paths in order of friction. Pick whichever feels right.

### Option 1: One command (recommended)

Vectile uses [uv](https://docs.astral.sh/uv/) — a tiny single-binary Python launcher that bootstraps its own Python. **No need to install Python yourself.**

**Step 1:** Install uv (one-time, takes a few seconds):

| OS | Command |
|----|---------|
| macOS / Linux | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| Windows (PowerShell) | `powershell -c "irm https://astral.sh/uv/install.ps1 \| iex"` |

**Step 2:** Install and run Vectile:

```
uv tool install git+https://github.com/whyzgeek/VecTile
vectile
```

That's it. `vectile` is now a global command on your PATH. The browser opens automatically at **http://127.0.0.1:8000**.

To upgrade later: `uv tool upgrade vectile`.

To uninstall: `uv tool uninstall vectile`.

---

### Option 2: Double-click launcher (no terminal)

Best for non-technical users.

1. Download or clone the repo (Code -> Download ZIP, then extract).
2. Double-click the launcher for your OS:
   - **Windows**: `Vectile.bat`
   - **macOS**: `Vectile.command` (you may need to right-click -> Open the first time, and `chmod +x Vectile.command` if it isn't executable)
   - **Linux**: `vectile.sh` (run from terminal: `./vectile.sh`, after `chmod +x vectile.sh`)

The launcher will install uv automatically on first run, then start Vectile. Subsequent runs are instant.

---

### Option 3: Manual install (no uv)

If you prefer plain `pip`:

#### Prerequisites

- **Python 3.10 or newer** — verify with `python --version`
- ~150 MB of disk space
- An internet connection for first install only

No system libraries (Poppler, libpotrace, Rust, Node, etc.) are required.

#### Windows (PowerShell)

```powershell
git clone https://github.com/whyzgeek/VecTile vectile
cd vectile
python -m venv .venv
.\.venv\Scripts\Activate.ps1
# If blocked: Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
pip install -r requirements.txt
python run.py
```

If Python isn't installed, get it from [python.org](https://www.python.org/downloads/windows/) (tick **"Add python.exe to PATH"**) or the Microsoft Store.

#### macOS

```bash
git clone https://github.com/whyzgeek/VecTile vectile
cd vectile
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python run.py
```

If `python3` isn't installed: `brew install python@3.12` (via [Homebrew](https://brew.sh/)) or download from [python.org](https://www.python.org/downloads/macos/). All deps have native `arm64` wheels for Apple Silicon.

#### Linux

```bash
# Debian/Ubuntu:  sudo apt install -y python3 python3-venv python3-pip
# Fedora:         sudo dnf install -y python3 python3-pip
# Arch:           sudo pacman -S python python-pip
git clone https://github.com/whyzgeek/VecTile vectile
cd vectile
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python run.py
```

#### Subsequent runs (manual install)

```bash
cd vectile
source .venv/bin/activate          # Windows: .\.venv\Scripts\Activate.ps1
python run.py
```

#### Updating

```bash
pip install --upgrade -r requirements.txt
```

---

### Troubleshooting

| Problem | Fix |
|---------|-----|
| `uv: command not found` after install | Open a new terminal so `~/.local/bin` is on PATH, or run `export PATH="$HOME/.local/bin:$PATH"` |
| `python: command not found` | Use `python3` instead, or pick install Option 1 (uv handles Python for you) |
| `Activate.ps1 cannot be loaded because running scripts is disabled` (Windows) | Run `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`, then retry |
| `pip install` times out | Network firewall — retry, or use Option 1 (uv) which is more resilient |
| `ModuleNotFoundError: vtracer` | The venv isn't active. Activate it before `python run.py` |
| Port 8000 already in use | Edit [app/cli.py](app/cli.py) and change `port=8000` to e.g. `port=8765` |
| Browser doesn't open automatically | Visit `http://127.0.0.1:8000` manually |
| Upload returns "Unsupported file type" | The file extension or MIME doesn't match — try saving as PNG/JPG/PDF |
| macOS "cannot verify developer" on `Vectile.command` | Right-click -> Open, then choose Open in the dialog. Only needed once |

---

## Engine guide

| Preset | Engine | Best for |
|--------|--------|----------|
| Color Illustration | VTracer | Photos, artwork, illustrations |
| Outline / Shapes | VTracer | Flat-color designs, icons |
| Pixel Art | VTracer | 8-bit / pixel-style images |
| Line Drawing | B&W (VTracer binary) | Pencil sketches, logos, ink drawings |
| Photo Posterize | VTracer | Photographs with heavy color reduction |

---

## VTracer parameter reference

| Parameter | Range | Effect |
|-----------|-------|--------|
| Color Mode | color / binary | Full color or single-color tracing |
| Hierarchy | stacked / cutout | How layers overlap |
| Curve Mode | spline / polygon / pixel | Edge smoothness |
| Filter Speckle | 0–128 | Remove small noise regions (px²) |
| Color Precision | 1–8 | Bits per channel — lower = fewer colors |
| Layer Difference | 0–256 | Minimum color delta to split layers |
| Corner Threshold | 0–180° | Angle below which corners are kept |
| Length Threshold | 0–10 | Minimum segment length |
| Splice Threshold | 0–180° | Angle to splice curve segments |
| Path Precision | 1–8 | Decimal places in path coordinates |

## B&W / Line Art parameter reference

| Parameter | Range | Effect |
|-----------|-------|--------|
| Threshold | 0–255 | Pixels darker than this → black |
| Invert | on/off | Swap black and white |
| Sharpen edges | on/off | Pre-sharpen for crisper output |
| Filter Speckle | 0–128 | Remove small noise |
| Corner Threshold | 0–180° | Corner preservation |
| Length Threshold | 0–10 | Minimum segment length |

---

## Print panel (Phase 2)

After vectorizing an image, switch the right panel to the **Print** tab to set up a poster print.

### Tile mode (multi-page)

For printing on a normal home/office printer and taping pages together.

1. Pick a paper size (A4, Letter, etc.)
2. Pick a poster size — choose between:
   - **Final dimensions (mm)** — direct width/height
   - **Tile grid** — N cols x M rows of the chosen paper
   - **Scale (%)** — relative to the source image
3. Set the overlap (mm) — each page repeats this strip on its neighbour so you can tape pages without a seam
4. Toggle decorations as needed (all on by default)
5. Click **Show overlay** to see the tile boundaries on the vectorized preview
6. Click **Generate PDF** — downloads `vectile-poster.pdf` with one page per tile

Suggested workflow: tape from the back, then trim along the crop marks.

### Single-page mode

For sending to a print shop or a large-format printer. Pick the final dimensions, decoration style, and click Generate PDF — you get one page at the requested size.

### Decorations

| Decoration | What it does |
|------------|--------------|
| Overlap shade | Faint blue tint on the strips that overlap with neighbours |
| Crop marks | L-shaped corner ticks just outside the trim line |
| Page labels | "A1 (1 / 12)"-style label inside each tile |
| Registration marks | Small + symbol where four pages meet, for precise alignment |
| Scale indicator | Footer text with the final printed dimensions |
| Border box | Thin grey rectangle around each tile's printable area |

---

## File layout

```
vectile/
├── run.py
├── pyproject.toml
├── requirements.txt
├── README.md
├── Vectile.bat / Vectile.command / vectile.sh
└── app/
    ├── cli.py
    ├── main.py
    ├── session.py
    ├── preprocess.py
    ├── pdf_input.py
    ├── engines/
    │   ├── vtracer_engine.py
    │   └── potrace_engine.py
    ├── printing/
    │   ├── paper_sizes.py
    │   ├── tiler.py
    │   ├── decorations.py
    │   └── pdf_generator.py
    └── static/
        ├── index.html
        ├── style.css
        └── app.js
```

---

## License

MIT
