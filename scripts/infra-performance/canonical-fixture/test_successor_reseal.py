from copy import deepcopy
import unittest

from successor_artifacts import RESEAL_CAPTURE_STEP, RESUME_CAPTURE_STEP, reseal_steps
from successor_reseal import ASSIGNMENTS, UPLOADS, predecessor_view


class SuccessorResealTests(unittest.TestCase):
    def test_exact_zero_percent_assignment_and_real_predecessor_are_required(self):
        stable = {"name": "fidy-native-storage-core", "deploymentId": "old-id", "stableVersionId": "old-version"}
        release = dict(snapshot={"core": stable, "public": {"name": "fidy-native-storage-ingress"}},
                       **UPLOADS, **ASSIGNMENTS)
        old = {"id": "old-id", "versions": [{"version_id": "old-version", "percentage": 100}]}
        staged = {"id": ASSIGNMENTS["coreDeploymentId"], "versions": [
            {"version_id": UPLOADS["coreVersionId"], "percentage": 0},
            {"version_id": "old-version", "percentage": 100},
        ]}
        request = "accounts/test/workers/scripts/fidy-native-storage-core/deployments"
        shell = {"success": True, "result": {"deployments": [staged, old]}}
        view = predecessor_view(release, lambda _: (200, shell), "test")
        self.assertEqual(view(request)[1]["result"]["deployments"], [old])
        self.assertEqual(view("accounts/test/workers/scripts/another/deployments"), (200, shell))
        for edit in (lambda result: result[0].update(id="foreign-assignment"),
                     lambda result: result[1].update(id="foreign-predecessor"),
                     lambda result: result[0]["versions"][0].update(percentage=1)):
            changed = deepcopy(shell)
            edit(changed["result"]["deployments"])
            with self.assertRaisesRegex(ValueError, "zero-traffic assignment"):
                predecessor_view(release, lambda _: (200, changed), "test")(request)

    def test_reseal_provenance_requires_verification_and_no_new_assignment(self):
        steps = reseal_steps()
        self.assertEqual(steps[RESEAL_CAPTURE_STEP], "success")
        self.assertEqual(steps[RESUME_CAPTURE_STEP], "skipped")
        self.assertEqual(steps["Upload the approved successor resources"], "skipped")
        self.assertEqual(steps["Stage the verified successors at zero traffic"], "skipped")
        self.assertEqual(steps["Verify the successor and seal the dormant stage"], "success")


if __name__ == "__main__":
    unittest.main()
