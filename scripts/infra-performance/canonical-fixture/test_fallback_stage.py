import hashlib
import json
import unittest
from unittest.mock import patch

import qualified_release
import unsealed_stage as stage
from staged_application import APPLICATION
from test_unsealed_stage import archive, inventory


class VerifiedFallback(unittest.TestCase):
    def setUp(self):
        self.source, self.verifier = "a" * 40, "b" * 40
        self.staged = {"snapshot": {"revision": APPLICATION, "stableRevision": "d" * 40}, **stage.STAGED_IDS}
        self.controls = {"digest": "c"*64}
        self.stage = {"revision": APPLICATION, "stableRevision": "d" * 40, "controlsDigest": self.controls["digest"],
                      "release": self.staged}
        self.docs = {"native-fallback-stage.json": self.stage}
        repo = {"full_name": qualified_release.REPO}
        self.run = {"id": 12, "repository": repo, "head_repository": repo,
                    "path": ".github/workflows/native-storage-release.yml", "head_branch": "trunk",
                    "head_sha": self.source, "event": "workflow_dispatch", "run_attempt": 1, "conclusion": "success"}
        self.meta = {"id": 34, "workflow_run": {"id": 12, "head_sha": self.source},
                     "expired": False, "name": "native-fixture-fallback-12"}
        self.jobs = inventory(stage.RESEAL_STEPS, "success")
        self.seal()
        self.source_lineage = self.source
        self.changed = "infra/cloudflare/production-release.ts\0"

    def seal(self):
        self.data = archive(self.docs)
        self.digest = hashlib.sha256(self.data).hexdigest()
        self.meta.update(size_in_bytes=len(self.data), digest="sha256:" + self.digest)

    def get(self, path):
        if path == "artifacts/34/zip":
            return self.data
        return json.dumps({"runs/12": self.run, "artifacts/34": self.meta,
                           "runs/12/attempts/1/jobs?per_page=100": self.jobs}[path]).encode()

    def git(self, command, *args):
        if command == "merge-base":
            return APPLICATION if args[0] == APPLICATION else self.source_lineage
        return self.verifier if command == "rev-parse" else self.changed

    def recover(self):
        with patch.object(stage, "staged_documents", return_value=(self.staged, self.controls)):
            return stage.resealed_document(self.verifier, "34", self.digest, self.get, self.git)

    def test_only_the_authenticated_successful_reseal_of_the_exact_pair_is_eligible(self):
        self.assertEqual(self.recover(), self.stage)
        for field, value in (("revision", self.source), ("stableRevision", self.source), ("controlsDigest", "e"*64), ("release", {})):
            with self.subTest(field=field), patch.dict(self.stage, {field: value}), self.assertRaises(ValueError):
                self.seal()
                self.recover()
        self.seal()
        for item in self.jobs["jobs"][0]["steps"]:
            with self.subTest(step=item["name"]), patch.dict(item, conclusion="cancelled"), self.assertRaises(ValueError):
                self.recover()
        for record, changed in ((self.run, {"run_attempt": 2}), (self.run, {"conclusion": "failure"}),
                (self.run, {"head_branch": "scratch"}), (self.meta, {"name": "native-storage-release-12"}),
                (self.meta, {"expired": True}), (self.jobs, {"total_count": 2})):
            with self.subTest(changed=changed), patch.dict(record, changed), self.assertRaises(ValueError):
                self.recover()
        self.data += b"extra"
        with self.assertRaises(ValueError):
            self.recover()

    def test_reseal_run_on_another_lineage_or_modified_worker_cannot_forward(self):
        self.source_lineage = "0" * 40
        with self.assertRaises(ValueError):
            self.recover()
        self.source_lineage = self.source
        self.changed = "apps/server/package.json\0"
        with self.assertRaises(ValueError):
            self.recover()

    def test_qualification_requires_an_independent_active_rollout_and_exact_source(self):
        steps = {
            "Bind the protected verifier to the staged application source": "success",
            stage.UPLOAD: "success", stage.STAGE: "success", stage.QUALIFY: "skipped", stage.FORWARD: "skipped",
            stage.NORMAL_PROMOTION: "success", "Verify the installed application and retained schema markers": "success",
            "Exercise the tested code-only rollback": "skipped", "Retain native release evidence": "success",
        }
        self.jobs = inventory(steps, "success")
        self.meta["name"] = "native-storage-release-12"
        snapshot = {"revision": APPLICATION, "stableRevision": APPLICATION,
                    "public": {"stableVersionId": stage.STAGED_IDS["publicVersionId"]},
                    "core": {"stableVersionId": stage.STAGED_IDS["coreVersionId"]}}
        release = {"snapshot": snapshot, "publicVersionId": "new-public", "coreVersionId": "new-core"}
        self.docs = {"native-release.json.promoted": {"rollbackTested": True, "release": release},
                     "native-verification.json": {"revision": APPLICATION, "verifierRevision": self.source}}
        self.seal()
        def collect(revision=APPLICATION):
            return qualified_release.artifact(revision, "34", self.digest, self.get, self.git)
        self.assertEqual(collect(), tuple(self.docs.values()))
        with patch.dict(self.docs["native-verification.json"], verifierRevision=self.verifier):
            self.seal()
            with self.assertRaises(ValueError):
                collect()
        self.seal()
        with self.assertRaises(ValueError):
            collect(self.verifier)
        for item in self.jobs["jobs"][0]["steps"]:
            with self.subTest(step=item["name"]), patch.dict(item, conclusion="failure"), self.assertRaises(ValueError):
                collect()
        for record, changed in ((snapshot, {"revision": self.verifier}), (snapshot, {"stableRevision": self.verifier}),
                                (snapshot["core"], {"stableVersionId": "foreign"}),
                                (release, {"publicVersionId": stage.STAGED_IDS["publicVersionId"]})):
            with self.subTest(changed=changed), patch.dict(record, changed), self.assertRaises(ValueError):
                self.seal()
                collect()
        self.seal()
        self.changed = "bun.lock\0"
        with self.assertRaises(ValueError):
            collect()
