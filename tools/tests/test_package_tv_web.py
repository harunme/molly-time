import hashlib
import importlib.util
import json
import zipfile
from pathlib import Path


spec = importlib.util.spec_from_file_location(
    "package_tv_web", Path(__file__).resolve().parents[1] / "package-tv-web.py"
)
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


def test_package_tv_web_writes_deterministic_manifest_and_bundle(tmp_path, monkeypatch):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<main>TV</main>")
    (dist / "assets/app.js").write_text("window.tv=true")
    monkeypatch.setattr(package, "DIST", dist)
    monkeypatch.setattr(package, "BUNDLE", dist / "web-bundle.zip")
    monkeypatch.setattr(package, "MANIFEST", dist / "web-release.json")

    package.main()
    first = (dist / "web-bundle.zip").read_bytes()
    package.main()
    manifest = json.loads((dist / "web-release.json").read_text())

    assert first == (dist / "web-bundle.zip").read_bytes()
    assert manifest["sha256"] == hashlib.sha256(first).hexdigest()
    assert manifest["webVersion"] == manifest["sha256"][:16]
    assert manifest["minBridgeVersion"] == manifest["maxBridgeVersion"] == 1
    assert manifest["size"] == len(first)
    with zipfile.ZipFile(dist / "web-bundle.zip") as archive:
        assert set(archive.namelist()) == {"index.html", "assets/app.js"}
