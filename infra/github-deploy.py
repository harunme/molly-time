"""Restricted SSH deployment receiver, compatible with server Python 3.6.

Install outside the uploaded release so the SSH command entrypoint stays fixed.
State and credentials remain in /opt/mollytime; only code/images are rolled back.
"""
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path('/opt/mollytime')
STATE = ROOT / 'deployment-state.json'
LOCK = Path('/run/lock/mollytime-deploy.lock')
DIRECTORIES = ('apps/server/mollytime_server/', 'apps/web/dist/', 'apps/tv/web/dist/')
FILES = {
    'apps/server/pyproject.toml', 'infra/Dockerfile.prebuilt',
    'infra/compose.production.yaml', 'infra/compose.tls.yaml', 'infra/nginx-tls.conf',
}


def run(args, env=None):
    subprocess.run([str(arg) for arg in args], check=True, env=env)


def compose(path, tag, *args):
    env = dict(os.environ, MOLLYTIME_RELEASE=tag)
    run(['docker', 'compose', '-p', 'infra', '--env-file', ROOT / '.env',
         '-f', path / 'infra/compose.production.yaml',
         '-f', path / 'infra/compose.tls.yaml'] + list(args), env=env)


def atomic_write(path, data, mode=0o600):
    fd, filename = tempfile.mkstemp(dir=str(path.parent))
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'w', encoding='utf-8') as output:
            output.write(data)
        os.replace(filename, str(path))
    finally:
        if os.path.exists(filename):
            os.unlink(filename)


def unpack(archive, destination):
    with tarfile.open(str(archive), 'r:gz') as bundle:
        members = bundle.getmembers()
        if sum(member.size for member in members) > 256 * 1024 ** 2:
            raise ValueError('Unpacked release is too large')
        for member in members:
            name = member.name.rstrip('/')
            if name.startswith('/') or '..' in Path(name).parts:
                raise ValueError('Unsafe archive path')
            if not (member.isfile() or member.isdir()):
                raise ValueError('Archive links and special files are forbidden')
            if not (name in FILES or any(name.startswith(prefix) for prefix in DIRECTORIES)
                    or (member.isdir() and name + '/' in DIRECTORIES)):
                raise ValueError('Unexpected archive entry: ' + name)
        bundle.extractall(str(destination), members=members)
    required = FILES | {'apps/server/mollytime_server/main.py',
                        'apps/web/dist/index.html', 'apps/tv/web/dist/index.html'}
    if not all((destination / filename).is_file() for filename in required):
        raise ValueError('Release is incomplete')


def main():
    tag = sys.argv[1]
    if not re.fullmatch('[0-9a-f]{40}', tag):
        raise ValueError('Invalid release SHA')
    with LOCK.open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if shutil.disk_usage(str(ROOT)).free < 2 * 1024 ** 3:
            raise RuntimeError('At least 2 GiB free disk space is required')
        previous = json.loads(STATE.read_text(encoding='utf-8')) if STATE.exists() else {
            'path': str(ROOT),
            'tag': next(line.split('=', 1)[1] for line in (ROOT / '.env').read_text(encoding='utf-8').splitlines()
                        if line.startswith('MOLLYTIME_RELEASE=')),
        }
        releases = ROOT / 'releases'
        releases.mkdir(exist_ok=True)
        destination = Path(tempfile.mkdtemp(prefix=tag + '-', dir=str(releases)))
        archive = destination / 'release.tar.gz'
        with archive.open('wb') as output:
            size = 0
            while True:
                chunk = sys.stdin.buffer.read(1024 ** 2)
                if not chunk:
                    break
                size += len(chunk)
                if size > 64 * 1024 ** 2:
                    raise ValueError('Release archive is too large')
                output.write(chunk)
        unpack(archive, destination)
        for name in ('.env', 'data', 'tls'):
            (destination / name).symlink_to(ROOT / name)
        (destination / '.dockerignore').write_text('.env\ndata\ntls\nrelease.tar.gz\n')
        compose(destination, tag, 'config', '--quiet')
        compose(destination, tag, 'build', 'mollytime-server')
        timestamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        backup_name = 'deploy-{}-{}.sqlite'.format(timestamp, tag[:12])
        backup_code = (
            'import sqlite3; from pathlib import Path; '
            'p=Path("/data/backups"); p.mkdir(exist_ok=True); '
            'source=sqlite3.connect("/data/server.db"); '
            'target=sqlite3.connect(str(p / {!r})); '
            'source.backup(target); target.close(); source.close()'
        ).format(backup_name)
        run(['docker', 'exec', 'mollytime-server', 'python', '-c', backup_code])
        try:
            compose(destination, tag, 'up', '-d', '--wait', '--wait-timeout', '180')
            # Docker exec bypasses the cloud firewall but still verifies the real
            # certificate, TLS proxy, scheme and each public page.
            for path in ('/healthz', '/manage/', '/tv/'):
                run(['docker', 'exec', 'mollytime-tls', 'curl', '--fail', '--silent',
                     '--show-error', '--output', '/dev/null', '--max-time', '15',
                     '--resolve', '118.89.122.66:8096:127.0.0.1',
                     'https://118.89.122.66:8096' + path])
        except Exception:
            print('Deployment failed; restoring previous application version', flush=True)
            compose(Path(previous['path']), previous['tag'], 'up', '-d', '--wait',
                    '--wait-timeout', '180')
            raise
        env = ROOT / '.env'
        lines = env.read_text(encoding='utf-8').splitlines()
        lines = ['MOLLYTIME_RELEASE=' + tag if line.startswith('MOLLYTIME_RELEASE=')
                 else line for line in lines]
        atomic_write(env, '\n'.join(lines) + '\n')
        atomic_write(STATE, json.dumps({'path': str(destination), 'tag': tag}, indent=2) + '\n')
        print('Deployed ' + tag, flush=True)


if __name__ == '__main__':
    main()
