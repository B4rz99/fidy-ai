from copy import deepcopy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
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

    def git(self, command, *args):
        if command == "merge-base" and args[0] == pairing_stage.PAIRING_REPAIR:
            return pairing_stage.PAIRING_REPAIR
        return self.archive.git(command, *args)

    def authenticate(self):
        self.archive.seal()
        with patch.object(pairing_stage, "staged_documents", return_value=(self.prior, {"digest": self.stage_digest})):
            return pairing_stage.sealed_pair(self.archive.verifier, "34", self.archive.digest,
                                            self.archive.get, self.git)

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

    def test_recovery_publishes_only_the_source_from_the_independently_validated_seal(self):
        with TemporaryDirectory() as temp:
            env = {"GITHUB_SHA":self.archive.verifier, "STAGE_ARTIFACT":"34", "STAGE_SHA256":"e"*64,
                   "EXPECTED_INSTALLED_REVISION":self.archive.source, "FIXTURE_RELEASE_OPERATION":"recover-fixture-fallback",
                   "RUNNER_TEMP":temp, "GITHUB_ENV":str(Path(temp)/"env")}
            with patch.object(pairing_stage, "sealed_pair", return_value=(self.stage, self.prior)), \
                    patch.object(pairing_stage, "verify_dispatch") as check:
                with patch.dict(env, EXPECTED_INSTALLED_REVISION=APPLICATION), self.assertRaises(ValueError):
                    pairing_stage.bind(env)
                self.assertEqual(list(Path(temp).iterdir()), [])
                pairing_stage.bind(env)
                check.assert_called_with(env, application=self.archive.source)
            self.assertEqual(json.loads((Path(temp)/"native-fallback-stage.json").read_bytes()), self.stage)
            self.assertEqual(json.loads((Path(temp)/"native-release.json.predecessor").read_bytes()), self.prior)
            self.assertEqual(json.loads((Path(temp)/"native-release.json.seal").read_bytes()),
                             {"artifactId":"34","sha256":"e"*64})
            self.assertEqual((Path(temp)/"env").read_text().splitlines(), [
                "RELEASE_GIT_SHA="+self.archive.source, "FIXTURE_PAIRING_APPLICATION="+self.archive.source,
                "FIXTURE_STAGED_VERIFIER_SHA="+self.archive.verifier])

    def test_only_the_archived_unstaged_upload_and_its_unchanged_controls_can_resume(self):
        pin = pairing_stage.upload_pin()
        snapshot = {**self.snapshot, "revision": pin["revision"]}
        documents = {"native-release.json": snapshot, "native-release.json.controls": {"digest":self.stage_digest},
                     "native-release.json.predecessor":self.prior, "native-release.json.source.controls":{"digest":self.stage_digest}}
        original_steps = inventory(pairing_stage.INTERRUPTED_STEPS, "failure")
        def get(path):
            return json.dumps(original_steps)
        def verify_archive(source, artifact_id, digest, *, prefix, conclusions, get):
            self.assertEqual((source, artifact_id, digest, prefix, conclusions),
                             (pin["revision"], pin["artifact"], pin["sha256"], "native-storage-release-", {"failure"}))
            from test_unsealed_stage import archive
            return pin["run"], archive(documents)
        def restore():
            with patch.object(pairing_stage, "protected_archive", verify_archive):
                return pairing_stage.upload_documents(self.prior, {"digest":self.stage_digest}, get)
        self.assertEqual(restore(), documents)
        for key in ("native-release.json", "native-release.json.controls", "native-release.json.predecessor",
                    "native-release.json.source.controls", "native-fallback-stage.json"):
            with self.subTest(key=key), patch.dict(documents, {key:{}}), self.assertRaises(ValueError):
                restore()
        for step in original_steps["jobs"][0]["steps"]:
            with self.subTest(step=step["name"]), patch.dict(step, conclusion="cancelled"), self.assertRaises(ValueError):
                restore()

    def test_resumed_seal_authenticates_its_verifier_and_original_upload_independently(self):
        pin = pairing_stage.upload_pin()
        self.archive.jobs = inventory(pairing_stage.RESUME_STEPS, "success")
        self.stage.update(revision=pin["revision"], smoke=pin["smoke"])
        self.snapshot["revision"] = pin["revision"]
        for kind in ("publicVersionId", "coreVersionId"):
            self.stage["release"][kind] = pin[kind]
        def lineage(command, *args):
            return args[0] if command == "merge-base" else self.git(command, *args)
        def verify():
            self.archive.seal()
            with patch.object(pairing_stage, "upload_documents") as upload, \
                    patch.object(pairing_stage, "staged_documents", return_value=(self.prior, {"digest":self.stage_digest})):
                result = pairing_stage.sealed_pair(self.archive.verifier, "34", self.archive.digest, self.archive.get, lineage)
                upload.assert_called_once_with(self.prior, {"digest":self.stage_digest}, self.archive.get)
                return result
        self.assertEqual(verify(), (self.stage,self.prior))
        for obj, mutation in ((self.stage, {"revision":self.archive.source}), (self.stage, {"smoke":{}}),
                              (self.stage["release"], {"coreVersionId":str(UUID(int=900))})):
            with self.subTest(change=mutation), patch.dict(obj,mutation), self.assertRaises(ValueError):
                verify()

    def test_failed_resume_replacement_requires_the_exact_staged_history_and_financial_controls(self):
        from test_unsealed_stage import archive
        pin = pairing_stage.upload_pin()
        failed = pin["failedStage"]
        controls = {"digest": self.stage_digest}
        uploaded = {"native-release.json": pairing_stage.original_snapshot(pin["revision"], self.prior),
                    "native-release.json.predecessor": self.prior, "native-release.json.controls": controls,
                    "native-release.json.source.controls": controls}
        staged = {"snapshot": uploaded["native-release.json"], **{role + kind: source[role + kind]
                  for role in ("core", "public") for kind, source in (("VersionId", pin), ("DeploymentId", failed))}}
        docs = {**uploaded, "native-release.json": staged}
        jobs = inventory(pairing_stage.FAILED_RESUME_STEPS, "failure")
        def read_archive(source, artifact, digest, *, prefix, conclusions, get):
            self.assertEqual((source, artifact, digest, prefix, conclusions),
                (failed["verifier"], failed["artifact"], failed["sha256"], "native-storage-release-", {"failure"}))
            return failed["run"], archive(docs)
        def restore():
            with patch.object(pairing_stage, "staged_documents", return_value=(self.prior, controls)), \
                    patch.object(pairing_stage, "upload_documents", return_value=uploaded), \
                    patch.object(pairing_stage, "protected_archive", read_archive):
                return pairing_stage.replacement_documents(lambda path: json.dumps(jobs),
                        lambda cmd, *args: args[0] if cmd == "merge-base" else self.archive.git(cmd, *args))
        self.assertEqual(restore(), (staged, controls))
        for key in tuple(docs) + ("native-fallback-stage.json",):
            with self.subTest(key=key), patch.dict(docs, {key:{}}), self.assertRaises(ValueError):
                restore()
        for step in jobs["jobs"][0]["steps"]:
            with self.subTest(step=step["name"]), patch.dict(step, conclusion="cancelled"), self.assertRaises(ValueError):
                restore()

    def test_current_seal_requires_the_failed_resume_deployments_as_predecessors(self):
        pin = pairing_stage.upload_pin()
        failed = pin["failedStage"]
        prior = {"snapshot": pairing_stage.original_snapshot(pin["revision"], self.prior),
                 **{role + kind: source[role + kind] for role in ("core", "public")
                    for kind, source in (("VersionId", pin), ("DeploymentId", failed))}}
        self.stage["release"]["snapshot"] = pairing_stage.original_snapshot(self.archive.source, prior)

        def lineage(cmd, *args):
            if cmd == "merge-base" and args == (failed["verifier"], self.archive.source):
                return failed["verifier"]
            return self.git(cmd, *args)

        def recover():
            self.archive.seal()
            with patch.object(pairing_stage, "replacement_documents",
                              return_value=(prior, {"digest": self.stage_digest})):
                return pairing_stage.sealed_pair(self.archive.verifier, "34", self.archive.digest,
                                                 self.archive.get, lineage)

        self.assertEqual(recover(), (self.stage, prior))
        self.stage["release"]["snapshot"] = self.snapshot
        with self.assertRaises(ValueError):
            recover()
