import base64
import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location('package_startup_sound', Path(__file__).resolve().parents[1] / 'package-startup-sound.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


def record():
    audio = b'ID3-launch-sound'
    return audio, dict(filename='welcome.mp3', durationMs=2000, version=hashlib.sha256(audio).hexdigest(), data=base64.b64encode(audio).decode())


def test_snapshot_contains_verified_audio_and_no_server_credentials(tmp_path):
    audio, config = record()
    source = tmp_path / 'source.json'; source.write_text(json.dumps(config))
    output = tmp_path / 'assets'
    manifest = package.package(output, config_file=source)
    assert (output / 'startup/sound.mp3').read_bytes() == audio
    assert json.loads((output / 'startup/config.json').read_text()) == manifest
    assert manifest['configured'] is True and 'data' not in manifest
    package.package(output, silent=True)
    assert not (output / 'startup/sound.mp3').exists()
    assert json.loads((output / 'startup/config.json').read_text()) == {'configured': False}


def test_network_snapshot_constructs_same_origin_asset_url(tmp_path, monkeypatch):
    audio, record_ = record()
    config = {**record_, 'configured': True, 'audioUrl': 'https://evil.invalid/audio'}
    requests = []
    def fetch(url, limit):
        requests.append(url)
        return json.dumps(config).encode() if url.endswith('/api/startup') else audio
    monkeypatch.setattr(package, 'download', fetch)
    package.package(tmp_path, source='https://mollytime.app')
    assert requests == ['https://mollytime.app/api/startup', 'https://mollytime.app/api/startup/audio/' + config['version']]


def test_invalid_audio_and_network_failure_do_not_replace_prepared_assets(tmp_path, monkeypatch):
    audio, config = record()
    source = tmp_path / 'source.json'; source.write_text(json.dumps(config))
    output = tmp_path / 'assets'; package.package(output, config_file=source)
    original = (output / 'startup/config.json').read_bytes()
    config['data'] = base64.b64encode(b'corrupted').decode(); source.write_text(json.dumps(config))
    with pytest.raises(ValueError): package.package(output, config_file=source)
    assert (output / 'startup/config.json').read_bytes() == original
    assert (output / 'startup/sound.mp3').read_bytes() == audio
    def failed(*_): raise OSError('offline')
    monkeypatch.setattr(package, 'download', failed)
    with pytest.raises(OSError): package.package(output, source='https://mollytime.app')
    assert (output / 'startup/config.json').read_bytes() == original


def test_missing_configured_flag_is_not_assumed_silent(tmp_path, monkeypatch):
    monkeypatch.setattr(package, 'download', lambda *_: b'{}')
    with pytest.raises(ValueError): package.package(tmp_path, source='https://mollytime.app')
    assert not (tmp_path / 'startup/config.json').exists()
