"""Exercise the installer against local synthetic releases, never the network."""
import hashlib
import os
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
        self.destination = self.root / 'installed'
        self.destination.mkdir()
        (self.destination / 'fidy').write_text('previous install')
        self.archive = self.release / 'fidy-linux-x64.zip'
        self.fixture('fidy')
        self.command('uname', '#!/bin/sh\n[ "$1" = "-s" ] && echo Linux || echo x86_64\n')
        self.command('curl', '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n case "$1" in https://*) source="${1##*/}";; -o) shift; destination="$1";; esac\n shift\ndone\ncp "$FIXTURE_RELEASE/$source" "$destination"\n')
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ['PATH'],
                        FIXTURE_RELEASE=str(self.release), FIDY_INSTALL_DIR=str(self.destination))

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
        return subprocess.run(['bash', str(ROOT / 'scripts/cli-release/install.sh'), version],
                              env=self.env, capture_output=True, text=True, timeout=10)

    def assert_unchanged(self, result):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual((self.destination / 'fidy').read_text(), 'previous install')

    def test_verified_release_installs_without_bun(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(subprocess.check_output([str(self.destination / 'fidy'), '--version'],
                                                text=True).strip(), 'fidy 0.1.0')

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
