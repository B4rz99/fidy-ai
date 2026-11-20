import unittest

import successor_workflow_proof as proof


class WorkflowRecoveryProofTests(unittest.TestCase):
    def test_foreign_or_missing_approval_is_refused(self):
        candidate = proof.REVISION
        initial = dict(verifierRevision=proof.INITIAL_VERIFIER, candidateRevision=candidate, applied=False,
                       candidateTraffic=0, recoveryReady=False, change={"logicalId":"ReleaseSmokeWorkflowV2-"+candidate,
                           "resourceType":"Cloudflare.Workflow", "action":"create"},
                       unchanged=["ReleaseSmoke-"+candidate,"ReleaseSmokeBucket","ReleaseSmokeQueue-"+candidate])
        current = dict(initial, verifierRevision="c"*40, stateProof="a"*64, instanceProof="b"*64)
        proof.require_approved_scope(proof.INITIAL_RUN, initial, "c"*40, current)
        for change in (dict(verifierRevision=proof.INITIAL_VERIFIER), dict(stateProof=""),
                       dict(unchanged=[]), dict(applied=True), dict(candidateTraffic=100)):
            with self.assertRaises(ValueError):
                proof.require_approved_scope(proof.INITIAL_RUN, initial, "c"*40, dict(current, **change))

    def test_physical_workflow_must_agree_with_the_persisted_provider_attribute(self):
        approved = dict(verifierRevision="c"*40, candidateRevision=proof.REVISION, stateProof="a"*64, instanceProof="b"*64)
        saved = dict(approved, workflowId="d"*32)
        physical = dict(id=saved["workflowId"], name=proof.SMOKE, script_name=proof.SMOKE,
                        class_name="ReleaseSmokeWorkflowV2", schedules=[])
        read = lambda _: (200, dict(success=True, result=physical))
        self.assertEqual(proof.verify_saved_workflow(read, "e"*32, saved, approved), saved["workflowId"])
        physical["id"] = "f"*32
        with self.assertRaisesRegex(ValueError, "Physical Workflow"):
            proof.verify_saved_workflow(read, "e"*32, saved, approved)


if __name__ == "__main__":
    unittest.main()
