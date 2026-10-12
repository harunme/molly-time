"""Create SQLite schema. Idempotent."""

from __future__ import annotations

from ..db import init_db
from ..config import get_settings


def main() -> None:
    s = get_settings()
    s.data_dir.mkdir(parents=True, exist_ok=True)
    init_db()
    print(f"[init_db] schema ready at {s.resolved_db_url()}")


if __name__ == "__main__":
    main()