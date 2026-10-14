"""Restricted SSH deployment receiver, compatible with server Python 3.6.

Install outside the uploaded release so the SSH command entrypoint stays fixed.
State and credentials remain in /opt/mollytime; only code/images are rolled back.
"""
import datetime
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request
import zipfile

ROOT = Path('/opt/mollytime')
STATE = ROOT / 'deployment-state.json'
LOCK = Path('/run/lock/mollytime-deploy.lock')
DIRECTORIES = ('apps/server/mollytime_server/', 'apps/web/dist/', 'apps/tv/web/dist/')
FILES = {
    'apps/server/pyproject.toml', 'infra/Dockerfile.prebuilt',
    'infra/compose.production.yaml', 'infra/compose.tls.yaml', 'infra/nginx-tls.conf',
}
OPTIONAL_FILES = {'artifacts/tv-client-plan.json', 'artifacts/mollytime-tv-release.apk'}


class ArtifactDownloadError(Exception):
    pass


def fetch_apk(destination, encoded_url, expected_sha):
    """Fetch the already uploaded CI artifact before changing the live application."""
    try:
        if len(encoded_url) > 5500 or not re.fullmatch('[A-Za-z0-9_-]+', encoded_url):
            raise ValueError('Invalid artifact URL encoding')
        url = base64.urlsafe_b64decode(encoded_url + '=' * (-len(encoded_url) % 4)).decode('ascii')
        parsed = urllib.parse.urlsplit(url)
        host = parsed.hostname or ''
        if (parsed.scheme != 'https' or len(url) > 4096
                or not (host.endswith('.blob.core.windows.net')
                        or host.endswith('.actions.githubusercontent.com'))
                or not re.fullmatch('[0-9a-f]{64}', expected_sha)):
            raise ValueError('Invalid artifact URL or APK digest')
        plan = read_json(destination / 'artifacts/tv-client-plan.json')
        if plan.get('requiresApk') is not True:
            raise ValueError('APK download requires a native release plan')
        archive = destination / 'artifacts/ci-apk-artifact.zip'
        request = urllib.request.Request(url, headers={'User-Agent': 'mollytime-deploy'})
        with urllib.request.urlopen(request, timeout=30) as response, archive.open('wb') as output:
            final = urllib.parse.urlsplit(response.geturl())
            final_host = final.hostname or ''
            if (final.scheme != 'https'
                    or not (final_host.endswith('.blob.core.windows.net')
                            or final_host.endswith('.actions.githubusercontent.com'))):
                raise ValueError('Artifact download redirected to an untrusted host')
            total = 0
            while True:
                chunk = response.read(128 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > 520 * 1024 ** 2:
                    raise ValueError('Artifact archive is too large')
                output.write(chunk)
        with zipfile.ZipFile(str(archive)) as bundle:
            matches = [member for member in bundle.infolist()
                       if member.filename == 'mollytime-tv-release.apk']
            if len(matches) != 1 or not 0 < matches[0].file_size <= 512 * 1024 ** 2:
                raise ValueError('Artifact contains no valid release APK')
            apk = destination / 'artifacts/mollytime-tv-release.apk'
            digest = hashlib.sha256()
            with bundle.open(matches[0]) as source, apk.open('wb') as output:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                    output.write(chunk)
            if digest.hexdigest() != expected_sha:
                raise ValueError('Downloaded APK SHA-256 does not match CI build')
        archive.unlink()
    except Exception as error:
        # Network exceptions can embed the short-lived signed URL.
        raise ArtifactDownloadError(type(error).__name__)


def read_json(path):
    with path.open('r', encoding='utf-8') as handle:
        value = handle.read(65537)
    if len(value.encode('utf-8')) > 65536:
        raise ValueError('Release metadata is too large')
    result = json.loads(value)
    if not isinstance(result, dict):
        raise ValueError('Release metadata must be an object')
    return result


def release_state():
    directory = ROOT / 'data/client-releases'
    if not directory.exists():
        return {'current': None, 'highestVersionCode': 0, 'versionNames': []}
    with (directory / '.publish.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_SH)
        highest = 0
        names = set()
        current = None
        latest = directory / 'com.molly.tv.json'
        paths = list((directory / 'history/com.molly.tv').glob('*/*.json'))
        if latest.exists():
            paths.append(latest)
        for path in paths:
            record = read_json(path)
            code = record.get('versionCode')
            sha = record.get('sha256', '')
            fingerprint = record.get('sourceFingerprint')
            if (record.get('packageName') != 'com.molly.tv' or type(code) is not int
                    or not 0 < code <= 2100000000 or not re.fullmatch('[0-9a-f]{64}', sha)
                    or (fingerprint is not None and not re.fullmatch('[0-9a-f]{64}', fingerprint))):
                raise ValueError('Invalid published TV release metadata')
            highest = max(highest, code)
            name = record.get('versionName')
            if not isinstance(name, str) or not 0 < len(name) <= 100:
                raise ValueError('Invalid published TV version name')
            names.add(name)
            if path == latest:
                current = {'versionCode': code, 'sha256': sha, 'sourceFingerprint': fingerprint,
                           'sourceCommit': record.get('sourceCommit'), 'versionName': name}
        return {'current': current, 'highestVersionCode': highest, 'versionNames': sorted(names)}


def validate_plan(destination, tag):
    plan_file = destination / 'artifacts/tv-client-plan.json'
    apk = destination / 'artifacts/mollytime-tv-release.apk'
    if not plan_file.exists():
        if apk.exists():
            raise ValueError('APK must include a CI publication plan')
        return None  # Support the old web-only workflow during receiver migration.
    plan = read_json(plan_file)
    required = plan.get('requiresApk')
    code = plan.get('versionCode')
    if (plan.get('schemaVersion') != 1 or type(required) is not bool
            or plan.get('sourceCommit') != tag or type(code) is not int
            or not 0 < code <= 2100000000
            or not re.fullmatch('[0-9a-f]{64}', plan.get('sourceFingerprint', ''))
            or not isinstance(plan.get('versionName'), str)
            or not 0 < len(plan['versionName']) <= 100
            or apk.exists() != required):
        raise ValueError('Invalid CI APK plan or artifact')
    if required and not 0 < apk.stat().st_size <= 512 * 1024 ** 2:
        raise ValueError('APK exceeds the publication limit')
    state = release_state()
    current = state['current']
    expected = None if current is None else {'versionCode': current['versionCode'], 'sha256': current['sha256']}
    if plan.get('expectedRelease') != expected:
        raise ValueError('Published APK changed during CI; rerun the workflow')
    if required:
        if code <= state['highestVersionCode']:
            raise ValueError('CI APK version must exceed all published versions')
    elif current is None or current['sourceFingerprint'] != plan['sourceFingerprint']:
        raise ValueError('Cannot skip APK without a matching published fingerprint')
    return plan


def publish_apk(destination, tag, plan):
    if not plan or not plan['requiresApk']:
        validate_plan(destination, tag)
        return
    notes = plan.get('releaseNotes') or '电视客户端更新'
    if not isinstance(notes, str) or len(notes) > 4000:
        raise ValueError('Invalid TV release notes')
    notes_file = destination / 'artifacts/tv-release-notes.txt'
    notes_file.write_text(notes, encoding='utf-8')
    compose(destination, tag, 'run', '--rm', '--no-deps',
            '-v', str(destination / 'artifacts') + ':/ci-release:ro',
            'mollytime-server', 'python', '-m',
            'mollytime_server.scripts.publish_tv_release',
            '/ci-release/mollytime-tv-release.apk', '--build-tools', '/usr/bin',
            '--storage', 'auto', '--ci-plan-file', '/ci-release/tv-client-plan.json',
            '--notes-file', '/ci-release/tv-release-notes.txt')


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
        if sum(member.size for member in members) > 768 * 1024 ** 2:
            raise ValueError('Unpacked release is too large')
        for member in members:
            name = member.name.rstrip('/')
            if name.startswith('/') or '..' in Path(name).parts:
                raise ValueError('Unsafe archive path')
            if not (member.isfile() or member.isdir()):
                raise ValueError('Archive links and special files are forbidden')
            if not (name in FILES | OPTIONAL_FILES or any(name.startswith(prefix) for prefix in DIRECTORIES)
                    or (member.isdir() and name + '/' in DIRECTORIES)):
                raise ValueError('Unexpected archive entry: ' + name)
        bundle.extractall(str(destination), members=members)
    required = FILES | {'apps/server/mollytime_server/main.py',
                        'apps/web/dist/index.html', 'apps/tv/web/dist/index.html'}
    if not all((destination / filename).is_file() for filename in required):
        raise ValueError('Release is incomplete')


def main():
    if sys.argv[1:] == ['--apk-state']:
        print(json.dumps(release_state()))
        return
    if len(sys.argv) not in (2, 4):
        raise ValueError('Invalid deployment arguments')
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
                if size > 640 * 1024 ** 2:
                    raise ValueError('Release archive is too large')
                output.write(chunk)
        unpack(archive, destination)
        if len(sys.argv) == 4:
            try:
                fetch_apk(destination, sys.argv[2], sys.argv[3])
            except ArtifactDownloadError as error:
                print('ARTIFACT_DOWNLOAD_FAILED: ' + str(error), file=sys.stderr)
                sys.exit(75)
        if shutil.disk_usage(str(ROOT)).free < 2 * 1024 ** 3 + archive.stat().st_size * 3:
            raise RuntimeError('Insufficient space to stage the APK release')
        plan = validate_plan(destination, tag)
        for name in ('.env', 'data', 'tls'):
            (destination / name).symlink_to(ROOT / name)
        (destination / '.dockerignore').write_text('.env\ndata\ntls\nartifacts\nrelease.tar.gz\n')
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
            # Prepare deployment bookkeeping before the final APK pointer update.
            env = ROOT / '.env'
            original_env = env.read_text(encoding='utf-8')
            original_state = STATE.read_text(encoding='utf-8') if STATE.exists() else None
            lines = original_env.splitlines()
            lines = ['MOLLYTIME_RELEASE=' + tag if line.startswith('MOLLYTIME_RELEASE=') else line for line in lines]
            try:
                atomic_write(env, '\n'.join(lines) + '\n')
                atomic_write(STATE, json.dumps({'path': str(destination), 'tag': tag}, indent=2) + '\n')
                publish_apk(destination, tag, plan)
            except Exception:
                atomic_write(env, original_env)
                if original_state is None:
                    if STATE.exists():
                        STATE.unlink()
                else:
                    atomic_write(STATE, original_state)
                raise
        except Exception:
            print('Deployment failed; restoring previous application version', flush=True)
            compose(Path(previous['path']), previous['tag'], 'up', '-d', '--wait',
                    '--wait-timeout', '180')
            raise
        print('Deployed ' + tag, flush=True)


if __name__ == '__main__':
    main()
