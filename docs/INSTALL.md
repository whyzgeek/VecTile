# Installing Vectile

Vectile runs locally in your browser. Pick one install path below.

## Option 1: One command (recommended)

Vectile uses [uv](https://docs.astral.sh/uv/) — a small Python launcher that can install its own Python runtime. You do not need Python pre-installed.

**Install uv (one-time):**

| OS | Command |
|----|---------|
| macOS / Linux | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| Windows (PowerShell) | `powershell -c "irm https://astral.sh/uv/install.ps1 \| iex"` |

**Install and run Vectile:**

```bash
uv tool install git+https://github.com/whyzgeek/VecTile
vectile
```

The app opens at **http://127.0.0.1:8000**.

- Upgrade: `uv tool upgrade vectile`
- Uninstall: `uv tool uninstall vectile`

---

## Option 2: Double-click launcher

For users who prefer not to use the terminal:

1. Download or clone the repo ([Download ZIP](https://github.com/whyzgeek/VecTile/archive/refs/heads/main.zip) or `git clone`).
2. Run the launcher for your OS:
   - **Windows:** `Vectile.bat`
   - **macOS:** `Vectile.command` (right-click → Open the first time if Gatekeeper blocks it)
   - **Linux:** `./vectile.sh` (may need `chmod +x vectile.sh`)

The launcher installs uv on first run if needed, then starts the server.

---

## Option 3: Manual install (pip)

### Prerequisites

- Python **3.10+** (`python3 --version`)
- ~150 MB disk space
- Internet for the first install only

No Poppler, Rust, Node, or other system libraries are required.

### Windows (PowerShell)

```powershell
git clone https://github.com/whyzgeek/VecTile vectile
cd vectile
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python run.py
```

If script execution is blocked: `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`

### macOS

```bash
git clone https://github.com/whyzgeek/VecTile vectile
cd vectile
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python run.py
```

### Linux

```bash
git clone https://github.com/whyzgeek/VecTile vectile
cd vectile
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python run.py
```

### Later runs

```bash
cd vectile
source .venv/bin/activate          # Windows: .\.venv\Scripts\Activate.ps1
python run.py
```

### Updating a manual install

```bash
pip install --upgrade -r requirements.txt
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `uv: command not found` | Open a new terminal, or `export PATH="$HOME/.local/bin:$PATH"` |
| `python: command not found` | Use `python3`, or install via Option 1 (uv) |
| `Activate.ps1` blocked (Windows) | `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser` |
| `ModuleNotFoundError: vtracer` | Activate the virtual environment before `python run.py` |
| Port 8000 in use | Change `port=8000` in [app/cli.py](../app/cli.py) |
| Browser does not open | Visit http://127.0.0.1:8000 manually |
| Upload rejected | Use PNG, JPG, WebP, BMP, PDF, or SVG |
| macOS “cannot verify developer” on `.command` | Right-click → Open once |

---

## Development install

From a cloned repo:

```bash
cd vectile
uv sync
uv run python run.py
```

Python 3.10+ is pinned via `.python-version` when using uv.
