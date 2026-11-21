import json
import unittest
from unittest.mock import Mock, patch

from canonical_host_source import WORKFLOW_REF, require_protected_preview, verified_source

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
