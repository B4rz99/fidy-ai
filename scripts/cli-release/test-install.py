"""Exercise the installer against local synthetic releases, never the network."""
import hashlib
import os
from pathlib import Path
import shutil
import stat
import sys
import subprocess
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
RELEASE = Path(sys.argv.pop(1)).resolve() if len(sys.argv) == 2 else None


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
        self.command('bun', '#!/bin/sh\nexit 97\n')
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
            archive.writestr('BUN-LICENSE.txt', 'Runtime license fixture\n')
            archive.writestr('THIRD-PARTY-NOTICES.txt', 'Package notice fixture\n')
        self.checksum()

    def checksum(self):
        digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.manifest = self.release / (self.archive.name + '.sha256')
        self.manifest.write_text(f'{digest}  {self.archive.name}\n')

    def install(self, version='0.1.0', extra=()):
        arguments = [] if version is None else [version]
        return subprocess.run(['bash', str(ROOT / 'scripts/cli-release/install.sh'), *arguments, *extra],
                              env=self.env, capture_output=True, text=True, timeout=10)

    def assert_unchanged(self, result):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual((self.destination / 'fidy').read_text(), 'previous install')

    def test_verified_release_installs_without_bun(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.destination / 'fidy-BUN-LICENSE.txt').read_text(),
                         'Runtime license fixture\n')
        self.assertEqual((self.destination / 'fidy-THIRD-PARTY-NOTICES.txt').read_text(),
                         'Package notice fixture\n')
        self.assertEqual(subprocess.check_output([str(self.destination / 'fidy'), '--version'],
                                                text=True).strip(), 'fidy 0.1.0')

    @unittest.skipIf(RELEASE is None, 'Pass the native release directory for executable smoke coverage.')
    def test_native_release_installs_and_runs_without_bun(self):
        candidates = list(RELEASE.glob('fidy-*.zip'))
        self.assertEqual(len(candidates), 1, 'Expected one native candidate archive')
        candidate = candidates[0]
        self.archive = self.release / candidate.name
        shutil.copyfile(candidate, self.archive)
        shutil.copyfile(candidate.with_suffix('.zip.sha256'), self.release / (candidate.name + '.sha256'))
        if candidate.name == 'fidy-darwin-arm64.zip':
            self.command('uname', '#!/bin/sh\n[ "$1" = "-s" ] && echo Darwin || echo arm64\n')
        else:
            self.assertEqual(candidate.name, 'fidy-linux-x64.zip')
        result = self.install(None)
        self.assertEqual(result.returncode, 0, result.stderr)
        binary = str(self.destination / 'fidy')
        self.assertEqual(subprocess.check_output([binary, '--version'], text=True).strip(), 'fidy 0.1.0')
        self.assertIn('fidy login', subprocess.check_output([binary, '--help'], text=True))
        for name in ['BUN-LICENSE.txt', 'THIRD-PARTY-NOTICES.txt']:
            with zipfile.ZipFile(self.archive) as archive:
                self.assertEqual((self.destination / ('fidy-' + name)).read_bytes(), archive.read(name))

    def test_default_version_installs_without_arguments(self):
        result = self.install(None)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(str(self.destination / 'fidy') + ' login', result.stdout)

    def test_explicit_version_override_must_match_the_binary(self):
        self.fixture('fidy', '0.2.0')
        result = self.install('0.2.0')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(subprocess.check_output([str(self.destination / 'fidy'), '--version'],
                                                text=True).strip(), 'fidy 0.2.0')

    def test_extra_arguments_are_rejected_before_download(self):
        self.assert_unchanged(self.install('0.1.0', ('unexpected',)))

    def test_corrupt_download_preserves_previous_install(self):
        self.archive.write_bytes(b'corrupted')
        self.assert_unchanged(self.install())

    def test_unexpected_archive_entry_is_rejected(self):
        self.fixture('../fidy')
        self.assert_unchanged(self.install())

    def test_extra_and_duplicate_entries_are_rejected(self):
        for name in ['extra.txt', 'fidy', 'BUN-LICENSE.txt']:
            with self.subTest(name=name):
                self.fixture('fidy')
                with zipfile.ZipFile(self.archive, 'a') as archive:
                    archive.writestr(name, 'unexpected')
                self.checksum()
                self.assert_unchanged(self.install())

    def test_symlink_entries_are_rejected_without_following_them(self):
        escaped = self.root / 'escaped'
        escaped.write_text('unchanged')
        for name in ['fidy', 'BUN-LICENSE.txt', 'THIRD-PARTY-NOTICES.txt']:
            with self.subTest(name=name):
                with zipfile.ZipFile(self.archive, 'w') as archive:
                    for entry_name in ['fidy', 'BUN-LICENSE.txt', 'THIRD-PARTY-NOTICES.txt']:
                        entry = zipfile.ZipInfo(entry_name)
                        entry.create_system = 3
                        entry.external_attr = (stat.S_IFLNK | 0o777) << 16 if entry_name == name else (stat.S_IFREG | 0o755) << 16
                        content = str(escaped) if entry_name == name else '#!/bin/sh\necho "fidy 0.1.0"\n'
                        archive.writestr(entry, content)
                self.checksum()
                self.assert_unchanged(self.install())
                self.assertEqual(escaped.read_text(), 'unchanged')

    def test_symlink_install_destination_is_not_followed(self):
        escaped = self.root / 'escaped'
        escaped.write_text('unchanged')
        target = self.destination / 'fidy-BUN-LICENSE.txt'
        target.symlink_to(escaped)
        self.assert_unchanged(self.install())
        self.assertEqual(escaped.read_text(), 'unchanged')

    def test_wrong_checksum_filename_is_rejected(self):
        self.manifest.write_text(hashlib.sha256(self.archive.read_bytes()).hexdigest() + '  other.zip\n')
        self.assert_unchanged(self.install())

    def test_mismatched_binary_version_is_rejected(self):
        self.fixture('fidy', '0.0.0')
        self.assert_unchanged(self.install())

    def test_invalid_version_is_rejected_before_download(self):
        for version in ['', '../latest', '0.1.0-beta.1', '0.1.0\n']:
            with self.subTest(version=version):
                self.assert_unchanged(self.install(version))

    def test_missing_release_preserves_previous_install(self):
        shutil.rmtree(self.release)
        self.assert_unchanged(self.install())


if __name__ == '__main__':
    unittest.main()
