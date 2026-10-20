"""Verify an archive's executable and its local credential lifecycle on an isolated CI runner."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import subprocess
import tempfile
import zipfile
from datetime import datetime, timedelta, timezone

TARGETS = {('Darwin', 'arm64'): 'darwin-arm64', ('Linux', 'x86_64'): 'linux-x64',
           ('Windows', 'AMD64'): 'windows-x64'}
NATIVE = r'''
const action = Bun.argv[1];
const input = JSON.parse(await Bun.stdin.text());
const options = {service: 'com.fidy.cli.api.fidyapp.com', name: 'login'};
const current = await Bun.secrets.get(options);
if (action === 'empty') {
  process.stdout.write(JSON.stringify(current === null));
} else if (action === 'seed') {
  if (current !== null) process.exit(1);
  await Bun.secrets.set({...options, value: input.value, persist: 'local'});
  process.stdout.write('true');
} else if (action === 'cleanup') {
  if (current !== null && current !== input.value) process.exit(1);
  if (current !== null) await Bun.secrets.delete(options);
  process.stdout.write('true');
} else process.exit(1);
'''


def require(condition, message):
    if not condition:
        raise ValueError(message)


def run(command, *, env=None, data=None):
    result = subprocess.run(command, input=data, capture_output=True, text=True,
                            env=env, timeout=15)
    require(len(result.stdout) + len(result.stderr) <= 32768, 'Unexpected output size')
    return result


def native(action, value=None):
    result = run(['bun', '-e', NATIVE, action], data=json.dumps({'value': value}))
    require(result.returncode == 0 and result.stdout == 'true',
            'Native credential precondition or cleanup failed; existing access was preserved')


def invoke(binary, home, arguments, bearer, expected_code=0):
    required = ('PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR',
                'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'LOCALAPPDATA', 'APPDATA',
                'LANG', 'LC_ALL')
    environment = {key: os.environ[key] for key in required if key in os.environ}
    environment['USERPROFILE' if os.name == 'nt' else 'HOME'] = str(home)
    result = run([str(binary), *arguments], env=environment)
    require(bearer not in result.stdout + result.stderr, 'Packaged CLI disclosed credential material')
    if result.returncode != expected_code:
        code = None
        try:
            code = json.loads(result.stderr).get('code')
        except (ValueError, AttributeError):
            pass
        allowed = {'StorageUnavailable', 'StorageInconsistent', 'UnsupportedRuntime', 'InvalidInput'}
        if code in allowed:
            print('Packaged CLI closed failure: ' + code, flush=True)
        raise ValueError('Packaged CLI returned an unexpected status')
    return result


def grant():
    created = datetime.now(timezone.utc).replace(microsecond=0)
    iso = lambda value: value.isoformat().replace('+00:00', 'Z')
    return {'origin': 'https://api.fidyapp.com', 'pat': {
        '_tag': 'PAT', 'id': '01900000-0000-4000-8000-000000000001',
        'shortId': 'relcheck', 'recipientLabel': 'Synthetic release verification',
        'scopes': ['read'], 'lifetimeDays': 7, 'lastUsedAt': None, 'revokedAt': None,
        'createdAt': iso(created), 'expiresAt': iso(created + timedelta(days=7))}}


def credentials(binary, root):
    require(os.environ.get('GITHUB_ACTIONS') == 'true'
            and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted',
            'Credential verification requires an isolated GitHub-hosted runner')
    native('empty')
    print('Native empty-slot preflight passed.', flush=True)
    # macOS Keychain resolution depends on HOME. Keep the disposable runner's
    # initialized home; a made-up home does not have an initialized native store.
    home = Path(os.environ['HOME']) if platform.system() == 'Darwin' else root / 'home'
    directory = home / '.fidy' / 'cli'
    require(not directory.exists() and not directory.is_symlink(),
            'Packaged credential directory already exists; existing access was preserved')
    directory.mkdir(parents=True, mode=0o700)
    metadata = directory / 'grant.json'
    bearer = 'fin_relcheck_' + secrets.token_urlsafe(32)
    native('seed', bearer)
    print('Synthetic native credential seeded.', flush=True)
    try:
        metadata.write_text(json.dumps(grant()))
        metadata.chmod(0o600)
        for arguments in (['status', '--json'], ['status']):
            output = invoke(binary, home, arguments, bearer)
            require('"availability":"available"' in output.stdout,
                    'Packaged CLI could not load native credentials')
            require('Synthetic release verification' in output.stdout,
                    'Packaged CLI did not load the intended grant')
        print('Packaged native credential loading and redaction passed.', flush=True)
        metadata.write_text('{invalid synthetic metadata')
        refusal = invoke(binary, home, ['status', '--json'], bearer, expected_code=1)
        require(json.loads(refusal.stderr).get('code') == 'StorageInconsistent',
                'Malformed metadata did not fail safely')
        print('Packaged malformed-metadata refusal passed.', flush=True)
        metadata.write_text(json.dumps(grant()))
        logout = invoke(binary, home, ['logout', '--json'], bearer)
        require(json.loads(logout.stdout) == {'_tag': 'LoggedOut'}, 'Logout was not confirmed')
        native('empty')
        require(not metadata.exists(), 'Logout retained grant metadata')
        absent = invoke(binary, home, ['status', '--json'], bearer)
        require(json.loads(absent.stdout) == {'_tag': 'LocalStatus', 'availability': 'absent'},
                'Logged-out executable retained usable local access')
        require(not (directory / 'login.lock').exists(), 'Packaged CLI retained its lock')
    finally:
        native('cleanup', bearer)
        shutil.rmtree(directory)
    print('Packaged executable: native load, redaction, malformed-state refusal and logout passed.')


def verify(directory, *, version=None, credential_check=False):
    target = TARGETS.get((platform.system(), platform.machine()))
    require(target is not None, 'Unsupported packaged executable target')
    archive = directory / f'fidy-{target}.zip'
    manifest = archive.with_name(archive.name + '.sha256').read_text()
    match = re.fullmatch(r'([a-f0-9]{64})  ' + re.escape(archive.name) + r'\n', manifest)
    require(match is not None, 'Invalid archive checksum manifest')
    require(hashlib.sha256(archive.read_bytes()).hexdigest() == match[1], 'Archive checksum mismatch')
    with tempfile.TemporaryDirectory(prefix='fidy-packaged-') as temporary:
        root = Path(temporary)
        name = 'fidy.exe' if os.name == 'nt' else 'fidy'
        with zipfile.ZipFile(archive) as bundle:
            require(bundle.namelist() == [name], 'Unexpected archive entries')
            binary = root / name
            binary.write_bytes(bundle.read(name))
            binary.chmod(0o700)
        expected = f'fidy {version}' if version else None
        output = run([str(binary), '--version'])
        require(output.returncode == 0 and (expected is None or output.stdout.strip() == expected),
                'Packaged executable version mismatch')
        require(run([str(binary), '--help']).returncode == 0, 'Packaged executable help failed')
        print(f'Archive checksum, entry and executable identity passed: {target}.')
        if credential_check:
            credentials(binary, root)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, default=Path('dist/cli-release'))
    parser.add_argument('--version')
    parser.add_argument('--credentials', action='store_true')
    arguments = parser.parse_args()
    try:
        verify(arguments.directory, version=arguments.version, credential_check=arguments.credentials)
    except ValueError as failure:
        safe = {
            'Native credential precondition or cleanup failed; existing access was preserved',
            'Packaged credential directory already exists; existing access was preserved',
            'Credential verification requires an isolated GitHub-hosted runner',
            'Packaged CLI disclosed credential material',
            'Packaged CLI returned an unexpected status',
            'Packaged CLI could not load native credentials',
            'Packaged CLI did not load the intended grant',
            'Malformed metadata did not fail safely',
            'Logout was not confirmed', 'Logout retained grant metadata',
            'Logged-out executable retained usable local access', 'Packaged CLI retained its lock',
        }
        message = str(failure) if str(failure) in safe else 'Artifact or output verification failed'
        raise SystemExit(message + '; no credential material is reported.') from None
    except (OSError, subprocess.SubprocessError, zipfile.BadZipFile):
        raise SystemExit('Packaged CLI verification failed; no credential material is reported.') from None
