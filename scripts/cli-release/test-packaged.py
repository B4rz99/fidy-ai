"""Negative archive and credential-isolation checks for the packaged verification harness."""
import contextlib
import hashlib
from importlib.util import module_from_spec, spec_from_file_location
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = spec_from_file_location('packaged', Path(__file__).with_name('verify-packaged.py'))
packaged = module_from_spec(spec)
spec.loader.exec_module(packaged)


class PackagedVerification(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.archive = self.directory / 'fidy-linux-x64.zip'
        self.fixture()

    def fixture(self, name=None):
        name = name or ('fidy.exe' if packaged.os.name == 'nt' else 'fidy')
        with zipfile.ZipFile(self.archive, 'w') as bundle:
            bundle.writestr(name, '#!/bin/sh\necho "fidy 0.1.0"\n')
        self.manifest = self.archive.with_name(self.archive.name + '.sha256')
        self.manifest.write_text(hashlib.sha256(self.archive.read_bytes()).hexdigest()
                                 + '  ' + self.archive.name + '\n')

    def verify(self, **options):
        with patch.object(packaged.platform, 'system', return_value='Linux'), \
                patch.object(packaged.platform, 'machine', return_value='x86_64'), \
                contextlib.redirect_stdout(io.StringIO()):
            packaged.verify(self.directory, version='0.1.0', **options)

    def test_corrupt_archive_is_refused_before_execution(self):
        self.archive.write_bytes(b'changed after checksum')
        with patch.object(packaged, 'run', side_effect=AssertionError('must not execute')), \
                self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            self.verify()

    def test_unexpected_entry_is_refused_before_extraction(self):
        self.fixture('../fidy')
        with patch.object(packaged, 'run', side_effect=AssertionError('must not execute')), \
                self.assertRaisesRegex(ValueError, 'Unexpected archive entries'):
            self.verify()

    def test_mismatched_executable_version_is_refused(self):
        with patch.object(packaged, 'run') as run:
            run.return_value.returncode = 0
            run.return_value.stdout = 'fidy 9.9.9\n'
            with self.assertRaisesRegex(ValueError, 'version mismatch'):
                self.verify()

    def test_verified_archive_executes_extracted_binary(self):
        if packaged.os.name == 'nt':
            self.skipTest('POSIX fixture executable')
        self.verify()

    def test_local_credential_checks_refuse_before_native_access(self):
        with patch.dict(packaged.os.environ, {}, clear=True), \
                patch.object(packaged, 'native', side_effect=AssertionError('must not touch vault')), \
                self.assertRaisesRegex(ValueError, 'isolated GitHub-hosted runner'):
            packaged.credentials(self.directory / 'fidy', self.directory)


if __name__ == '__main__':
    unittest.main()
