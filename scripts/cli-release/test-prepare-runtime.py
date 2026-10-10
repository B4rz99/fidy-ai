#!/usr/bin/env python3
"""Exercise the recipient's public source-only preparation command."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class RecipientPreparationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.packet = self.root / "packet"
        self.packet.mkdir()
        self.output = self.root / "work"
        self.rows = []
        recipe = Path(__file__).parent / "source-materials/prepare-runtime.py"
        self.add("prepare-runtime.py", recipe.read_bytes())
        self.add("bun/scripts/build/deps/webkit.ts", b'      PORT: "JSCOnly",\n          "-ExecutionPolicy",\n          "Bypass",\n')
        self.add("webkit/Source/cmake/OptionsJSCOnly.cmake", b"if (WIN32)\n    set(ENABLE_API_TESTS OFF)\nelse ()\n    set(ENABLE_API_TESTS ON)\nendif ()\n")
        self.add("tinycc/tcc.h", b"original header\n")
        self.add("recipe/tinycc-tcc.h", b"patched header\n")
        self.add("bun/unchanged.sh", b"preserved script data\n", mode=0o755)
        self.add("webkit/empty.h", b"")
        self.manifest()
        (self.packet / "SOURCE-RELEASE.json").write_text(json.dumps({"schema_version": 1, "cli_version": "0.1.0",
            "bun_revision": "13a98b0dbd136bcc5c98a8adfb53c909aa3183cc", "source_commit": "a" * 40}))

    def tearDown(self):
        self.temporary.cleanup()

    def add(self, name, data, mode=0o644):
        path = self.packet / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        self.rows.append({"path": name, "mode": mode, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})

    def manifest(self):
        (self.packet / "SOURCE-FILES.json").write_text(json.dumps({"schema_version": 1, "cli_version": "0.1.0",
            "files": sorted(self.rows, key=lambda row: row["path"])}))

    def run_recipe(self, prepare=True):
        args = [sys.executable, str(self.packet / "prepare-runtime.py")]
        if prepare:
            args += ["--output", str(self.output)]
        return subprocess.run(args, capture_output=True, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})

    def test_valid_packet_prepares_only_documented_changes_and_preserves_original(self):
        self.assertEqual(self.run_recipe(False).returncode, 0)
        result = self.run_recipe()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual((self.packet / "tinycc/tcc.h").read_bytes(), b"original header\n")
        self.assertEqual((self.output / "tinycc/tcc.h").read_bytes(), b"patched header\n")
        recipe = (self.output / "bun/scripts/build/deps/webkit.ts").read_text()
        self.assertIn('USE_SYSTEM_UNIFDEF: "ON"', recipe)
        self.assertIn('ENABLE_TOOLS: "OFF"', recipe)
        self.assertNotIn("ExecutionPolicy", recipe)
        self.assertNotIn("Bypass", recipe)
        self.assertNotIn("set(ENABLE_API_TESTS ON)", (self.output / "webkit/Source/cmake/OptionsJSCOnly.cmake").read_text())
        self.assertEqual((self.output / "bun/unchanged.sh").read_bytes(), b"preserved script data\n")
        if os.name != "nt":
            self.assertEqual((self.output / "bun/unchanged.sh").stat().st_mode & 0o777, 0o755)

    def test_changed_source_fails_before_creating_working_copy(self):
        (self.packet / "tinycc/tcc.h").write_bytes(b"tampered header\n")
        self.assertNotEqual(self.run_recipe().returncode, 0)
        self.assertFalse(self.output.exists())

    def test_unlisted_file_is_rejected_without_partial_output(self):
        (self.packet / "unexpected").write_text("extra")
        self.assertNotEqual(self.run_recipe().returncode, 0)
        self.assertFalse(self.output.exists())

    def test_symlink_with_correct_bytes_is_rejected_before_output(self):
        original = self.packet / "tinycc/tcc.h"
        target = self.root / "same-header"
        target.write_bytes(original.read_bytes())
        original.unlink()
        original.symlink_to(target)
        self.assertNotEqual(self.run_recipe().returncode, 0)
        self.assertFalse(self.output.exists())

    def test_existing_recipient_work_is_preserved(self):
        self.output.mkdir()
        (self.output / "keep").write_text("existing work")
        self.assertNotEqual(self.run_recipe().returncode, 0)
        self.assertEqual((self.output / "keep").read_text(), "existing work")
        self.assertEqual([path.name for path in self.output.iterdir()], ["keep"])

    def test_unsafe_inventory_path_and_oversize_are_rejected_before_output(self):
        original = self.rows[0].copy()
        for change in ({"path": "../escape"}, {"path": "folder\\escape"}, {"bytes": 16 * 1024 * 1024 + 1}):
            with self.subTest(change=change):
                self.rows[0] = {**original, **change}
                self.manifest()
                self.assertNotEqual(self.run_recipe().returncode, 0)
                self.assertFalse(self.output.exists())

    def test_wrong_runtime_metadata_does_not_create_a_working_copy(self):
        path = self.packet / "SOURCE-RELEASE.json"
        metadata = json.loads(path.read_text())
        metadata["bun_revision"] = "b" * 40
        path.write_text(json.dumps(metadata))
        self.assertNotEqual(self.run_recipe().returncode, 0)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
