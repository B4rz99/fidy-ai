"""Download an immutable CLI release and verify its platform executable in isolated CI."""
import argparse
import hashlib
import json
import re
from pathlib import Path
import subprocess
import tempfile

from importlib.util import module_from_spec, spec_from_file_location

ROOT = Path(__file__).resolve().parent
spec = spec_from_file_location('packaged', ROOT / 'verify-packaged.py')
packaged = module_from_spec(spec)
spec.loader.exec_module(packaged)
REPOSITORY = 'B4rz99/fidy-ai'


def github(*arguments):
    result = subprocess.run(['gh', *arguments], capture_output=True, text=True, timeout=60)
    packaged.require(result.returncode == 0, 'Release lookup/download failed')
    return result.stdout


def verify(tag=None, *, credentials=False):
    path = f'releases/tags/{tag}' if tag else 'releases/latest'
    release = json.loads(github('api', f'repos/{REPOSITORY}/{path}'))
    tag = release['tag_name']
    packaged.require(re.fullmatch(r'cli-v[0-9]+\.[0-9]+\.[0-9]+', tag) is not None,
                     'Unexpected release tag')
    packaged.require(release.get('immutable') is True and not release['draft']
                     and not release['prerelease'], 'Release is not immutable and stable')
    target = packaged.TARGETS.get((packaged.platform.system(), packaged.platform.machine()))
    packaged.require(target is not None, 'Unsupported release platform')
    names = ['cli-release.json', f'fidy-{target}.zip', f'fidy-{target}.zip.sha256']
    with tempfile.TemporaryDirectory(prefix='fidy-release-') as temporary:
        directory = Path(temporary)
        for name in names:
            github('release', 'download', tag, '--repo', REPOSITORY, '--pattern', name,
                   '--dir', temporary)
            asset = next((value for value in release['assets'] if value['name'] == name), None)
            packaged.require(asset is not None, 'Missing immutable release asset')
            expected = 'sha256:' + hashlib.sha256((directory / name).read_bytes()).hexdigest()
            packaged.require(asset.get('digest') == expected, 'GitHub asset digest mismatch')
        manifest_path = directory / 'cli-release.json'
        packaged.require(manifest_path.stat().st_size <= 16384, 'Oversized release manifest')
        manifest = json.loads(manifest_path.read_text())
        revision = manifest.get('gitRevision', '')
        packaged.require(re.fullmatch(r'[a-f0-9]{40}', revision) is not None,
                         'Invalid source revision')
        packaged.require(manifest.get('version') == tag[5:], 'Manifest version mismatch')
        reference = json.loads(github('api', f'repos/{REPOSITORY}/git/ref/tags/{tag}'))['object']
        if reference['type'] == 'tag':
            reference = json.loads(github('api', f'repos/{REPOSITORY}/git/tags/{reference["sha"]}'))['object']
        packaged.require(reference['type'] == 'commit' and reference['sha'] == revision,
                         'Release tag does not match recorded source')
        packaged.verify(directory, version=manifest['version'], credential_check=credentials)
        print(f'Immutable published release verified: {tag}, source {revision}.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--tag')
    parser.add_argument('--credentials', action='store_true')
    arguments = parser.parse_args()
    packaged.require(arguments.tag is None or re.fullmatch(r'cli-v[0-9]+\.[0-9]+\.[0-9]+', arguments.tag),
                     'Invalid release selection')
    verify(arguments.tag, credentials=arguments.credentials)
