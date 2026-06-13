#!/bin/bash
# ============================================================
#  Vectile launcher (macOS)
#  Double-clickable in Finder. Installs uv on first run,
#  then uses uv to install Python deps and launch the app.
#
#  After downloading, you may need to mark this file executable:
#      chmod +x Vectile.command
# ============================================================
set -e

cd "$(dirname "$0")"

if ! command -v uv >/dev/null 2>&1; then
    echo "Installing uv (Astral Python launcher)..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    # uv installs into ~/.local/bin by default
    export PATH="$HOME/.local/bin:$PATH"
fi

if ! command -v uv >/dev/null 2>&1; then
    echo
    echo "Failed to install uv. See https://astral.sh/uv for manual install."
    read -p "Press Enter to close..."
    exit 1
fi

echo "Starting Vectile..."
exec uv run vectile
