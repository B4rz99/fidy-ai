#!/usr/bin/env python3
"""Publisher public-command tests with a synthetic GitHub HTTP boundary."""
import importlib.util
import io
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import subprocess
from pathlib import Path
import tempfile
import stat
import struct
import threading
import zipfile
from urllib.parse import urlparse, parse_qs
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("cli_publisher", Path(__file__).with_name("publish.py"))
publisher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publisher)


class Fixture:
    def __init__(self, root):
        self.root = root
        self.artifacts = root / "candidates"
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        (root / ".gitignore").write_text("candidates/\n")
        inventory = {"schema_version": 1, "status": "reviewed_complete", "version": "0.1.0",
                     "runtime_revision": "13a98b0dbd136bcc5c98a8adfb53c909aa3183cc",
                     "components": [{"id": name, "kind": kind, "version": "0.1.0",
                                     "license": "Synthetic test license", "source": "https://example.invalid/source",
                                     "notice": "Synthetic fixture only", "status": "reviewed"}
                                    for name, kind in (("fidy", "first_party"), ("bun", "runtime"),
                                                       ("runtime-lib", "runtime_dependency"), ("app-lib", "bundled_dependency"))]}
        inventory_bytes = json.dumps(inventory).encode()
        source = {"schema_version": 1, "status": "complete",
                  "inventory_sha256": hashlib.sha256(inventory_bytes).hexdigest(),
                  "components": [{"id": component["id"], "requirement": "none", "status": "not_required",
                                  "basis": "Synthetic test review, not actual license evidence.", "evidence": []}
                                 for component in inventory["components"]]}
        self.materials = {}
        for name, content in {
            "inventory": inventory_bytes,
            "source_obligations": json.dumps(source).encode(),
            "BUN-LICENSE.txt": b"Synthetic Bun license fixture.\n",
            "THIRD-PARTY-NOTICES.txt": b"Synthetic dependency notices fixture.\n",
        }.items():
            relative = "evidence/" + name
            path = root / relative
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(content)
            self.materials[name] = {"path": relative, "sha256": hashlib.sha256(content).hexdigest()}
        for name in ("install.sh", "install.ps1"):
            path = root / "scripts/cli-release" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"Do not execute synthetic fixture.\n")
        self.manifest = {
            "schema_version": 1, "version": "0.1.0", "status": "approved",
            "runtime_revision": "13a98b0dbd136bcc5c98a8adfb53c909aa3183cc",
            "source_tree_sha256": None,
            "review_reference": "https://github.com/B4rz99/fidy-ai/pull/123",
            "attestations": {
                "first_party_distribution_authorized": True,
                "bundled_inventory_complete": True,
                "required_notices_complete": True,
                "source_obligations_satisfied": True,
            },
            "materials": self.materials,
        }
        self.write_manifest()
        self.commit()
        output = io.StringIO()
        assert publisher.main(["prepare"], source_root=root, output=output) == 0
        self.manifest["source_tree_sha256"] = json.loads(output.getvalue())["source_tree_sha256"]
        self.write_manifest()
        self.commit()
        self.sha = self.git("rev-parse", "HEAD").decode().strip()
        self.env = {"GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF": "refs/heads/trunk",
                    "GITHUB_SHA": self.sha, "RELEASE_WORKFLOW_SHA": self.sha,
                    "GITHUB_REPOSITORY": "B4rz99/fidy-ai", "GITHUB_RUN_ID": "12345",
                    "GITHUB_RUN_ATTEMPT": "1", "GH_TOKEN": "synthetic-test-token"}
        self.make_archives()

    def rebind_review(self):
        for item in self.materials.values():
            item["sha256"] = hashlib.sha256((self.root / item["path"]).read_bytes()).hexdigest()
        self.write_manifest()
        self.commit()
        output = io.StringIO()
        assert publisher.main(["prepare"], source_root=self.root, output=output) == 0
        self.manifest["source_tree_sha256"] = json.loads(output.getvalue())["source_tree_sha256"]
        self.write_manifest()
        self.commit()
        self.sha = self.git("rev-parse", "HEAD").decode().strip()
        self.env["GITHUB_SHA"] = self.env["RELEASE_WORKFLOW_SHA"] = self.sha

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.root), *args], stderr=subprocess.DEVNULL)

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")

    def write_manifest(self):
        (self.root / "scripts/cli-release/publish-readiness.json").write_text(json.dumps(self.manifest))

    def make_archives(self):
        linux = b"\x7fELF\x02\x01\x01" + bytes(11) + b"\x3e\x00" + bytes(80)
        mac = struct.pack("<III", 0xFEEDFACF, 0x0100000C, 0) + bytes(88)
        windows = b"MZ" + bytes(58) + struct.pack("<I", 64) + b"PE\0\0\x64\x86" + bytes(80)
        for label, target, executable, binary in (
            ("Linux-X64", "linux-x64", "fidy", linux),
            ("macOS-ARM64", "darwin-arm64", "fidy", mac),
            ("Windows-X64", "windows-x64", "fidy.exe", windows),
        ):
            directory = self.artifacts / ("cli-candidate-" + label)
            directory.mkdir(parents=True)
            archive = directory / ("fidy-" + target + ".zip")
            with zipfile.ZipFile(archive, "w") as package:
                content = {executable: binary}
                content.update({name: (self.root / item["path"]).read_bytes() for name, item in self.materials.items() if name.endswith(".txt")})
                for name, data in content.items():
                    entry = zipfile.ZipInfo(name)
                    entry.create_system = 3
                    entry.external_attr = (stat.S_IFREG | (0o755 if name == executable else 0o644)) << 16
                    package.writestr(entry, data)
            self.checksum(archive)
            for name in ("install.sh", "install.ps1"):
                (directory / name).write_bytes((self.root / "scripts/cli-release" / name).read_bytes())

    def checksum(self, archive):
        archive.with_name(archive.name + ".sha256").write_bytes((hashlib.sha256(archive.read_bytes()).hexdigest() + "  " + archive.name + "\n").encode('ascii'))

    def run(self, command="validate", request=None, version="0.1.0"):
        output = io.StringIO()
        code = publisher.main([command, "--version", version, "--expected-sha", self.sha,
                               "--artifacts", str(self.artifacts)], source_root=self.root,
                              environ=self.env, output=output, request=request)
        return code, output.getvalue()


class GitHubFixture:
    def __init__(self, fixture, failure=None):
        self.fixture = fixture
        self.failure = failure
        self.calls = []
        self.assets = {}
        self.draft = None
        self.trunk_reads = 0

    def __call__(self, method, url, headers, body, limit):
        self.calls.append((method, url, headers, body))
        parsed = urlparse(url)
        path = parsed.path
        value = None
        status = 200
        if parsed.netloc in ("github.com", "release-assets.githubusercontent.com"):
            if self.failure in ("redirect", "hostile-redirect") and parsed.netloc == "github.com":
                host = "release-assets.githubusercontent.com" if self.failure == "redirect" else "attacker.example"
                return 302, {"Location": "https://" + host + "/" + path.rsplit("/", 1)[1]}, b""
        if parsed.netloc in ("github.com", "release-assets.githubusercontent.com"):
            self.assert_anonymous(headers)
            name = path.rsplit("/", 1)[1]
            data = self.assets[name]
            if self.failure == "anonymous-corruption":
                data += b"changed"
            return 200, {}, data
        if path.endswith("/git/ref/heads/trunk"):
            self.trunk_reads += 1
            sha = self.fixture.sha
            if self.failure == "moved-trunk" or (self.failure == "moved-before-publish" and self.trunk_reads > 2):
                sha = "b" * 40
            value = {"object": {"type": "commit", "sha": sha}}
        elif "/git/ref/tags/" in path:
            if self.failure == "existing-tag" or self.draft is False:
                value = {"object": {"type": "commit", "sha": self.fixture.sha if self.failure != "bad-final-tag" else "b" * 40}}
            else:
                status, value = 404, {"message": "not found"}
        elif parsed.netloc == "uploads.github.com":
            name = parse_qs(parsed.query)["name"][0]
            self.assets[name] = body
            if self.failure == "lost-upload":
                raise OSError("synthetic lost response with sensitive remote details")
            status, value = 201, self.asset(name)
        elif path.endswith("/releases/7/assets"):
            value = [self.asset(name) for name in self.assets]
        elif path.endswith("/releases/7"):
            if method == "PATCH":
                self.draft = False
                if self.failure == "lost-publish":
                    raise OSError("synthetic lost publication response")
            value = self.release()
        elif path.endswith("/releases"):
            if method == "GET":
                value = [{"tag_name": "cli-v0.1.0", "draft": True}] if self.failure == "existing-draft" else []
            else:
                self.draft = True
                if self.failure == "lost-create":
                    raise OSError("synthetic lost create response")
                status, value = 201, self.release()
        elif path == "/repos/B4rz99/fidy-ai":
            value = {"private": self.failure == "private-repo", "default_branch": "trunk"}
        else:
            raise AssertionError("Unexpected external call " + method + " " + path)
        return status, {}, json.dumps(value).encode()

    def assert_anonymous(self, headers):
        if any(key.lower() in ("authorization", "cookie") for key in headers):
            raise AssertionError("Anonymous verification received credentials")

    def asset(self, name):
        data = self.assets[name]
        return {"id": list(self.assets).index(name) + 1, "name": name, "state": "uploaded",
                "size": len(data), "digest": "sha256:" + hashlib.sha256(data).hexdigest()}

    def release(self):
        return {"id": 7, "tag_name": "cli-v0.1.0", "target_commitish": self.fixture.sha,
                "draft": self.draft, "prerelease": False}


class PublisherTests(unittest.TestCase):
    def test_invalid_dispatch_context_or_version_never_reaches_github(self):
        for key, value in (("GITHUB_REF", "refs/heads/topic"), ("GITHUB_SHA", "b" * 40),
                           ("RELEASE_WORKFLOW_SHA", "b" * 40), ("GITHUB_RUN_ATTEMPT", "2"),
                           ("GITHUB_EVENT_NAME", "pull_request"), ("GITHUB_REPOSITORY", "other/repository")):
            with self.subTest(key=key), tempfile.TemporaryDirectory() as temporary:
                fixture = Fixture(Path(temporary))
                fixture.env[key] = value
                calls = []
                code, output = fixture.run("publish", request=lambda *args: calls.append(args))
                self.assertEqual(code, 1, output)
                self.assertEqual(calls, [])
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            for version in ("v0.1.0", "0.1.0;touch bad", "00.1.0", "0.2.0"):
                code, output = fixture.run(version=version)
                self.assertEqual(code, 1, output)

    def test_incomplete_structured_source_evidence_blocks_even_with_true_attestations(self):
        for failure in ("unresolved", "missing-component", "missing-evidence", "stale-inventory"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                fixture = Fixture(Path(temporary))
                path = fixture.root / fixture.materials["source_obligations"]["path"]
                source = json.loads(path.read_bytes())
                if failure == "unresolved":
                    source["components"][0]["status"] = "unresolved"
                elif failure == "missing-component":
                    source["components"].pop()
                elif failure == "missing-evidence":
                    source["components"][0].update(requirement="source_required", status="fulfilled")
                else:
                    source["inventory_sha256"] = "a" * 64
                path.write_text(json.dumps(source))
                fixture.rebind_review()
                calls = []
                code, output = fixture.run("publish", request=lambda *args: calls.append(args))
                self.assertEqual(code, 1, output)
                self.assertEqual(calls, [])

    def test_committed_source_changes_invalidate_the_earlier_review(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            (fixture.root / "new-source.txt").write_text("Changed source")
            fixture.commit()
            calls = []
            code, output = fixture.run("publish", request=lambda *args: calls.append(args))
            self.assertEqual(code, 1, output)
            self.assertIn("Reviewed source tree", output)
            self.assertEqual(calls, [])

    def test_anonymous_redirects_are_bounded_to_github_hosts_and_never_receive_credentials(self):
        for failure, expected in (("redirect", 0), ("hostile-redirect", 1)):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                fixture = Fixture(Path(temporary))
                github = GitHubFixture(fixture, failure)
                code, output = fixture.run("publish", request=github)
                self.assertEqual(code, expected, output)
                if expected:
                    self.assertIn("Publication may exist", output)
                self.assertFalse(any("attacker.example" in url for _, url, _, _ in github.calls))

    def test_material_preparation_is_offline_and_writes_only_the_two_reviewed_notices(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            destination = fixture.root / "candidates/prepared"
            calls = []
            output = io.StringIO()
            code = publisher.main(["materials", "--version", "0.1.0", "--destination", str(destination)],
                                  source_root=fixture.root, environ={}, output=output,
                                  request=lambda *args: calls.append(args))
            self.assertEqual(code, 0, output.getvalue())
            self.assertEqual({path.name for path in destination.iterdir()}, {"BUN-LICENSE.txt", "THIRD-PARTY-NOTICES.txt"})
            self.assertEqual((destination / "BUN-LICENSE.txt").read_bytes(), b"Synthetic Bun license fixture.\n")
            self.assertEqual(calls, [])

    def test_publication_creates_one_draft_uploads_each_asset_once_and_checks_anonymous_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            github = GitHubFixture(fixture)
            code, output = fixture.run("publish", request=github)
            self.assertEqual(code, 0, output)
            self.assertIn("Published and anonymously verified", output)
            mutations = [(method, url) for method, url, _, _ in github.calls if method != "GET"]
            self.assertEqual(len(mutations), 10)
            self.assertEqual(len(set(mutations)), 10)
            self.assertEqual(len(github.assets), 8)
            self.assertFalse(github.draft)
            create = json.loads(next(body for method, url, _, body in github.calls if method == "POST" and url.endswith("/releases")))
            self.assertTrue(create["draft"])
            self.assertEqual(create["target_commitish"], fixture.sha)
            self.assertFalse(create["generate_release_notes"])

    def test_existing_release_tag_private_repository_or_moved_trunk_cannot_mutate(self):
        for failure in ("existing-tag", "existing-draft", "private-repo", "moved-trunk"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                fixture = Fixture(Path(temporary))
                github = GitHubFixture(fixture, failure)
                code, output = fixture.run("publish", request=github)
                self.assertEqual(code, 1, output)
                self.assertFalse(any(method != "GET" for method, _, _, _ in github.calls))

    def test_ambiguous_mutation_or_failed_final_verification_never_retries_or_claims_no_release(self):
        for failure, mutation_count in (("lost-create", 1), ("lost-upload", 2), ("lost-publish", 10),
                                        ("moved-before-publish", 9), ("anonymous-corruption", 10), ("bad-final-tag", 10)):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                fixture = Fixture(Path(temporary))
                github = GitHubFixture(fixture, failure)
                code, output = fixture.run("publish", request=github)
                self.assertEqual(code, 1, output)
                self.assertIn("Publication may exist", output)
                self.assertIn("Do not rerun", output)
                self.assertNotIn("synthetic lost", output)
                self.assertEqual(sum(method != "GET" for method, _, _, _ in github.calls), mutation_count)

    def test_all_native_archives_and_exact_reviewed_material_validate_without_execution(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Fixture(Path(temporary))
            code, output = fixture.run()
            self.assertEqual(code, 0, output)
            self.assertIn("Validated 8 release assets", output)

    def test_changed_candidate_notice_or_installer_fails_without_network(self):
        for changed in ("BUN-LICENSE.txt", "THIRD-PARTY-NOTICES.txt", "extra-entry", "installer",
                        "checksum", "missing-platform", "wrong-platform", "entry-order"):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as temporary:
                fixture = Fixture(Path(temporary))
                directory = fixture.artifacts / "cli-candidate-Linux-X64"
                archive = directory / "fidy-linux-x64.zip"
                if changed.endswith('.txt'):
                    with zipfile.ZipFile(archive) as package:
                        entries = [(entry, package.read(entry)) for entry in package.infolist()]
                    with zipfile.ZipFile(archive, "w") as package:
                        for entry, data in entries:
                            package.writestr(entry, b"Unreviewed replacement notice.\n"
                                             if entry.filename == changed else data)
                    fixture.checksum(archive)
                elif changed == "extra-entry":
                    with zipfile.ZipFile(archive, "a") as package:
                        package.writestr("unexpected.txt", b"unreviewed")
                    fixture.checksum(archive)
                elif changed == "installer":
                    (directory / "install.sh").write_bytes(b"unexpected")
                elif changed == "checksum":
                    archive.write_bytes(archive.read_bytes() + b"corruption")
                elif changed == "wrong-platform":
                    source = fixture.artifacts / "cli-candidate-macOS-ARM64/fidy-darwin-arm64.zip"
                    archive.write_bytes(source.read_bytes())
                    fixture.checksum(archive)
                elif changed == "entry-order":
                    with zipfile.ZipFile(archive) as package:
                        entries = [(entry, package.read(entry)) for entry in package.infolist()]
                    with zipfile.ZipFile(archive, "w") as package:
                        for entry, data in reversed(entries):
                            package.writestr(entry, data)
                    fixture.checksum(archive)
                else:
                    archive.unlink()
                calls = []
                code, output = fixture.run("publish", request=lambda *args, **kwargs: calls.append(args))
                self.assertEqual(code, 1, output)
                self.assertEqual(calls, [])
                if changed.endswith('.txt'):
                    self.assertIn('Packaged notices differ from reviewed materials.', output)

    def test_production_http_adapter_rejects_authenticated_cross_origin_redirects(self):
        # Keep the production opener and NoRedirect handler. Only the TLS socket
        # connection is mapped to controlled loopback HTTP servers; no external
        # network or real credentials are used. A redirect-handler regression
        # would reach the second server, making credential transmission observable.
        for boundary in ('api', 'upload'):
            with self.subTest(boundary=boundary), tempfile.TemporaryDirectory() as temporary:
                fixture = Fixture(Path(temporary))
                github = GitHubFixture(fixture)
                received, redirected = [], []

                class RedirectTarget(BaseHTTPRequestHandler):
                    def do_GET(self):
                        redirected.append((self.command, dict(self.headers)))
                        self.send_response(200)
                        self.end_headers()
                        self.wfile.write(b'{}')

                    do_POST = do_GET
                    do_PATCH = do_GET

                    def log_message(self, *args):
                        pass

                class TrustedOrigin(BaseHTTPRequestHandler):
                    def do_GET(self):
                        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
                        host = self.headers['Host']
                        received.append((self.command, host, dict(self.headers)))
                        if ((boundary == 'api' and host == 'api.github.com')
                                or (boundary == 'upload' and host == 'uploads.github.com')):
                            status, headers, payload = 302, {'Location': 'https://redirected.example/collect'}, b'{}'
                        else:
                            status, headers, payload = github(
                                self.command, 'https://' + host + self.path,
                                dict(self.headers), body, publisher.MAX_TEXT)
                        self.send_response(status)
                        for name, value in headers.items():
                            self.send_header(name, value)
                        self.send_header('Content-Length', str(len(payload)))
                        self.end_headers()
                        self.wfile.write(payload)

                    do_POST = do_GET
                    do_PATCH = do_GET

                    def log_message(self, *args):
                        pass

                trusted = ThreadingHTTPServer(('127.0.0.1', 0), TrustedOrigin)
                target = ThreadingHTTPServer(('127.0.0.1', 0), RedirectTarget)
                servers = (trusted, target)
                threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in servers]
                for thread in threads:
                    thread.start()

                class LoopbackConnection(http.client.HTTPConnection):
                    def __init__(self, host, timeout=60, **kwargs):
                        if host in ('api.github.com', 'uploads.github.com'):
                            port = trusted.server_port
                        elif host == 'redirected.example':
                            port = target.server_port
                        else:
                            raise AssertionError('Unexpected transport destination: ' + host)
                        super().__init__('127.0.0.1', port, timeout=timeout)

                try:
                    with patch('http.client.HTTPSConnection', LoopbackConnection), patch(
                            'urllib.request.getproxies', return_value={}):
                        code, output = fixture.run('publish')
                finally:
                    for server in servers:
                        server.shutdown()
                        server.server_close()
                    for thread in threads:
                        thread.join(timeout=5)
                self.assertEqual(code, 1, output)
                self.assertIn('GitHub returned HTTP 302', output)
                self.assertEqual(redirected, [], 'Authenticated redirect reached a different origin')
                self.assertTrue(all(headers.get('Authorization') == 'Bearer synthetic-test-token'
                                    for _, _, headers in received))
                mutations = [(method, host) for method, host, _ in received if method != 'GET']
                if boundary == 'api':
                    self.assertEqual(len(received), 1)
                    self.assertEqual(mutations, [])
                    self.assertNotIn('Publication may exist', output)
                else:
                    self.assertEqual(mutations, [('POST', 'api.github.com'), ('POST', 'uploads.github.com')])
                    self.assertEqual(received[-1][1], 'uploads.github.com')
                    self.assertIn('Publication may exist', output)
                    self.assertIn('Do not rerun', output)

    def test_preparation_hash_changes_with_committed_source_but_not_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            def git(*args):
                return subprocess.check_output(["git", "-C", str(root), *args], stderr=subprocess.DEVNULL)
            git("init", "-q")
            git("config", "user.name", "Fixture")
            git("config", "user.email", "fixture@example.invalid")
            (root / "source.txt").write_text("first")
            path = root / "scripts/cli-release/publish-readiness.json"
            path.parent.mkdir(parents=True)
            path.write_text("{}")
            git("add", ".")
            git("commit", "-qm", "fixture")
            def prepare():
                output = io.StringIO()
                result = publisher.main(["prepare"], source_root=root, output=output)
                self.assertEqual(result, 0, output.getvalue())
                return json.loads(output.getvalue())["source_tree_sha256"]
            first = prepare()
            path.write_text('{"status":"blocked"}')
            git("add", ".")
            git("commit", "-qm", "review")
            self.assertEqual(prepare(), first)
            (root / "source.txt").write_text("second")
            git("add", ".")
            git("commit", "-qm", "source")
            self.assertNotEqual(prepare(), first)

    def test_incomplete_readiness_cannot_reach_network(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = root / "scripts/cli-release/publish-readiness.json"
            manifest.parent.mkdir(parents=True)
            manifest.write_text(json.dumps({"status": "blocked"}))
            output = io.StringIO()
            calls = []
            result = publisher.main(
                ["preflight", "--version", "0.1.0", "--expected-sha", "a" * 40],
                source_root=root, environ={}, output=output,
                request=lambda *args, **kwargs: calls.append(args),
            )
            self.assertEqual(result, 1)
            self.assertIn("readiness is blocked", output.getvalue())
            self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
