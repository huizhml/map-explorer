"""Process-wide lock that serializes all matplotlib/pyplot rendering.

matplotlib's pyplot interface is **not thread-safe**: it keeps global mutable
state (``rcParams``, the ``Gcf`` figure registry, the shared Agg renderer). The
figure routes run their renderers in a thread pool via ``run_in_executor``, so
without serialization two renders can touch pyplot at the same time and corrupt
each other's output or hang outright (the heavy 3D ``plot_surface`` +
``canvas.draw()`` path is the most prone to this).

Every pyplot render acquires this single lock so only one runs at a time. Renders
are CPU-bound and already serialized by the GIL, so the throughput cost is
negligible for the app's single-user, click-to-render workflow.
"""

from __future__ import annotations

import threading
from typing import Callable, TypeVar

RENDER_LOCK = threading.Lock()

T = TypeVar("T")


def locked_render(fn: Callable[..., T], *args, **kwargs) -> T:
    """Run a matplotlib/pyplot render under the process-wide render lock.

    Call this from inside the worker callable passed to ``run_in_executor`` so the
    lock is held on the worker thread, never on the event loop.
    """
    with RENDER_LOCK:
        return fn(*args, **kwargs)
