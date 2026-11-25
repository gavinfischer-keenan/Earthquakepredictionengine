"""Main entry point — thin CLI & engine facade."""
from __future__ import annotations

from eqengine.cli import _run_calibrate, _run_replay, cli
from eqengine.engine import SeismicEngine, run_engine

__all__ = [
    "SeismicEngine",
    "_run_calibrate",
    "_run_replay",
    "cli",
    "run_engine",
]

if __name__ == "__main__":
    cli()
