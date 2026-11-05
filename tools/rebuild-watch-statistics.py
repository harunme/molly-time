"""Prepare legacy watch summaries before routing traffic to a new deployment."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps/server"))
from mollytime_server.watch_rollups import main

if __name__ == "__main__":
    main()
