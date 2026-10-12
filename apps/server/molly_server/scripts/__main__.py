"""CLI dispatcher: python -m molly_server.scripts <subcommand>."""

from __future__ import annotations

import sys

from . import create_admin, init_db

_DISPATCH = {
    "init_db": init_db.main,
    "create_admin": create_admin.main,
}


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print("usage: python -m molly_server.scripts <subcommand>")
        print("  subcommands:", ", ".join(sorted(_DISPATCH)))
        return 0
    cmd = sys.argv[1]
    fn = _DISPATCH.get(cmd)
    if fn is None:
        print(f"unknown subcommand: {cmd!r}", file=sys.stderr)
        return 2
    rc = fn()
    return int(rc) if isinstance(rc, int) else 0


if __name__ == "__main__":
    sys.exit(main())