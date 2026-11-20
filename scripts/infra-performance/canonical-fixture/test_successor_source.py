import unittest
from copy import deepcopy

from successor_source import ORIGINAL_REVISION, verify_live_predecessor, verify_prior_custody


class SuccessorSourceTests(unittest.TestCase):
    def test_requires_original_issued_receipt_and_exact_disposed_custody(self):
        prefix, account, revision = "fidy-2259-0123456789ab", "a"*32, "b"*40
        proof = dict(resourcePrefix=prefix, nativeRevision=revision, member="performance-1",
                     scope="hosted native fixture", originals=8, effective=7,
                     nativeReceiptDigest="c"*64)
        cleanup = dict(scope="hosted native cohort", status="disposed", physicalState="empty",
                       survivors=2, retainedOneUseFence=True, originalDaySettled=True)
        installed = dict(revision=revision, userNamespace="d"*32)
        coords = dict(revision=revision, account=account, prefix=prefix,
                      archive="e"*64, userNamespace="d"*32)
        custody = dict(coordinates=coords, stage="disposed", physicalState="empty",
                       receiptVerified=True, receiptMarkerRetained=True,
                       foregroundRun="first/1", cleanupRun="cleanup/1",
                       receiptDigest=proof["nativeReceiptDigest"])
        def verify_fixture(marker=prefix):
            return verify_prior_custody(proof, cleanup, installed, custody, marker,
                                        coordinates=coords, original_run="first/1", cleanup_run="cleanup/1")
        verify_fixture()
        for document, key, wrong in (
            (proof, "resourcePrefix", "fidy-2259-ffffffffffff"), (proof, "member", "performance-2"),
            (proof, "nativeReceiptDigest", "f"*64), (cleanup, "retainedOneUseFence", False),
            (custody, "coordinates", {**coords, "userNamespace":"0"*32}),
            (custody, "stage", "erasure-offered"), (custody, "cleanupRun", "elsewhere/1"),
            (custody, "receiptMarkerRetained", False), (installed, "revision", "0"*40),
        ):
            correct = deepcopy(document[key])
            document[key] = wrong
            try:
                with self.subTest(key=key), self.assertRaises(ValueError):
                    verify_fixture()
            finally:
                document[key] = correct
        for marker in (None, "fidy-2259-ffffffffffff"):
            with self.subTest(marker=marker), self.assertRaises(ValueError):
                verify_fixture(marker)


    def test_refuses_changed_live_versions_before_touching_custody(self):
        original = "994c008a-3003-4104-849f-20cd90645dfb"
        other = "bd98adbb-96ee-4b0f-b308-395897feecbf"
        def cloudflare(path):
            if "/domains?" in path:
                return [{"hostname":"storage-acceptance.fidyapp.com", "service":"fidy-native-storage-ingress",
                         "enabled":True, "previews_enabled":False}]
            self.assertTrue(path.endswith("/deployments"))
            return {"deployments":[{"id":other,"versions":[{"version_id":other,"percentage":100}]}]}
        with self.assertRaisesRegex(ValueError, "Expected native version"):
            verify_live_predecessor(cloudflare, "a"*32, {},
                                    dict(revision=ORIGINAL_REVISION, publicVersionId=original, coreVersionId=original),
                                    "aa")
