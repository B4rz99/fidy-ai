"""Exercise the installer against local synthetic releases, never the network."""
import hashlib
import os
import platform
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.release = self.root / 'release'
        self.release.mkdir()
        (self.release / 'latest.txt').write_text('0.1.0\n')
        self.home = self.root / 'home'
        self.home.mkdir()
        self.destination = self.root / 'installed'
        self.destination.mkdir()
        (self.destination / 'fidy').write_text('previous install')
        self.archive = self.release / 'fidy-linux-x64.zip'
        self.fixture('fidy')
        self.command('uname', '#!/bin/sh\n[ "$1" = "-s" ] && echo Linux || echo x86_64\n')
        self.command('curl', '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n case "$1" in https://*) source="${1##*/}";; -o) shift; destination="$1";; esac\n shift\ndone\nif [ -n "$destination" ]; then cp "$FIXTURE_RELEASE/$source" "$destination"; else cat "$FIXTURE_RELEASE/$source"; fi\n')
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ['PATH'],
                        FIXTURE_RELEASE=str(self.release), FIDY_INSTALL_DIR=str(self.destination),
                        HOME=str(self.home), SHELL='/bin/zsh')

    def command(self, name, content):
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o755)

    def fixture(self, name, version='0.1.0'):
        with zipfile.ZipFile(self.archive, 'w') as archive:
            archive.writestr(name, f'#!/bin/sh\necho "fidy {version}"\n')
        digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.manifest = self.release / (self.archive.name + '.sha256')
        self.manifest.write_text(f'{digest}  {self.archive.name}\n')

    def install(self, version='0.1.0'):
        return subprocess.run(['bash', str(ROOT / 'scripts/cli-release/install.sh')] + ([] if version is None else [version]),
                              env=self.env, capture_output=True, text=True, timeout=10)

    def assert_unchanged(self, result):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual((self.destination / 'fidy').read_text(), 'previous install')
        self.assertEqual(list(self.home.iterdir()), [])

    def test_verified_release_installs_without_bun(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(subprocess.check_output([str(self.destination / 'fidy'), '--version'],
                                                text=True).strip(), 'fidy 0.1.0')

    def test_native_release_installs_without_a_runtime_dependency(self):
        targets = {('Darwin', 'arm64'): 'darwin-arm64', ('Linux', 'x86_64'): 'linux-x64'}
        target = targets.get((platform.system(), platform.machine()))
        archive = ROOT / 'dist/cli-release' / f'fidy-{target}.zip'
        if not archive.is_file():
            self.skipTest('Build the native release first')
        self.command('uname', f'#!/bin/sh\n[ "$1" = "-s" ] && echo {platform.system()} || echo {platform.machine()}\n')
        for name in ('bun', 'node'):
            self.command(name, '#!/bin/sh\necho Unexpected runtime dependency >&2\nexit 1\n')
        for source in (archive, archive.with_name(archive.name + '.sha256')):
            shutil.copy(source, self.release / source.name)
        version = os.environ.get('FIDY_CLI_VERSION', '0.1.0')
        result = self.install(version)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run([str(self.destination / 'fidy'), '--help'], env=self.env,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('fidy login', result.stdout)

    def test_default_installs_latest_validated_release(self):
        result = self.install(None)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Installed Fidy 0.1.0', result.stdout)

    def test_shell_setup_is_automatic_and_idempotent(self):
        for shell, config in [('zsh', '.zshrc'), ('bash', '.bashrc'), ('fish', '.config/fish/conf.d/fidy.fish')]:
            with self.subTest(shell=shell):
                self.env['SHELL'] = '/bin/' + shell
                self.assertEqual(self.install().returncode, 0)
                first = (self.home / config).read_text()
                self.assertEqual(self.install().returncode, 0)
                self.assertEqual((self.home / config).read_text(), first)
                self.assertIn(str(self.destination), first)
                if shell == 'bash':
                    result = subprocess.run(['bash', '-c', '. "$HOME/.bashrc"; command -v fidy'],
                                            env=self.env, capture_output=True, text=True)
                    self.assertEqual(result.stdout.strip(), str(self.destination / 'fidy'))

    def test_malformed_latest_preserves_installation_and_shell_configuration(self):
        for value in ['<html>application</html>', '../latest', '1' * 65, '0.1.0\n0.2.0']:
            with self.subTest(value=value):
                (self.release / 'latest.txt').write_text(value)
                self.assert_unchanged(self.install(None))

    def test_unsupported_shell_preserves_installation(self):
        self.env['SHELL'] = '/bin/tcsh'
        self.assert_unchanged(self.install())

    def test_corrupt_download_preserves_previous_install(self):
        self.archive.write_bytes(b'corrupted')
        self.assert_unchanged(self.install())

    def test_unexpected_archive_entry_is_rejected(self):
        self.fixture('../fidy')
        self.assert_unchanged(self.install())

    def test_mismatched_binary_version_is_rejected(self):
        self.fixture('fidy', '0.0.0')
        self.assert_unchanged(self.install())

    def test_invalid_version_is_rejected_before_download(self):
        self.assert_unchanged(self.install('../latest'))

    def test_missing_release_preserves_previous_install(self):
        shutil.rmtree(self.release)
        self.assert_unchanged(self.install())


if __name__ == '__main__':
    unittest.main()
