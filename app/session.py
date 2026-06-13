"""
Session store: holds uploaded images in the OS temp dir for the lifetime of the server.
Each session entry maps image_id -> SessionEntry, which tracks:
  - original_bytes: raw upload bytes (kept for PDF page re-renders)
  - raster_path:    path to the current PNG ready for tracing
  - kind:           "image" | "pdf"
  - page_count:     number of PDF pages (1 for plain images)
  - width, height:  of the current raster
  - created_at:     for optional TTL cleanup
"""
import os
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from threading import Lock

SESSION_TTL_SECONDS = 3600  # 1 hour


@dataclass
class SessionEntry:
    image_id: str
    original_bytes: bytes
    raster_path: str
    kind: str          # "image" | "pdf"
    page_count: int
    width: int
    height: int
    created_at: float = field(default_factory=time.time)


_store: dict[str, SessionEntry] = {}
_lock = Lock()


def create_entry(
    original_bytes: bytes,
    raster_path: str,
    kind: str,
    page_count: int,
    width: int,
    height: int,
) -> SessionEntry:
    image_id = str(uuid.uuid4())
    entry = SessionEntry(
        image_id=image_id,
        original_bytes=original_bytes,
        raster_path=raster_path,
        kind=kind,
        page_count=page_count,
        width=width,
        height=height,
    )
    with _lock:
        _evict_stale()
        _store[image_id] = entry
    return entry


def get_entry(image_id: str) -> SessionEntry | None:
    with _lock:
        return _store.get(image_id)


def update_raster(image_id: str, new_path: str, width: int, height: int) -> None:
    """Replace the raster path for an existing entry (used when PDF page/DPI changes)."""
    with _lock:
        entry = _store.get(image_id)
        if entry is None:
            return
        old_path = entry.raster_path
        entry.raster_path = new_path
        entry.width = width
        entry.height = height
    # Remove the old temp file outside the lock
    if old_path != new_path and os.path.exists(old_path):
        try:
            os.unlink(old_path)
        except OSError:
            pass


def save_raster_to_temp(img) -> str:
    """Save a PIL Image to a temp PNG and return its path."""
    fd, path = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    img.save(path, format="PNG")
    return path


def _evict_stale() -> None:
    """Remove entries older than SESSION_TTL_SECONDS. Must be called under _lock."""
    now = time.time()
    stale = [k for k, v in _store.items() if now - v.created_at > SESSION_TTL_SECONDS]
    for k in stale:
        entry = _store.pop(k)
        if os.path.exists(entry.raster_path):
            try:
                os.unlink(entry.raster_path)
            except OSError:
                pass
