"""
Legacy launcher kept for backwards compatibility (`python run.py`).
The real entry point lives in app/cli.py and is also exposed as the
`vectile` console script via pyproject.toml.
"""
from app.cli import main

if __name__ == "__main__":
    main()
