#!/usr/bin/env python3
"""Create a deterministic, verifiable TV Web update bundle beside Vite output."""

import hashlib
import json
import os
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "apps/tv/web/dist"
BUNDLE = DIST / "web-bundle.zip"
MANIFEST = DIST / "web-release.json"
EXCLUDED = {BUNDLE.name, MANIFEST.name}


def main() -> None:
    if not (DIST / "index.html").is_file():
        raise SystemExit("TV Web build is missing; run tools/build-tv-web.sh first")
    with tempfile.NamedTemporaryFile(dir=DIST.parent, suffix=".zip", delete=False) as temporary:
        temporary_path = Path(temporary.name)
    try:
        with zipfile.ZipFile(temporary_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for path in sorted(DIST.rglob("*")):
                if not path.is_file() or path.name in EXCLUDED:
                    continue
                name = path.relative_to(DIST).as_posix()
                info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, path.read_bytes())
        digest = hashlib.sha256(temporary_path.read_bytes()).hexdigest()
        os.replace(temporary_path, BUNDLE)
        manifest = {
            "webVersion": digest[:16],
            "minBridgeVersion": 1,
            "maxBridgeVersion": 1,
            "size": BUNDLE.stat().st_size,
            "sha256": digest,
        }
        MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n")
    finally:
        temporary_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
