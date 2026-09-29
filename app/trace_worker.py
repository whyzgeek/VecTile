"""
Run engine tracing in a child process with a time and memory limit.

A trace that hangs (VTracer can spin with unbounded memory growth on some
inputs) would otherwise pin the server and eventually exhaust system memory.
Here each trace runs in its own process: it is killed after TRACE_TIMEOUT_S,
capped at TRACE_MEMORY_BYTES of address space, and superseded by a newer trace
for the same image (the browser has already abandoned the old request).
"""
import multiprocessing as mp
import resource
import threading

TRACE_TIMEOUT_S = 90
TRACE_MEMORY_BYTES = 8 * 1024 ** 3

# forkserver: children fork from a clean single-threaded server process with
# the engines pre-imported, rather than from the threaded web server.
_ctx = mp.get_context("forkserver")
_ctx.set_forkserver_preload(["app.engines"])

_lock = threading.Lock()
_active: dict[str, mp.Process] = {}  # job key -> running trace process


class TraceError(Exception):
    """The trace failed, hit a limit, or was superseded (see .superseded)."""

    def __init__(self, message: str, superseded: bool = False):
        super().__init__(message)
        self.superseded = superseded


def _child(conn, engine_id: str, image_path: str, params: dict, mem_bytes: int) -> None:
    try:
        resource.setrlimit(resource.RLIMIT_AS, (mem_bytes, mem_bytes))
        from app.engines import ENGINES
        conn.send(("ok", ENGINES[engine_id].vectorize(image_path, params)))
    except MemoryError:
        conn.send(("error", "Tracing ran out of memory. Try fewer colors or a higher Filter Speckle."))
    except BaseException as exc:  # includes Rust panics surfaced by pyo3
        conn.send(("error", f"Tracing failed: {type(exc).__name__}: {exc}"))
    finally:
        conn.close()


def trace(engine_id: str, image_path: str, params: dict, key: str | None = None,
          timeout: float = TRACE_TIMEOUT_S) -> str:
    """Trace image_path with the engine in a limited child process; return the SVG.

    key: jobs sharing a key supersede each other (the older one is killed).
    Raises TraceError on timeout, crash, memory exhaustion or supersession.
    """
    recv_conn, send_conn = _ctx.Pipe(duplex=False)
    proc = _ctx.Process(
        target=_child,
        args=(send_conn, engine_id, image_path, params, TRACE_MEMORY_BYTES),
        daemon=True,
    )
    with _lock:
        previous = _active.get(key) if key else None
        if previous is not None and previous.is_alive():
            previous.kill()
        proc.start()
        if key:
            _active[key] = proc
    send_conn.close()

    try:
        if not recv_conn.poll(timeout):
            raise TraceError(
                f"Tracing took longer than {int(timeout)} s and was stopped. "
                "Try fewer colors, a higher Filter Speckle, or Stacked hierarchy."
            )
        status, payload = recv_conn.recv()
    except EOFError:
        with _lock:
            superseded = bool(key) and _active.get(key) is not proc
        if superseded:
            raise TraceError("Superseded by a newer trace", superseded=True)
        raise TraceError("Tracing crashed (likely out of memory). Try fewer colors or a higher Filter Speckle.")
    finally:
        if proc.is_alive():
            proc.kill()
        proc.join(5)
        recv_conn.close()
        with _lock:
            if key and _active.get(key) is proc:
                del _active[key]

    if status != "ok":
        raise TraceError(payload)
    return payload
