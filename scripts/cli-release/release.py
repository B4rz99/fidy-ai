"""Plan and publish complete CLI releases; GitHub's latest marker advances only after anonymous verification."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

REPOSITORY = 'B4rz99/fidy-ai'
TARGETS = ('darwin-arm64', 'linux-x64', 'windows-x64')
VERSION = re.compile(r'^[0-9]+\.[0-9]+\.[0-9]+$')
SHA = re.compile(r'^[a-f0-9]{40}$')
DIGEST = re.compile(r'^[a-f0-9]{64}$')
ROOT = Path(__file__).resolve().parents[2]


def run(*args):
    return subprocess.run(args, cwd=ROOT, check=True, capture_output=True, text=True).stdout


def api(path):
    return json.loads(run('gh', 'api', f'repos/{REPOSITORY}/{path}'))


def read_plan(value):
    if (not isinstance(value, dict) or not isinstance(value.get('version'), str)
            or not VERSION.fullmatch(value['version']) or not isinstance(value.get('fingerprint'), str)
            or not DIGEST.fullmatch(value['fingerprint']) or not isinstance(value.get('gitRevision'), str)
            or not SHA.fullmatch(value['gitRevision']) or not isinstance(value.get('changed'), bool)):
        raise ValueError('Invalid CLI release manifest')
    return value


def fingerprint():
    with tempfile.TemporaryDirectory() as temporary:
        bundle = Path(temporary) / 'cli.js'
        metadata = Path(temporary) / 'inputs.json'
        run('bun', 'build', 'apps/cli/src/main.ts', '--target=bun', '--minify',
            f'--outfile={bundle}', f'--metafile={metadata}')
        inputs = json.loads(metadata.read_text())['inputs']
        paths = set(inputs) | {'apps/cli/package.json', 'scripts/install-bun.sh'}
        for name in inputs:
            parts = Path(name).parts
            if parts[0] == 'node_modules':
                package_parts = parts[:3] if parts[1].startswith('@') else parts[:2]
                package = Path(*package_parts)
                paths.add(str(package / 'package.json'))
                paths.update(str(path.relative_to(ROOT)) for path in (ROOT / package).iterdir()
                             if path.is_file() and path.name.lower().startswith(('license', 'copying', 'notice')))
        paths.update(str(path.relative_to(ROOT)) for path in (ROOT / 'scripts/cli-release').iterdir()
                     if path.is_file() and not path.name.startswith('test-'))
        paths.update(str(path.relative_to(ROOT)) for path in (ROOT / '.github/workflows').glob('cli-release*.yml'))
        digest = hashlib.sha256()
        for name in sorted(paths):
            path = ROOT / name
            if not path.is_file():
                raise ValueError(f'Missing CLI build input: {name}')
            digest.update(name.encode() + b'\0' + hashlib.sha256(path.read_bytes()).digest())
        return digest.hexdigest()


def plan(sha, output):
    if not SHA.fullmatch(sha):
        raise ValueError('A full source revision is required')
    pages = json.loads(run('gh', 'api', f'repos/{REPOSITORY}/releases', '--paginate', '--slurp'))
    releases = [release for page in pages for release in page
                if re.fullmatch(r'cli-v[0-9]+\.[0-9]+\.[0-9]+', release['tag_name'])]
    published = [release for release in releases if not release['draft'] and not release['prerelease']]
    version_key = lambda release: tuple(map(int, release['tag_name'][5:].split('.')))
    current = None
    if published:
        try:
            current = api('releases/latest')
        except subprocess.CalledProcessError as error:
            if 'HTTP 404' not in error.stderr:
                raise
        if current is not None and not re.fullmatch(r'cli-v[0-9]+\.[0-9]+\.[0-9]+', current['tag_name']):
            raise ValueError('Latest stable release must belong to the CLI')
    digest = fingerprint()
    changed = True
    if current is not None:
        with tempfile.TemporaryDirectory() as temporary:
            run('gh', 'release', 'download', current['tag_name'], '--repo', REPOSITORY,
                '--pattern', 'cli-release.json', '--dir', temporary)
            previous = read_plan(json.loads((Path(temporary) / 'cli-release.json').read_text()))
            if previous['version'] != current['tag_name'][5:]:
                raise ValueError('Published CLI version mismatch')
            changed = previous['fingerprint'] != digest
    if not changed:
        version = current['tag_name'][5:]
    elif releases:
        major, minor, patch = max(map(version_key, releases))
        version = f'{major}.{minor}.{patch + 1}'
    else:
        version = '0.1.0'
    result = {'changed': changed, 'version': version, 'fingerprint': digest, 'gitRevision': sha}
    Path(output).write_text(json.dumps(result, indent=2) + '\n')
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as destination:
            destination.write(f'changed={str(changed).lower()}\nversion={version}\n')
    print(json.dumps(result))


def publish(plan_path, directory):
    release = read_plan(json.loads(Path(plan_path).read_text()))
    if not release['changed']:
        return
    if api('git/ref/heads/trunk')['object']['sha'] != release['gitRevision']:
        raise ValueError('Source was superseded; leaving the previous default active')
    if fingerprint() != release['fingerprint']:
        raise ValueError('CLI inputs changed after planning')
    if not api('immutable-releases')['enabled']:
        raise ValueError('Enable GitHub release immutability before CLI publication')
    directory = Path(directory)
    assets = []
    for target in TARGETS:
        archive = directory / f'fidy-{target}.zip'
        checksum = directory / f'fidy-{target}.zip.sha256'
        expected = f'{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}\n'
        if checksum.read_text() != expected:
            raise ValueError(f'Invalid candidate checksum: {target}')
        assets.extend([archive, checksum])
    for name in ('install.sh', 'install.ps1'):
        path = directory / name
        if path.read_bytes() != (ROOT / 'scripts/cli-release' / name).read_bytes():
            raise ValueError('Installer does not match source revision')
        assets.append(path)
    for name in ('THIRD-PARTY-NOTICES.txt', 'fidy.js'):
        path = directory / name
        if not path.is_file() or not path.stat().st_size:
            raise ValueError(f'Missing distribution notice or application bundle: {name}')
        assets.append(path)
    manifest = directory / 'cli-release.json'
    manifest.write_text(json.dumps(release, indent=2) + '\n')
    latest = directory / 'latest.txt'
    latest.write_text(release['version'] + '\n')
    assets.extend([manifest, latest])
    tag = 'cli-v' + release['version']
    # Reserved tags are never reused. A failed draft remains inspectable and the next plan gets a new version.
    run('gh', 'release', 'create', tag, '--repo', REPOSITORY, '--target', release['gitRevision'],
        '--title', f'Fidy CLI {release["version"]}', '--notes', 'Standalone Fidy CLI for macOS arm64, Linux x64 desktops and Windows x64.',
        '--draft', '--latest=false')
    run('gh', 'release', 'upload', tag, '--repo', REPOSITORY, *(str(path) for path in assets))
    run('gh', 'release', 'edit', tag, '--repo', REPOSITORY, '--draft=false', '--latest=false')
    published = json.loads(run('gh', 'api', f'repos/{REPOSITORY}/releases/tags/{tag}'))
    if not published.get('immutable') or published.get('draft'):
        raise ValueError('Release is not published and immutable; default unchanged')
    # No token or ambient authentication: verify every final asset before changing the public default.
    with tempfile.TemporaryDirectory() as temporary:
        for asset in assets:
            destination = Path(temporary) / asset.name
            run('curl', '--proto', '=https', '--proto-redir', '=https', '--fail', '--silent', '--show-error',
                '--location', '--connect-timeout', '15', '--max-time', '600',
                f'https://github.com/{REPOSITORY}/releases/download/{tag}/{asset.name}', '-o', str(destination))
            if hashlib.sha256(destination.read_bytes()).digest() != hashlib.sha256(asset.read_bytes()).digest():
                raise ValueError('Anonymous asset verification failed; default unchanged')
    if api('git/ref/heads/trunk')['object']['sha'] != release['gitRevision']:
        raise ValueError('Source was superseded; default unchanged')
    run('gh', 'release', 'edit', tag, '--repo', REPOSITORY, '--latest=true')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    planning = commands.add_parser('plan')
    planning.add_argument('--sha', required=True)
    planning.add_argument('--output', required=True)
    publishing = commands.add_parser('publish')
    publishing.add_argument('--plan', required=True)
    publishing.add_argument('--directory', required=True)
    args = parser.parse_args()
    if os.environ.get('GITHUB_REPOSITORY', REPOSITORY) != REPOSITORY:
        raise ValueError('CLI publication is restricted to the configured repository')
    if args.command == 'plan':
        plan(args.sha, args.output)
    else:
        publish(args.plan, args.directory)
