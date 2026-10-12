"""Archive safety and application rollback without touching the live server."""
import importlib.util
import io
from pathlib import Path
import tarfile
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
