import hashlib
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

from successor_resume import APPLY_STEPS, APPLY_WORKFLOW, workflow_receipt, write_capture
from successor_partial import CORE_VERSION, FAILED_RUN, INGRESS_VERSION, PLAN_RUN, REVISION

VERIFIER = "a" * 40
CHECKOUT = "b" * 40
RUN = "42"
ARTIFACT = "17"
RECEIPT = {
    "verifierRevision": VERIFIER,
    "candidateRevision": REVISION,
    "failedRun": FAILED_RUN,
    "planRun": PLAN_RUN,
    "approval": {"artifactId": "31", "sha256": "a" * 64},
    "stateProof": "c" * 64,
    "instanceProof": "d" * 64,
    "workflowId": "76ba6164-d2be-4110-8706-12d72c647203",
    "candidateTraffic": 0,
    "applied": True,
    "recoveryReady": False,
}
REPO = "B4rz99/fidy-ai"


def responses(receipt=RECEIPT, steps=APPLY_STEPS):
    output = BytesIO()
    with ZipFile(output, "w") as archive:
        archive.writestr("native-workflow-recovery-applied.json", json.dumps(receipt))
    archive = output.getvalue()
    digest = hashlib.sha256(archive).hexdigest()
    replies = {
        f"artifacts/{ARTIFACT}": {
            "id": int(ARTIFACT), "expired": False, "name": f"native-workflow-recovery-applied-{RUN}",
            "workflow_run": {"id": int(RUN), "head_sha": VERIFIER},
            "digest": "sha256:" + digest, "size_in_bytes": len(archive),
        },
        f"runs/{RUN}": {
            "id": int(RUN), "repository": {"full_name": REPO}, "head_repository": {"full_name": REPO},
            "path": ".github/workflows/" + APPLY_WORKFLOW, "head_branch": "trunk",
            "head_sha": VERIFIER, "event": "workflow_dispatch", "conclusion": "success", "run_attempt": 1,
        },
        f"runs/{RUN}/attempts/1/jobs?per_page=100": {
            "total_count": 1, "jobs": [{"name": "apply", "conclusion": "success",
                "steps": [{"name": step, "conclusion": "success"} for step in steps]}],
        },
    }

    def get(path):
        return archive if path == f"artifacts/{ARTIFACT}/zip" else json.dumps(replies[path]).encode()

    return digest, get


class RestoreExactSuccessor(unittest.TestCase):
    def test_reuses_the_authenticated_archival_capture(self):
        digest, get = responses()
        with patch("successor_resume.approved_current_plan", return_value={"stateProof": RECEIPT["stateProof"]}) as verify:
            receipt, approved = workflow_receipt(CHECKOUT, ARTIFACT, digest, get=get, git=lambda *_: VERIFIER)
        verify.assert_called_once_with(VERIFIER, RECEIPT["approval"], get=get)
        self.assertEqual(approved["stateProof"], RECEIPT["stateProof"])
        self.assertEqual(receipt, RECEIPT)
        with tempfile.TemporaryDirectory() as base:
            directory = Path(base)
            snapshot, source = {"snapshot": "prior"}, {"source": "prior"}
            write_capture(directory, source, snapshot, receipt, CHECKOUT, ARTIFACT, digest)
            self.assertEqual(json.loads((directory / "native-release.json").read_text()), snapshot)
            proof = json.loads((directory / "fixture-successor-resume.json").read_text())
            self.assertEqual(proof, {
                "coreVersionId": CORE_VERSION, "publicVersionId": INGRESS_VERSION,
                "verifierRevision": CHECKOUT, "supportVerifierRevision": VERIFIER,
                "supportArtifact": ARTIFACT, "supportSha256": digest,
            })
            with self.assertRaises(FileExistsError):
                write_capture(directory, source, snapshot, receipt, CHECKOUT, ARTIFACT, digest)

    def test_refuses_incomplete_provider_evidence_and_changed_traffic(self):
        for receipt, steps in ((RECEIPT, APPLY_STEPS[:-1]), ({**RECEIPT, "candidateTraffic": 1}, APPLY_STEPS)):
            digest, get = responses(receipt, steps)
            with self.assertRaises(ValueError):
                workflow_receipt(CHECKOUT, ARTIFACT, digest, get=get, git=lambda *_: VERIFIER)
        digest, get = responses()
        with self.assertRaisesRegex(ValueError, "outside the protected lineage"):
            workflow_receipt(CHECKOUT, ARTIFACT, digest, get=get, git=lambda *_: CHECKOUT)


if __name__ == "__main__":
    unittest.main()
