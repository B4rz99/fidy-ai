"""Exercise formula generation from local candidate bytes, without publishing or downloading."""
import hashlib
from pathlib import Path
import stat
import struct
import subprocess
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]


class HomebrewTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.archive = self.root / 'fidy-darwin-arm64.zip'
        self.fixture()

    def fixture(self, names=('fidy', 'BUN-LICENSE.txt', 'THIRD-PARTY-NOTICES.txt'), binary=None):
        if binary is None:
            binary = (struct.pack('<8I', 0xfeedfacf, 0x0100000c, 0, 2, 1, 24, 0, 0)
                      + struct.pack('<6I', 0x32, 24, 1, 0x000d0000, 0x000d0000, 0))
        with zipfile.ZipFile(self.archive, 'w') as archive:
            for name in names:
                entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                entry.create_system = 3
                entry.external_attr = (stat.S_IFREG | 0o755) << 16
                archive.writestr(entry, binary if name == 'fidy' else b'candidate notice fixture\n')
        self.checksum()

    def checksum(self):
        self.digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.manifest = self.root / (self.archive.name + '.sha256')
        self.manifest.write_text(f'{self.digest}  {self.archive.name}\n')

    def generate(self, version='0.1.0'):
        return subprocess.run(['python3', str(ROOT / 'scripts/cli-release/homebrew.py'),
                               version, str(self.root)], capture_output=True, text=True, timeout=10)

    def test_verified_candidate_emits_a_pinned_arm64_formula_with_silent_notices(self):
        result = self.generate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('class Fidy < Formula', result.stdout)
        self.assertIn('version "0.1.0"', result.stdout)
        self.assertIn('/releases/download/cli-v0.1.0/fidy-darwin-arm64.zip"', result.stdout)
        self.assertIn(f'sha256 "{self.digest}"', result.stdout)
        self.assertIn('depends_on macos: :ventura', result.stdout)
        self.assertIn('depends_on arch: :arm64', result.stdout)
        self.assertIn('bin.install "fidy"', result.stdout)
        self.assertIn('pkgshare.install "BUN-LICENSE.txt", "THIRD-PARTY-NOTICES.txt"', result.stdout)
        self.assertNotIn('post_install', result.stdout)
        self.assertNotIn('caveats', result.stdout)

    def assert_rejected(self, result):
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')

    def test_invalid_version_never_enters_ruby_or_a_download_url(self):
        for version in ['latest', '../0.1.0', '0.1.0-beta.1', '0.1.0"; system("id")', '0.1.0\n']:
            with self.subTest(version=version):
                self.assert_rejected(self.generate(version))

    def test_manifest_requires_one_exact_archive_and_lowercase_digest(self):
        for manifest in [f'{self.digest}  another.zip\n', f'{self.digest.upper()}  {self.archive.name}\n',
                         f'{self.digest}  {self.archive.name}\nextra line\n', 'no checksum']:
            with self.subTest(manifest=manifest):
                self.manifest.write_text(manifest)
                self.assert_rejected(self.generate())

    def test_wrong_platform_or_unreviewed_macos_minimum_is_rejected(self):
        for binary in [b'not a Mach-O executable',
                       struct.pack('<8I', 0xfeedfacf, 0x01000007, 0, 2, 1, 24, 0, 0)
                       + struct.pack('<6I', 0x32, 24, 1, 0x000d0000, 0x000d0000, 0),
                       struct.pack('<8I', 0xfeedfacf, 0x0100000c, 0, 2, 1, 24, 0, 0)
                       + struct.pack('<6I', 0x32, 24, 1, 0x000e0000, 0x000e0000, 0)]:
            with self.subTest(binary=binary):
                self.fixture(binary=binary)
                self.assert_rejected(self.generate())

    def test_modified_archive_is_rejected_before_formula_output(self):
        self.archive.write_bytes(b'corrupt download')
        self.assert_rejected(self.generate())

    def test_missing_candidate_or_checksum_is_rejected(self):
        self.manifest.unlink()
        self.assert_rejected(self.generate())
        self.checksum()
        self.archive.unlink()
        self.assert_rejected(self.generate())

    def test_missing_extra_duplicate_or_traversing_entries_are_rejected(self):
        for names in [('fidy',), ('../fidy', 'BUN-LICENSE.txt', 'THIRD-PARTY-NOTICES.txt'),
                      ('fidy', 'BUN-LICENSE.txt', 'THIRD-PARTY-NOTICES.txt', 'extra'),
                      ('fidy', 'BUN-LICENSE.txt', 'BUN-LICENSE.txt')]:
            with self.subTest(names=names):
                self.fixture(names)
                self.assert_rejected(self.generate())

    def test_symlinks_and_empty_entries_are_rejected(self):
        for invalid_name in ['fidy', 'BUN-LICENSE.txt', 'THIRD-PARTY-NOTICES.txt']:
            for kind in ['symlink', 'empty']:
                with self.subTest(name=invalid_name, kind=kind):
                    self.fixture()
                    with zipfile.ZipFile(self.archive) as archive:
                        entries = [(entry, archive.read(entry)) for entry in archive.infolist()]
                    with zipfile.ZipFile(self.archive, 'w') as archive:
                        for entry, content in entries:
                            if entry.filename == invalid_name:
                                if kind == 'symlink':
                                    entry.external_attr = (stat.S_IFLNK | 0o755) << 16
                                else:
                                    content = b''
                            archive.writestr(entry, content)
                    self.checksum()
                    result = self.generate()
                    self.assert_rejected(result)
                    self.assertIn('Invalid archive entry.', result.stderr)


if __name__ == '__main__':
    unittest.main()
