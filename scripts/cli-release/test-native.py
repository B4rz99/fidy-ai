"""Compile and install an ephemeral native test fixture; never create release artifacts."""
import hashlib
import platform
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
TARGETS = {
    ('Linux', 'x86_64'): ('linux-x64', 'fidy'),
    ('Darwin', 'arm64'): ('darwin-arm64', 'fidy'),
    ('Windows', 'AMD64'): ('windows-x64', 'fidy.exe'),
}


def run(*args):
    subprocess.run(args, cwd=ROOT, check=True)


def output(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def main():
    if output('bun', '--revision') != '1.4.3-canary.1+13a98b0db':
        raise RuntimeError('Use the reviewed Bun runtime.')
    target, executable = TARGETS[(platform.system(), platform.machine())]
    expected = output('bun', 'apps/cli/src/main.ts', '--version')
    if expected != 'fidy 0.1.0':
        raise RuntimeError('Review installer defaults when changing the CLI version.')
    # A private temporary directory is intentionally the only output destination.
    # These labeled fixtures must never be uploaded as distributable candidates.
    with tempfile.TemporaryDirectory(prefix='fidy-non-distributable-smoke-') as temporary:
        root = Path(temporary)
        binary = root / executable
        run('bun', 'build', 'apps/cli/src/main.ts', '--compile', '--minify', '--outfile', str(binary))
        if output(str(binary), '--version') != expected:
            raise RuntimeError('Compiled version differs from the CLI.')
        run(str(binary), '--help')
        archive = root / f'fidy-{target}.zip'
        with zipfile.ZipFile(archive, 'w') as bundle:
            for name in (executable, 'BUN-LICENSE.txt', 'THIRD-PARTY-NOTICES.txt'):
                entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                entry.create_system = 3
                entry.external_attr = (stat.S_IFREG | (0o755 if name == executable else 0o644)) << 16
                data = binary.read_bytes() if name == executable else (
                    f'SYNTHETIC {name}: installer test fixture only. NOT FOR DISTRIBUTION.\n'.encode()
                )
                bundle.writestr(entry, data)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        archive.with_suffix('.zip.sha256').write_bytes(f'{digest}  {archive.name}\n'.encode('ascii'))
        if target == 'windows-x64':
            run('pwsh', '-NoProfile', '-File', str(ROOT / 'scripts/cli-release/test-install.ps1'),
                '-ReleaseDirectory', str(root))
        else:
            run(sys.executable, str(ROOT / 'scripts/cli-release/test-install.py'), str(root))


if __name__ == '__main__':
    main()
