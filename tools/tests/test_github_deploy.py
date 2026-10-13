"""Archive safety and application rollback without touching the live server."""
import importlib.util
import base64
import hashlib
import io
import json
from pathlib import Path
import tarfile
import zipfile
from types import SimpleNamespace
from unittest.mock import patch

import pytest

spec = importlib.util.spec_from_file_location(
    'github_deploy', Path(__file__).resolve().parents[2] / 'infra/github-deploy.py'
)
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


def archive_bytes(extra=None):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as archive:
        names = deploy.FILES | {
            'apps/server/mollytime_server/main.py', 'apps/web/dist/index.html',
            'apps/tv/web/dist/index.html',
        }
        for name in names:
            member = tarfile.TarInfo(name)
            member.size = 4
            archive.addfile(member, io.BytesIO(b'test'))
        if extra is not None:
            archive.addfile(extra, io.BytesIO(b''))
    return output.getvalue()


@pytest.mark.parametrize('name', ['../.env', '/root/.ssh/authorized_keys', 'data/server.db'])
def test_rejects_paths_outside_release(tmp_path, name):
    archive = tmp_path / 'release.tar.gz'
    archive.write_bytes(archive_bytes(tarfile.TarInfo(name)))
    target = tmp_path / 'unpacked'
    target.mkdir()
    with pytest.raises(ValueError):
        deploy.unpack(archive, target)
    assert not list(target.iterdir())


def test_rejects_archive_symlinks(tmp_path):
    member = tarfile.TarInfo('apps/web/dist/private')
    member.type = tarfile.SYMTYPE
    member.linkname = '/opt/mollytime/.env'
    archive = tmp_path / 'release.tar.gz'
    archive.write_bytes(archive_bytes(member))
    with pytest.raises(ValueError):
        deploy.unpack(archive, tmp_path / 'unpacked')


@pytest.mark.parametrize('failure', ['none', 'build', 'health'])
def test_deployment_preserves_state_and_rolls_back_on_failure(tmp_path, failure):
    root = tmp_path / 'server'
    root.mkdir()
    (root / '.env').write_text('MOLLYTIME_RELEASE=previous\nMOLLYTIME_AUTH_SECRET=keep\n')
    original_env = (root / '.env').read_text()
    calls = []

    def compose(path, tag, *args):
        calls.append((path, tag, args))
        if failure == 'build' and args[0] == 'build':
            raise RuntimeError('Build failed')
        if failure == 'health' and args[0] == 'up' and tag != 'previous':
            raise RuntimeError('Health failed')

    tag = 'a' * 40
    with patch.multiple(deploy, ROOT=root, STATE=root / 'deployment-state.json',
                        LOCK=root / 'deploy.lock'), \
            patch.object(deploy, 'compose', side_effect=compose), \
            patch.object(deploy, 'run') as run, \
            patch.object(deploy.shutil, 'disk_usage', return_value=SimpleNamespace(free=10 * 1024 ** 3)), \
            patch.object(deploy.sys, 'argv', ['github-deploy.py', tag]), \
            patch.object(deploy.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(archive_bytes()))):
        if failure == 'none':
            deploy.main()
            assert (root / 'deployment-state.json').exists()
            assert 'MOLLYTIME_RELEASE=' + tag in (root / '.env').read_text()
            assert 'MOLLYTIME_AUTH_SECRET=keep' in (root / '.env').read_text()
            assert (root / '.env').stat().st_mode & 0o777 == 0o600
            assert any(call.args[0][:3] == ['docker', 'exec', 'mollytime-server']
                       for call in run.call_args_list)
        else:
            with pytest.raises(RuntimeError):
                deploy.main()
            assert not (root / 'deployment-state.json').exists()
            assert (root / '.env').read_text() == original_env
            if failure == 'health':
                assert calls[-1][0] == root and calls[-1][1] == 'previous'
            else:
                assert not any(args[0] == 'up' for _, _, args in calls)


def seed_release(root, version=5, fingerprint='b' * 64):
    directory = root / 'data/client-releases'
    directory.mkdir(parents=True, exist_ok=True)
    value = {'packageName': 'com.molly.tv', 'versionCode': version,
             'sha256': 'c' * 64, 'sourceFingerprint': fingerprint}
    (directory / 'com.molly.tv.json').write_text(json.dumps(value))
    return value


def test_state_uses_published_fingerprint_and_all_historical_versions(tmp_path):
    current = seed_release(tmp_path)
    current['sourceCommit'] = 'a' * 40
    (tmp_path / 'data/client-releases/com.molly.tv.json').write_text(json.dumps(current))
    history = tmp_path / 'data/client-releases/history/com.molly.tv/9'
    history.mkdir(parents=True)
    (history / ('d' * 64 + '.json')).write_text(json.dumps(dict(current, versionCode=9, sha256='d' * 64)))
    with patch.object(deploy, 'ROOT', tmp_path):
        result = deploy.release_state()
    assert result['current']['versionCode'] == 5
    assert result['current']['sourceFingerprint'] == 'b' * 64
    assert result['current']['sourceCommit'] == 'a' * 40
    assert result['highestVersionCode'] == 9


@pytest.mark.parametrize('changed', [False, True])
def test_plan_does_not_allow_skipping_changed_native_inputs(tmp_path, changed):
    current = seed_release(tmp_path)
    artifacts = tmp_path / 'bundle/artifacts'
    artifacts.mkdir(parents=True)
    plan = {'schemaVersion': 1, 'requiresApk': False, 'sourceCommit': 'a' * 40,
            'sourceFingerprint': ('e' if changed else 'b') * 64, 'versionCode': 5,
            'versionName': '0.4.0+5',
            'expectedRelease': {'versionCode': 5, 'sha256': current['sha256']}}
    (artifacts / 'tv-client-plan.json').write_text(json.dumps(plan))
    with patch.object(deploy, 'ROOT', tmp_path):
        if changed:
            with pytest.raises(ValueError):
                deploy.validate_plan(artifacts.parent, 'a' * 40)
        else:
            assert deploy.validate_plan(artifacts.parent, 'a' * 40) == plan


def test_rejects_ci_plan_that_raced_with_a_manual_publication(tmp_path):
    seed_release(tmp_path)
    artifacts = tmp_path / 'bundle/artifacts'
    artifacts.mkdir(parents=True)
    plan = {'schemaVersion': 1, 'requiresApk': True, 'sourceCommit': 'a' * 40,
            'sourceFingerprint': 'b' * 64, 'versionCode': 6, 'versionName': '0.4.0+6',
            'expectedRelease': None}
    (artifacts / 'tv-client-plan.json').write_text(json.dumps(plan))
    (artifacts / 'mollytime-tv-release.apk').write_bytes(b'apk')
    with patch.object(deploy, 'ROOT', tmp_path), pytest.raises(ValueError, match='changed during CI'):
        deploy.validate_plan(artifacts.parent, 'a' * 40)


def test_deploy_receiver_remains_python36_compatible():
    import ast
    source = (Path(__file__).resolve().parents[2] / 'infra/github-deploy.py').read_text()
    ast.parse(source, feature_version=(3, 6))


def test_fetches_ci_artifact_and_checks_apk_digest(tmp_path):
    apk = b'signed-release-apk'
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w') as bundle:
        bundle.writestr('mollytime-tv-release.apk', apk)
        bundle.writestr('tv-client-plan.json', '{}')
    artifacts = tmp_path / 'artifacts'
    artifacts.mkdir()
    (artifacts / 'tv-client-plan.json').write_text('{"requiresApk": true}')
    url = 'https://example.blob.core.windows.net/artifact?sig=short-lived'
    encoded = base64.urlsafe_b64encode(url.encode()).decode().rstrip('=')

    class Response(io.BytesIO):
        def geturl(self):
            return url

    with patch.object(deploy.urllib.request, 'urlopen', return_value=Response(data.getvalue())):
        deploy.fetch_apk(tmp_path, encoded, hashlib.sha256(apk).hexdigest())
    assert (artifacts / 'mollytime-tv-release.apk').read_bytes() == apk
    assert not (artifacts / 'ci-apk-artifact.zip').exists()

    with patch.object(deploy.urllib.request, 'urlopen', return_value=Response(data.getvalue())):
        with pytest.raises(deploy.ArtifactDownloadError):
            deploy.fetch_apk(tmp_path, encoded, '0' * 64)


@pytest.mark.parametrize('failure', [False, True])
@pytest.mark.parametrize('release_notes', ['修复播放卡顿', None])
def test_apk_publication_failure_restores_application_state(tmp_path, failure, release_notes):
    root = tmp_path / 'server'
    root.mkdir()
    (root / '.env').write_text('MOLLYTIME_RELEASE=previous\nMOLLYTIME_AUTH_SECRET=keep\n')
    original_env = (root / '.env').read_text()
    current = seed_release(root)
    tag = 'a' * 40
    plan = {'schemaVersion': 1, 'requiresApk': True, 'sourceCommit': tag,
            'sourceFingerprint': 'd' * 64, 'versionCode': 6, 'versionName': '0.4.0+6',
            'expectedRelease': {'versionCode': 5, 'sha256': current['sha256']},
            'reason': 'native-inputs-changed', 'inputCount': 20,
            'releaseNotes': release_notes}
    bundle = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(archive_bytes()), mode='r:gz') as old, \
            tarfile.open(fileobj=bundle, mode='w:gz') as archive:
        for member in old.getmembers():
            archive.addfile(member, old.extractfile(member))
        for name, data in [('artifacts/tv-client-plan.json', json.dumps(plan).encode()),
                           ('artifacts/mollytime-tv-release.apk', b'signed-apk')]:
            member = tarfile.TarInfo(name)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    calls = []
    def compose(path, sha, *args):
        calls.append((sha, args))
        if args[0] == 'run':
            assert json.loads((root / 'deployment-state.json').read_text())['tag'] == tag
            assert args[-2:] == ('--notes-file', '/ci-release/tv-release-notes.txt')
            assert (Path(args[4].split(':', 1)[0]) / 'tv-release-notes.txt').read_text(encoding='utf-8') == (release_notes or '电视客户端更新')
            assert all(str(arg).isascii() for arg in args)
            if failure:
                raise RuntimeError('APK publication failed')
    with patch.multiple(deploy, ROOT=root, STATE=root / 'deployment-state.json', LOCK=root / 'deploy.lock'), \
            patch.object(deploy, 'compose', side_effect=compose), patch.object(deploy, 'run'), \
            patch.object(deploy.shutil, 'disk_usage', return_value=SimpleNamespace(free=10 * 1024 ** 3)), \
            patch.object(deploy.sys, 'argv', ['github-deploy.py', tag]), \
            patch.object(deploy.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(bundle.getvalue()))):
        if failure:
            with pytest.raises(RuntimeError, match='APK publication failed'):
                deploy.main()
            assert (root / '.env').read_text() == original_env
            assert not (root / 'deployment-state.json').exists()
            assert calls[-1][0] == 'previous' and calls[-1][1][0] == 'up'
        else:
            deploy.main()
            assert any(args[0] == 'run' for _, args in calls)
            assert json.loads((root / 'deployment-state.json').read_text())['tag'] == tag
