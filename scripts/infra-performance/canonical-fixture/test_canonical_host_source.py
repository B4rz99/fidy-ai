from functools import partial
from io import BytesIO
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from zipfile import ZipFile

from canonical_host_source import (WORKFLOW_REF, approved_transfer, protected_release_job, require_ordinary_source,
                                   require_protected_preview, verified_source)

VERIFIER = "a" * 40
REVISION = "c" * 40
REFERENCE = {"artifactId": "14600000001", "sha256": "b" * 64}
ENV = {
    "GITHUB_SHA": VERIFIER,
    "GITHUB_ACTIONS": "true",
    "GITHUB_REF_PROTECTED": "true",
    "GITHUB_REF": "refs/heads/trunk",
    "GITHUB_EVENT_NAME": "workflow_dispatch",
    "GITHUB_WORKFLOW_REF": WORKFLOW_REF,
    "GITHUB_RUN_ATTEMPT": "1",
    "FIXTURE_RELEASE_OPERATION": "plan-stage-hosts",
    "NATIVE_STORAGE_ADMISSION": "closed",
    "NATIVE_STORAGE_HOSTS": "staged",
}


class CanonicalHostSourceTest(unittest.TestCase):
    @patch("canonical_host_source.protected_release_job")
    @patch("canonical_host_source.protected_archive")
    def test_reuses_exact_transferred_source_in_protected_descendant(self, archive, job):
        producer = "d" * 40
        source = {"verifierRevision": VERIFIER, "revision": REVISION, "deployments": {"core": "exact-core"}}
        source_at_transfer = {**source, "verifierRevision": producer}
        get = Mock(return_value=json.dumps({"workflow_run": {"head_sha": producer}}))
        git = Mock(return_value=producer)
        job.return_value = {"steps": [{"name": name, "conclusion": "success"} for name in (
            "Authenticate the exact closed active source for canonical host planning",
            "Fence the exact incumbent writers before transferring canonical hosts",
            "Apply the approved canonical Access changes",
            "Transfer and verify the two closed canonical hosts",
            "Retain the verified closed canonical host transfer",
        )]}
        encoded = BytesIO()
        with ZipFile(encoded, "w") as received:
            received.writestr("native-verification.json.canonical-hosts",
                              json.dumps({"source": source_at_transfer, "admission": "closed"}))
        archive.return_value = ("44863387877", encoded.getvalue())

        result = approved_transfer(REFERENCE, source, VERIFIER, get, git)
        self.assertEqual(result["source"], source)
        self.assertEqual(archive.call_args.args[0], producer)
        git.assert_called_with("merge-base", producer, VERIFIER)
        with self.assertRaisesRegex(ValueError, "differs from the approved"):
            approved_transfer(REFERENCE, {**source, "deployments": {"core": "other"}}, VERIFIER, get, git)
        with self.assertRaisesRegex(ValueError, "outside the protected verifier lineage"):
            approved_transfer(REFERENCE, source, VERIFIER, get, Mock(return_value=REVISION))

    def test_requires_exact_release_and_skipped_site(self):
        release = {"name": "release", "status": "completed", "conclusion": "success", "steps": []}
        site = {"name": "site", "status": "completed", "conclusion": "skipped", "steps": []}
        jobs = {"total_count": 2, "jobs": [site, release]}
        get = Mock(return_value=json.dumps(jobs))
        self.assertEqual(protected_release_job("44849694523", get), release)
        get.assert_called_once_with("runs/44849694523/attempts/1/jobs?per_page=100")
        for rows in ([release], [release, site, site], [release, {**site, "conclusion": "success"}],
                     [release, {**site, "name": "foreign"}], [{**release, "conclusion": "skipped"}, site],
                     [release, {**site, "steps": [{"name": "Unexpected site work"}]}]):
            with self.subTest(rows=rows), self.assertRaisesRegex(ValueError, "protected release jobs"):
                protected_release_job("44849694523", Mock(return_value=json.dumps({
                    "total_count": len(rows), "jobs": rows,
                })))

    def test_allows_only_exact_worker_types_dev_pin(self):
        before = {"name": "@fidy/server", "devDependencies": {"@cloudflare/workers-types": "5.20261113.1"},
                  "dependencies": {"some-runtime": "1.2.3"}}
        after = {**before, "devDependencies": {"@cloudflare/workers-types": "5.20261114.1"}}
        with TemporaryDirectory() as directory:
            def git(*args):
                return subprocess.check_output(["git", "-C", directory, *args], text=True, timeout=10).strip()

            git("init", "-q")
            manifest = Path(directory) / "apps/server/package.json"
            manifest.parent.mkdir(parents=True)

            def commit(value):
                manifest.write_text(json.dumps(value), encoding="utf-8")
                git("add", ".")
                git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false",
                    "commit", "--allow-empty", "-qm", "manifest fixture")
                return git("rev-parse", "HEAD")

            old = commit(before)
            scoped_git = SimpleNamespace(run=partial(subprocess.run, cwd=directory),
                                         check_output=partial(subprocess.check_output, cwd=directory))
            with patch("canonical_host_source.subprocess", scoped_git):
                require_ordinary_source(old, old)
                require_ordinary_source(old, commit(after))
                for changed in (
                    {**after, "devDependencies": {"@cloudflare/workers-types": "5.20261115.1"}},
                    {**after, "devDependencies": {**after["devDependencies"], "other-types": "1.0.0"}},
                    {**after, "dependencies": {"some-runtime": "1.2.4"}},
                ):
                    with self.subTest(changed=changed), self.assertRaisesRegex(ValueError, "server manifest"):
                        require_ordinary_source(old, commit(changed))

    def test_current_protected_workflow_only(self):
        known_head = Mock(return_value=VERIFIER)
        self.assertEqual(require_protected_preview(ENV, known_head), VERIFIER)
        for key, value in {
            "GITHUB_REF_PROTECTED": "false",
            "GITHUB_RUN_ATTEMPT": "2",
            "GITHUB_WORKFLOW_REF": "other",
            "FIXTURE_RELEASE_OPERATION": "stage-hosts",
            "NATIVE_STORAGE_ADMISSION": "open",
            "NATIVE_STORAGE_HOSTS": "acceptance",
        }.items():
            with self.subTest(key=key), self.assertRaises(ValueError):
                require_protected_preview({**ENV, key: value}, known_head)
        with self.assertRaises(ValueError):
            require_protected_preview(ENV, Mock(return_value="b" * 40))

    @patch("canonical_host_source.serving_graph")
    @patch("canonical_host_source.validate_qualification")
    @patch("canonical_host_source.validate_candidate")
    @patch("canonical_host_source.active_successor")
    def test_reads_exact_active_source_before_inspecting_hosts(self, archive, candidate, qualification, graph):
        installed = {"coreVersionId": "core", "publicVersionId": "ingress", "nativeAccountingWitness": True,
                     "namespaces": ["user", "directory", "pricing", "maintenance", "erasure"],
                     "workers": [{"role": "Web", "versionId": "web-version", "deploymentId": "web-deployment"}],
                     "website": [{"revision": "web", "contractDigest": "web-contract"}]}
        archive.return_value = ("promotion", installed)
        candidate.return_value = {"deployments": {"core": "deployment-1", "ingress": "deployment-2"}}
        read = Mock()
        get = Mock(return_value=json.dumps({"workflow_run": {"head_sha": REVISION}}))
        result = verified_source(REFERENCE, VERIFIER, "account", "key", read, get)
        get.assert_called_once_with("artifacts/" + REFERENCE["artifactId"])
        archive.assert_called_once_with(REVISION, REFERENCE, get, verifier=VERIFIER)
        qualification.assert_called_once_with(candidate.return_value, "promotion", installed)
        graph.assert_called_once_with(read, "account", REVISION, installed)
        self.assertEqual(result["source"], REFERENCE)
        self.assertEqual(result["versions"], {"core": "core", "ingress": "ingress"})
        self.assertEqual(result["deployments"], candidate.return_value["deployments"])

        candidate.reset_mock()
        archive.return_value = ("promotion", {**installed, "nativeAccountingWitness": False})
        with self.assertRaisesRegex(ValueError, "qualified native accounting witness"):
            verified_source(REFERENCE, VERIFIER, "account", "key", read, get)
        candidate.assert_not_called()

        archive.return_value = ("promotion", installed)
        qualification.side_effect = ValueError("foreign deployment")
        graph.reset_mock()
        with self.assertRaisesRegex(ValueError, "foreign deployment"):
            verified_source(REFERENCE, VERIFIER, "account", "key", read, get)
        graph.assert_not_called()
