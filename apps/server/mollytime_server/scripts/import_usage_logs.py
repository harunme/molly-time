"""Import downloaded OSS access logs; safe to rerun overlapping files."""

import argparse
import json
from pathlib import Path

from fastapi import HTTPException

from ..db import get_session_factory, init_db
from ..usage import MAX_LOG_BYTES, import_oss_logs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+", type=Path)
    args = parser.parse_args()
    init_db()
    for path in args.files:
        with path.open("rb") as stream:
            data = stream.read(MAX_LOG_BYTES + 1)
        with get_session_factory()() as db:
            try:
                result = import_oss_logs(db, data)
            except HTTPException as exc:
                parser.exit(1, f"{path.name}: {exc.detail}\n")
            print(json.dumps({"file": path.name, **result}, ensure_ascii=False))


if __name__ == "__main__":
    main()
