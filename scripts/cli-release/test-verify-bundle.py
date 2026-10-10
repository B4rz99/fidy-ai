#!/usr/bin/env python3
"""Check the native application's public source-closure policy."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
import shutil
import subprocess
import tempfile

spec = importlib.util.spec_from_file_location("bundle_contract", Path(__file__).with_name("verify-bundle.py"))
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


class BundleClosureTests(unittest.TestCase):
    def setUp(self):
        self.application_inputs = {"apps/cli/src/main.ts"}
        self.metadata = {"inputs": {"apps/cli/src/main.ts": {}, "node_modules/effect/dist/Effect.js": {}},
                         "outputs": {"fidy": {"entryPoint": "apps/cli/src/main.ts", "imports": []}}}

    def test_reviewed_application_and_dependency_paths_are_accepted(self):
        bundle.verify(self.metadata, self.application_inputs)

    def test_public_command_reads_compact_plan_without_generated_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ("verify-bundle.py", "source-plan.py", "publish-source.py"):
                shutil.copyfile(Path(bundle.__file__).with_name(name), root / name)
            plan = {"schema_version": 1, "cli_version": "0.1.0",
                    "bun_revision": "13a98b0dbd136bcc5c98a8adfb53c909aa3183cc",
                    "manifest_sha256": "a" * 64, "application_inputs": ["apps/cli/src/main.ts"],
                    "materials": [], "payload": {"bytes": 1, "sha256": "b" * 64},
                    "sources": [{"repository": "vendor/runtime", "revision": "c" * 40,
                        "destination": "runtime", "prefixes": [], "aliases": {}, "omitted_symlinks": []}]}
            (root / "source-plan.json").write_text(json.dumps(plan))
            (root / "metafile.json").write_text(json.dumps(self.metadata))
            result = subprocess.run(["python3", str(root / "verify-bundle.py"), str(root / "metafile.json")],
                                    capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_new_or_missing_first_party_input_cannot_escape_source_delivery(self):
        for change in ("new", "missing"):
            with self.subTest(change=change):
                metadata = copy.deepcopy(self.metadata)
                if change == "new":
                    metadata["inputs"]["apps/server/extra.ts"] = {}
                else:
                    del metadata["inputs"]["apps/cli/src/main.ts"]
                with self.assertRaisesRegex(bundle.contract.SourceError, "application inputs"):
                    bundle.verify(metadata, self.application_inputs)

    def test_a_new_package_cannot_use_another_packages_notice(self):
        self.metadata["inputs"]["node_modules/effect-other/index.js"] = {}
        with self.assertRaisesRegex(bundle.contract.SourceError, "unreviewed dependency"):
            bundle.verify(self.metadata, self.application_inputs)

    def test_external_imports_and_changed_entry_points_are_rejected(self):
        for change in ({"imports": [{"path": "external-package"}]}, {"entryPoint": "apps/cli/other.ts"}):
            with self.subTest(change=change):
                metadata = copy.deepcopy(self.metadata)
                metadata["outputs"]["fidy"].update(change)
                with self.assertRaisesRegex(bundle.contract.SourceError, "entry point or external"):
                    bundle.verify(metadata, self.application_inputs)


if __name__ == "__main__":
    unittest.main()
