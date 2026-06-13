# app/engines/__init__.py
from .vtracer_engine import VtracerEngine
from .potrace_engine import PotraceEngine

ENGINES: dict = {
    "vtracer": VtracerEngine(),
    "potrace": PotraceEngine(),
}
