"""
Vectile CLI entry point.
Exposed in pyproject.toml as the `vectile` console script
(see [project.scripts] vectile = "app.cli:main"), so
`uv tool install vectile` makes `vectile` available globally.
"""
import threading
import time
import webbrowser

import uvicorn

URL = "http://127.0.0.1:8000"


def _open_browser() -> None:
    time.sleep(1.2)
    webbrowser.open(URL)


def main() -> None:
    threading.Thread(target=_open_browser, daemon=True).start()
    print(f"\n  Vectile is running at {URL}\n  Press Ctrl+C to stop.\n")
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    main()
