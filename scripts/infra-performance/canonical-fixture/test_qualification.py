import unittest
from copy import deepcopy

from installation import SCRIPTS, validate_qualification


class ReleaseQualificationTests(unittest.TestCase):
    def test_only_the_promoted_rollback_tested_pair_and_verified_user_namespace_are_admitted(self):
        versions = dict(core="bf90ea0f-ab51-4611-b7a8-600ef4a6babf", ingress="a79c9dc5-cb29-4fd0-af2d-a083a75e0508")
        deployments = dict(core="2e8da812-f8a1-42ab-82eb-6a00cf9177a3", ingress="039cbd10-6531-46c6-8454-d50033af164f")
        revision = "a" * 40
        candidate = dict(revision=revision, versions=versions, deployments=deployments, userNamespace="e" * 32)
        snapshot = dict(revision=revision, stableRevision="b" * 40,
                        public=dict(name=SCRIPTS["ingress"]), core=dict(name=SCRIPTS["core"]))
        release = dict(snapshot=snapshot, publicVersionId=versions["ingress"], coreVersionId=versions["core"])
        proof = dict(rollbackTested=True, release=release, promoted=dict(publicDeploymentId=deployments["ingress"],
                                                                          coreDeploymentId=deployments["core"]))
        installed = dict(revision=revision, publicVersionId=versions["ingress"], coreVersionId=versions["core"],
                         userNamespace=candidate["userNamespace"], admission="closed")
        validate_qualification(candidate, proof, installed)
        for obj, field, value in [
            (proof, "rollbackTested", False), (proof["release"], "publicVersionId", versions["core"]),
            (proof["promoted"], "coreDeploymentId", deployments["ingress"]),
            (snapshot, "revision", snapshot["stableRevision"]), (installed, "admission", "open"),
            (installed, "userNamespace", "f" * 32), (installed, "revision", "c" * 40),
            (snapshot["core"], "name", SCRIPTS["ingress"]),
        ]:
            original = deepcopy(obj[field])
            obj[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_qualification(candidate, proof, installed)
            obj[field] = original

    def test_native_collection_requires_the_four_release_buckets_to_still_use_standard_storage(self):
        from qualified_release import standard_buckets
        names = ["fidy-native-"+role for role in ("release-smoke","forwarded-email","approved-ingest-samples","statement-staging")]
        record = {"resources":{"buckets":names}}
        def metadata(path):
            return {"name":path.split("/")[-1],"storage_class":"Standard"}
        standard_buckets(metadata, "a"*32, record)
        for observed in [lambda path: {**metadata(path),"storage_class":"InfrequentAccess"},
                         lambda path: {"name":path.split("/")[-1]}]:
            with self.assertRaises(ValueError):
                standard_buckets(observed, "a"*32, record)
