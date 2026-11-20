from copy import deepcopy
from unittest import TestCase
from unittest.mock import patch
from uuid import UUID

import qualified_release
import pairing_stage
from qualified_release import retained_provider, fixture_upload
from staged_application import APPLICATION, STAGED_IDS
import test_fallback_stage
from test_unsealed_stage import inventory


class PairingStage(TestCase):
    def setUp(self):
        self.archive = test_fallback_stage.VerifiedFallback()
        self.archive.setUp()
        self.archive.jobs = inventory(pairing_stage.STEPS, "success")
        self.prior = {"snapshot": {"revision": APPLICATION, "stableRevision": "d"*40,
            "stableContractDigest": "3"*64, **{role: {"name": "fidy-native-storage-" + name,
            "deploymentId": str(UUID(int=index)), "stableVersionId": str(UUID(int=10+index))}
            for index, (role, name) in enumerate((("core", "core"), ("public", "ingress")), 1)}}, **STAGED_IDS}
        self.snapshot = deepcopy(self.prior["snapshot"])
        self.snapshot["revision"] = self.archive.source
        for role in ("core", "public"):
            self.snapshot[role]["deploymentId"] = STAGED_IDS[role + "DeploymentId"]
        self.stage = {"revision": self.archive.source, "stableRevision": self.snapshot["stableRevision"],
            "release": {"snapshot": self.snapshot, **{key:str(UUID(int=i+100)) for i,key in enumerate(STAGED_IDS)}},
            "namespaces": {role: ("%032x" % i) for i, role in enumerate(pairing_stage.OWNERS, 1)},
            "provider": retained_provider(), "smoke": {"versionId": str(UUID(int=31)), "deploymentId": str(UUID(int=32))},
            "controlsDigest":fixture_upload()["controlsDigest"]}
        self.archive.docs = {"native-fallback-stage.json": self.stage}

    def authenticate(self):
        self.archive.seal()
        with patch.object(pairing_stage, "staged_documents", return_value=(self.prior, {"digest": self.stage_digest})):
            return pairing_stage.sealed_pair(self.archive.verifier, "34", self.archive.digest,
                                            self.archive.get, self.archive.git)

    @property
    def stage_digest(self):
        return fixture_upload()["controlsDigest"]

    def test_only_a_successfully_sealed_replacement_of_the_original_pair_can_be_recovered(self):
        self.assertEqual(self.authenticate(), (self.stage, self.prior))
        for obj, mutation in ((self.stage, {"revision":APPLICATION}), (self.stage, {"controlsDigest":"7"*64}),
                (self.stage, {"provider":{}}), (self.snapshot["core"], {"deploymentId":str(UUID(int=56))}),
                (self.stage["release"], {"publicVersionId":STAGED_IDS["publicVersionId"]}),
                (self.stage["namespaces"], {"user":self.stage["namespaces"]["erasure"]})):
            with self.subTest(mutation=mutation), patch.dict(obj, mutation), self.assertRaises(ValueError):
                self.authenticate()
        for step in self.archive.jobs["jobs"][0]["steps"]:
            with self.subTest(step=step["name"]), patch.dict(step, conclusion="cancelled"), self.assertRaises(ValueError):
                self.authenticate()
        self.archive.changed = "apps/server/cloudflare/core-worker.ts\0"
        with self.assertRaises(ValueError):
            self.authenticate()

    def test_active_rollout_must_chain_to_the_same_dormant_versions_and_namespaces(self):
        release = {"snapshot":{"revision": self.archive.source, "stableRevision": self.archive.source},
                   **{role + "VersionId":str(UUID(int=200+i)) for i, role in enumerate(("core", "public"))}}
        for role in ("core", "public"):
            release["snapshot"][role] = {"stableVersionId":self.stage["release"][role + "VersionId"]}
        installed = {"revision":self.archive.source, "verifierRevision":self.archive.source,
            "fixtureControlsDigest":self.stage_digest, "retainedProvider":retained_provider(),
            "userNamespace":self.stage["namespaces"]["user"],
            "namespaces":[self.stage["namespaces"][key] for key in pairing_stage.OWNERS],
            "workers":[{"role":"Smoke", **self.stage["smoke"]}]}
        pin = {"artifactId":"71", "sha256":"a"*64}
        promotion = {"release":release, "rollbackTested":True}
        self.archive.docs = {"native-release.json.seal":pin,"native-release.json.promoted":promotion,
                             "native-verification.json":installed}
        self.archive.jobs = inventory(qualified_release.ROLLOUT_STEPS, "success")
        self.archive.meta["name"] = "native-storage-release-12"
        def collect():
            self.archive.seal()
            with patch.object(pairing_stage, "sealed_pair", return_value=(self.stage, self.prior)) as verify:
                result = qualified_release.artifact(self.archive.source, "34", self.archive.digest, self.archive.get, self.archive.git)
                verify.assert_called_once_with(self.archive.source, "71", "a"*64, self.archive.get, self.archive.git)
                return result
        self.assertEqual(collect(), (promotion, installed))
        for obj, mutation in ((promotion, {"rollbackTested":False}), (release["snapshot"]["core"], {"stableVersionId":"other"}),
                (installed, {"namespaces":list(reversed(installed["namespaces"]))}), (installed, {"fixtureControlsDigest":"8"*64}),
                (installed["workers"][0], {"versionId":str(UUID(int=99))})):
            with self.subTest(mutation=mutation), patch.dict(obj, mutation), self.assertRaises(ValueError):
                collect()
