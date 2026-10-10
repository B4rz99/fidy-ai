#!/usr/bin/env python3
"""Exercise source assembly's public boundary with exact local Git fixtures."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("assemble_source", Path(__file__).with_name("assemble-source.py"))
assembler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assembler)


class SourceAssemblyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.cache = self.root / "cache"
        self.cache.mkdir()
        self.checkout = self.root / "checkout"
        self.checkout.mkdir()
        self.source = b"/* upstream source fixture */\n"
        self.payload = b'console.log("fidy 0.1.0");\n'
        (self.checkout / "owned.txt").write_bytes(b"Owned source fixture.\n")
        self.run_git("init", "--quiet", "--template=")
        self.run_git("add", "owned.txt")
        self.run_git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture")
        self.commit = self.run_git("rev-parse", "HEAD").decode().strip()
        self.rows = [self.row("application/fidy-app.js", self.payload,
                              {"kind": "generated", "generator": "bun-build", "label": "application-payload"}),
                     self.row("application/owned.txt", (self.checkout / "owned.txt").read_bytes(),
                              {"kind": "checkout", "path": "owned.txt", "git_blob_sha1": assembler.git_blob((self.checkout / "owned.txt").read_bytes())}),
                     self.row("runtime/code.c", self.source,
                              {"kind": "git", "repository": "vendor/runtime", "revision": "a" * 40,
                               "path": "code.c", "git_blob_sha1": assembler.git_blob(self.source)}),
                     self.row("runtime/empty.h", b"", {"kind": "git", "repository": "vendor/runtime", "revision": "a" * 40,
                                                         "path": "empty.h", "git_blob_sha1": assembler.git_blob(b"")}, mode=0o755)]

    def tearDown(self):
        self.temporary.cleanup()

    def run_git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.checkout), *args], stderr=subprocess.DEVNULL)

    def row(self, name, raw, origin, mode=0o644):
        return {"path": name, "mode": mode, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                "origin": origin}

    def specification(self):
        return json.dumps({"schema_version": 1, "cli_version": "0.1.0",
                           "bun_revision": assembler.publisher.RUNTIME_REVISION, "files": self.rows}).encode()

    def assemble(self, name, *, reader=None, payload=None):
        return assembler.assemble(self.checkout, self.specification(), "0.1.0", self.commit,
                                  self.root / name, self.cache,
                                  source_reader=reader or (lambda entry: self.source if entry["path"].endswith("code.c") else b""),
                                  payload_builder=lambda *_: self.payload if payload is None else payload)

    def compact_plan(self):
        return {"schema_version": 1, "cli_version": "0.1.0",
                "bun_revision": assembler.publisher.RUNTIME_REVISION,
                "manifest_sha256": "0" * 64,
                "application_inputs": [],
                "materials": [{"path": "application/owned.txt", "checkout": "owned.txt"}],
                "payload": {"bytes": len(self.payload), "sha256": hashlib.sha256(self.payload).hexdigest()},
                "sources": [{"repository": "vendor/runtime", "revision": self.commit,
                             "destination": "runtime", "prefixes": ["owned.txt"],
                             "aliases": {}, "omitted_symlinks": []}]}

    def committed_plan(self):
        owned = (self.checkout / "owned.txt").read_bytes()
        entries = [self.rows[0], self.rows[1], self.row("runtime/owned.txt", owned,
            {"kind": "git", "repository": "vendor/runtime", "revision": self.commit,
             "path": "owned.txt", "git_blob_sha1": assembler.git_blob(owned)})]
        index = (json.dumps({"schema_version": 1, "cli_version": "0.1.0", "files": [
            {key: row[key] for key in ("path", "mode", "bytes", "sha256")} for row in entries]},
            indent=2, sort_keys=True) + "\n").encode()
        entries.insert(0, self.row("SOURCE-FILES.json", index,
            {"kind": "generated", "generator": "source-index", "label": "recipient-index"}))
        expected = (json.dumps({"schema_version": 1, "cli_version": "0.1.0",
            "bun_revision": assembler.publisher.RUNTIME_REVISION, "files": entries},
            indent=2, sort_keys=True) + "\n").encode()
        plan = self.compact_plan()
        plan["manifest_sha256"] = hashlib.sha256(expected).hexdigest()
        return plan, expected, index

    def assemble_compact(self, plan, name="compact", reader=None):
        return assembler.assemble_plan(self.checkout, json.dumps(plan).encode(),
            "0.1.0", self.commit, self.root / name, self.cache,
            repositories={("vendor/runtime", plan["sources"][0]["revision"]): self.checkout},
            source_reader=reader, payload_builder=lambda *_: self.payload)

    def test_compact_plan_emits_reviewed_manifest_and_nonrecursive_recipient_index(self):
        plan, expected, index = self.committed_plan()
        self.assemble_compact(plan)
        self.assertEqual((self.root / "compact/source-spec.json").read_bytes(), expected)
        with tarfile.open(self.root / "compact/fidy-cli-v0.1.0-source.tar.gz") as archive:
            self.assertEqual(archive.getnames(), ["SOURCE-FILES.json", "SOURCE-RELEASE.json",
                "application/fidy-app.js", "application/owned.txt", "runtime/owned.txt"])
            self.assertEqual(archive.extractfile("SOURCE-FILES.json").read(), index)
            self.assertEqual(archive.extractfile("runtime/owned.txt").read(), b"Owned source fixture.\n")

    def test_compact_plan_rejects_unreviewed_manifest_before_emitting_assets(self):
        with self.assertRaisesRegex(assembler.publisher.ReleaseError, "manifest commitment"):
            assembler.assemble_plan(self.checkout, json.dumps(self.compact_plan()).encode(),
                                    "0.1.0", self.commit, self.root / "bad-plan", self.cache,
                                    repositories={("vendor/runtime", self.commit): self.checkout},
                                    payload_builder=lambda *_: self.payload)
        self.assertFalse((self.root / "bad-plan").exists())

    def test_compact_plan_rejects_wrong_commit_missing_path_extra_alias_and_mutated_bytes(self):
        for change, message in (("commit", "Git source acquisition"), ("path", "prefix is missing"),
                                ("extra", "manifest commitment"), ("bytes", "Git blob identity")):
            with self.subTest(change=change):
                plan, _, _ = self.committed_plan()
                reader = None
                if change == "commit":
                    plan["sources"][0]["revision"] = "0" * 40
                elif change == "path":
                    plan["sources"][0]["prefixes"] = ["missing.txt"]
                elif change == "extra":
                    plan["sources"][0]["aliases"] = {"extra.txt": "owned.txt"}
                else:
                    reader = lambda _: b"changed source bytes"
                with self.assertRaisesRegex((assembler.publisher.ReleaseError,
                                             assembler.plan_contract.contract.SourceError), message):
                    self.assemble_compact(plan, name=change, reader=reader)
                self.assertFalse((self.root / change).exists())

    def test_compact_plan_rejects_selected_symlink_unless_exactly_omitted(self):
        (self.checkout / "alias.txt").symlink_to("owned.txt")
        self.run_git("add", "alias.txt")
        self.run_git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "link")
        self.commit = self.run_git("rev-parse", "HEAD").decode().strip()
        plan, _, _ = self.committed_plan()
        plan["sources"][0]["prefixes"] = []
        with self.assertRaisesRegex(assembler.plan_contract.contract.SourceError, "regular pinned blob"):
            self.assemble_compact(plan, name="link")
        self.assertFalse((self.root / "link").exists())
        plan["sources"][0]["omitted_symlinks"] = ["alias.txt"]
        self.assemble_compact(plan, name="omitted")
        plan["sources"][0]["omitted_symlinks"].append("owned.txt")
        with self.assertRaisesRegex(assembler.plan_contract.contract.SourceError, "not a pinned symlink"):
            self.assemble_compact(plan, name="hidden-regular")
        self.assertFalse((self.root / "hidden-regular").exists())

    def test_malformed_plan_cannot_acquire_sources_or_create_release_output(self):
        for change in ("field", "traversal", "revision", "digest", "duplicate"):
            with self.subTest(change=change):
                plan = self.compact_plan()
                if change == "field":
                    plan["unexpected"] = True
                elif change == "traversal":
                    plan["sources"][0]["destination"] = "../outside"
                elif change == "revision":
                    plan["sources"][0]["revision"] = "main"
                elif change == "digest":
                    plan["manifest_sha256"] = "not-a-digest"
                else:
                    plan["application_inputs"] = ["apps/main.ts", "apps/main.ts"]
                with self.assertRaises(assembler.plan_contract.contract.SourceError):
                    assembler.assemble_plan(self.checkout, json.dumps(plan).encode(), "0.1.0", self.commit,
                        self.root / "never-output", self.root / "never-cache")
                self.assertFalse((self.root / "never-output").exists())
                self.assertFalse((self.root / "never-cache").exists())

    def test_repeated_assembly_has_identical_bytes_and_passes_independent_publisher_contract(self):
        self.assertEqual(self.assemble("first"), self.assemble("second"))
        name = "fidy-cli-v0.1.0-source.tar.gz"
        self.assertEqual((self.root / "first" / name).read_bytes(), (self.root / "second" / name).read_bytes())
        assets = assembler.contract.validate_artifact(self.root / "first", self.specification(), cli_version="0.1.0",
                                                      bun_revision=assembler.publisher.RUNTIME_REVISION, source_commit=self.commit)
        self.assertEqual(set(assets), {name, name + ".sha256"})

    def test_mutated_upstream_source_cannot_receive_a_published_checksum(self):
        with self.assertRaisesRegex(assembler.publisher.ReleaseError, "SHA-256"):
            self.assemble("bad", reader=lambda _: b"changed")
        self.assertFalse((self.root / "bad" / "fidy-cli-v0.1.0-source.tar.gz.sha256").exists())

    def test_changed_generated_application_is_rejected(self):
        with self.assertRaisesRegex(assembler.publisher.ReleaseError, "SHA-256"):
            self.assemble("bad", payload=b"unreviewed payload")

    def test_same_bytes_from_an_untracked_checkout_path_are_rejected(self):
        self.run_git("rm", "--cached", "owned.txt")
        self.run_git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "remove tracked input")
        with self.assertRaisesRegex(assembler.publisher.ReleaseError, "tracked Git"):
            self.assemble("bad")

    def test_checkout_symlink_is_rejected_even_when_target_bytes_match(self):
        owned = self.checkout / "owned.txt"
        raw = owned.read_bytes()
        owned.unlink()
        target = self.root / "external.txt"
        target.write_bytes(raw)
        owned.symlink_to(target)
        with self.assertRaisesRegex(assembler.publisher.ReleaseError, "symlink"):
            self.assemble("bad")

    def test_existing_output_is_never_overwritten(self):
        output = self.root / "existing"
        output.mkdir()
        (output / "keep").write_text("preserve")
        with self.assertRaisesRegex(assembler.publisher.ReleaseError, "new absolute"):
            self.assemble("existing")
        self.assertEqual((output / "keep").read_text(), "preserve")

    def test_public_command_refuses_a_different_source_sha_before_any_acquisition(self):
        scripts = self.checkout / "scripts/cli-release"
        scripts.mkdir(parents=True)
        for name in ("assemble-source.py", "publish.py", "publish-source.py", "verify-bundle.py", "source-plan.py"):
            shutil.copyfile(Path(assembler.__file__).with_name(name), scripts / name)
        result = subprocess.run(["python3", str(scripts / "assemble-source.py"), "--version", "0.1.0",
                                 "--expected-sha", "0" * 40, "--destination", str(self.root / "never"),
                                 "--cache", str(self.root / "never-cache")], capture_output=True,
                                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(result.returncode, 1)
        self.assertFalse((self.root / "never-cache").exists())
        self.assertFalse((self.root / "never").exists())

    def upstream_components(self):
        return [{"repository": "vendor/runtime", "revision": "a" * 40,
                 "destination": "runtime", "prefixes": ["code.c"],
                 "aliases": {}, "omitted_symlinks": []}]

    def fake_git(self, fail_fetch=False, object_size=None):
        binary = self.root / "fake-bin"
        binary.mkdir()
        log = self.root / "git-protocol.jsonl"
        entry = self.rows[2]
        program = "#!" + sys.executable + "\n" + '''import json, os, pathlib, sys
args = sys.argv[1:]
with pathlib.Path(LOG).open('a') as stream:
    stream.write(json.dumps({'args':args,'token_present':'GITHUB_TOKEN' in os.environ,
        'askpass':os.environ.get('GIT_ASKPASS'),'global':os.environ.get('GIT_CONFIG_GLOBAL'),
        'prompt':os.environ.get('GIT_TERMINAL_PROMPT'),'https_proxy':os.environ.get('HTTPS_PROXY')})+'\\n')
if 'fetch' in args and FAIL:
    sys.exit(1)
if 'fetch' in args and '--stdin' in args:
    pathlib.Path(args[args.index('-C') + 1], 'blobs-fetched').write_text('fixture')
if 'rev-parse' in args:
    print('a'*40)
elif 'ls-tree' in args:
    sys.stdout.buffer.write(('100644 blob '+BLOB+'\\tcode.c\\0').encode())
elif 'cat-file' in args and '--batch-check' in args:
    group = pathlib.Path(args[args.index('-C') + 1])
    print(BLOB+' blob '+str(SIZE) if (group / 'blobs-fetched').exists() else BLOB+' missing')
elif 'cat-file' in args:
    sys.stdout.buffer.write(DATA.encode())
'''.replace("LOG", repr(str(log))).replace("FAIL", repr(fail_fetch)).replace("BLOB", repr(entry["origin"]["git_blob_sha1"])).replace("DATA", repr(self.source.decode())).replace("SIZE", repr(len(self.source) if object_size is None else object_size))
        executable = binary / "git"
        executable.write_text(program)
        executable.chmod(0o755)
        return binary, log

    @unittest.skipIf(os.name == "nt", "Source acquisition job is Linux; Windows does not execute shebang fixtures.")
    def test_git_process_boundary_uses_pinned_objects_without_credentials_redirects_or_project_hooks(self):
        binary, log = self.fake_git()
        env = {**os.environ, "PATH": str(binary) + os.pathsep + os.environ["PATH"],
               "GITHUB_TOKEN": "synthetic-token", "GIT_ASKPASS": "unsafe-ambient-askpass",
               "HTTPS_PROXY": "http://policy-proxy.invalid:3128"}
        with patch.dict(os.environ, env, clear=True):
            entries, reader = assembler.acquire_sources(self.root / "git-cache", components=self.upstream_components())
        self.assertEqual(entries, [self.rows[2]])
        self.assertEqual(reader(entries[0]), self.source)
        calls = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertEqual(sum("fetch" in call["args"] for call in calls), 2)
        for call in calls:
            self.assertFalse(call["token_present"])
            self.assertEqual(call["askpass"], "")
            self.assertEqual(call["prompt"], "0")
            self.assertEqual(call["global"], os.devnull)
            self.assertEqual(call["https_proxy"], "http://policy-proxy.invalid:3128")
            self.assertIn("credential.helper=", call["args"])
            self.assertIn("http.followRedirects=false", call["args"])
            self.assertIn("protocol.ext.allow=never", call["args"])
            self.assertTrue(any(value.startswith("core.hooksPath=") for value in call["args"]))
        fetches = [call["args"] for call in calls if "fetch" in call["args"]]
        self.assertIn("https://github.com/vendor/runtime.git", fetches[0])
        self.assertEqual(fetches[0][-1], "a" * 40)

    @unittest.skipIf(os.name == "nt", "Source acquisition job is Linux; Windows does not execute shebang fixtures.")
    def test_repeated_same_run_acquisition_rechecks_cached_sources_without_fetching_again(self):
        binary, log = self.fake_git()
        with patch.dict(os.environ, {"PATH": str(binary) + os.pathsep + os.environ["PATH"]}):
            first_entries, first = assembler.acquire_sources(
                self.root / "same-run-cache", components=self.upstream_components())
            self.assertEqual(first_entries, [self.rows[2]])
            self.assertEqual(first(first_entries[0]), self.source)
            second_entries, second = assembler.acquire_sources(
                self.root / "same-run-cache", components=self.upstream_components())
            self.assertEqual(second_entries, first_entries)
            self.assertEqual(second(second_entries[0]), self.source)
        calls = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertEqual(sum("fetch" in call["args"] for call in calls), 2)

    @unittest.skipIf(os.name == "nt", "Source acquisition job is Linux; Windows does not execute shebang fixtures.")
    def test_acquisition_refuses_oversized_blob_before_reading_its_contents(self):
        binary, log = self.fake_git(object_size=assembler.contract.MAX_FILE + 1)
        with patch.dict(os.environ, {"PATH": str(binary) + os.pathsep + os.environ["PATH"]}):
            with self.assertRaisesRegex(assembler.publisher.ReleaseError, "object metadata"):
                assembler.acquire_sources(self.root / "large-cache", components=self.upstream_components())
        calls = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertFalse(any("cat-file" in call["args"] and "blob" in call["args"] for call in calls))
        self.assertEqual(list((self.root / "large-cache").glob("*.source")), [])

    @unittest.skipIf(os.name == "nt", "Source acquisition job is Linux; Windows does not execute shebang fixtures.")
    def test_git_failure_stops_without_retry_or_retaining_unverified_source(self):
        binary, log = self.fake_git(fail_fetch=True)
        with patch.dict(os.environ, {"PATH": str(binary) + os.pathsep + os.environ["PATH"]}):
            with self.assertRaisesRegex(assembler.publisher.ReleaseError, "no retry"):
                assembler.acquire_sources(self.root / "git-cache", components=self.upstream_components())
        calls = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertEqual(sum("fetch" in call["args"] for call in calls), 1)
        self.assertEqual(list((self.root / "git-cache").glob("*.source")), [])


if __name__ == "__main__":
    unittest.main()
