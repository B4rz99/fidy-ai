from copy import deepcopy
from io import BytesIO
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

import interrupted_upload
import unsealed_stage as stage
from staged_application import APPLICATION, verify_tree


def inventory(steps, conclusion):
    return {"total_count": 1, "jobs": [{"name": "release", "conclusion": conclusion,
            "steps": [{"name": name, "conclusion": result} for name, result in steps.items()]}]}


def archive(documents):
    data = BytesIO()
    with ZipFile(data, "w") as zipfile:
        for name, value in documents.items():
            zipfile.writestr(name, json.dumps(value))
    return data.getvalue()


class UnsealedStage(unittest.TestCase):
    def setUp(self):
        self.verifier = "c" * 40
        self.changed = ".github/workflows/native-storage-release.yml\0"
        self.ancestor = APPLICATION
        self.env = {"GITHUB_ACTIONS": "true", "GITHUB_SHA": self.verifier, "GITHUB_REPOSITORY": stage.REPO,
                    "GITHUB_WORKFLOW_REF": stage.REPO + "/.github/workflows/native-storage-release.yml@refs/heads/trunk",
                    "GITHUB_REF": "refs/heads/trunk", "GITHUB_REF_PROTECTED": "true",
                    "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_RUN_ATTEMPT": "1",
                    "NATIVE_STORAGE_HOSTS": "acceptance", "NATIVE_STORAGE_ADMISSION": "closed",
                    "FIXTURE_RELEASE_OPERATION": "reseal-fixture-fallback", "NATIVE_FIXTURE_BUILD": "fallback",
                    "NATIVE_FIXTURE_SIGNER_SHA256": stage.fixture_upload()["fingerprint"]}
        self.original = {"revision": interrupted_upload.REVISION, "stableRevision": "d" * 40, "core": {"stableVersionId": "original"}}
        self.controls = {"digest": interrupted_upload.CONTROLS_DIGEST}
        self.staged = {"snapshot": {**self.original, "revision": APPLICATION}, **stage.STAGED_IDS}
        self.docs = {"native-release.json": deepcopy(self.staged), "native-release.json.controls": self.controls,
                     "native-release.json.source": deepcopy(self.original), "native-release.json.source.controls": self.controls}
        self.jobs = inventory(stage.STAGING_STEPS, "failure")

    def git(self, command, *args):
        return {"rev-parse": self.verifier, "merge-base": self.ancestor, "diff": self.changed}[command]

    def read_stage(self):
        def receipt(revision, artifact, digest, *, prefix, conclusions, get):
            self.assertEqual((revision, artifact, digest, prefix, conclusions),
                             (APPLICATION, stage.ARTIFACT, stage.ARCHIVE_DIGEST, "native-storage-release-", {"failure"}))
            return stage.RUN, archive(self.docs)
        with patch.object(stage, "protected_archive", receipt), patch.object(stage, "source_documents",
                     return_value=(self.original, self.controls)):
            return stage.staged_documents(lambda _: json.dumps(self.jobs))

    def test_both_original_controls_and_every_staged_version_are_bound(self):
        self.assertEqual(self.read_stage(), (self.staged, self.controls))
        for member, replacement in (("native-release.json.source", {"revision": APPLICATION}),
                ("native-release.json.source.controls", {}), ("native-release.json.controls", {}),
                ("native-release.json", {**self.staged, "coreVersionId": "replacement"}),
                ("native-release.json", {**self.staged, "snapshot": self.original}),
                ("native-fallback-stage.json", {})):
            with self.subTest(member=member), patch.dict(self.docs, {member: replacement}), self.assertRaises(ValueError):
                self.read_stage()

    def test_unsealed_source_requires_prior_staging_and_failed_qualification(self):
        for item in self.jobs["jobs"][0]["steps"]:
            with self.subTest(step=item["name"]), patch.dict(item, conclusion="cancelled"), self.assertRaises(ValueError):
                self.read_stage()
        self.jobs["total_count"] = 3
        with self.assertRaises(ValueError):
            self.read_stage()

    def test_app_source_is_bound_only_for_the_exact_closed_signed_operations(self):
        for operation, build in (("rollout", "ordinary"), ("verify", "ordinary"), ("reseal-fixture-fallback", "fallback"),
                                 ("recover-fixture-fallback", "fallback"), ("diagnose-fixture-pairing", "fallback")):
            stage.verify_dispatch({**self.env, "FIXTURE_RELEASE_OPERATION": operation, "NATIVE_FIXTURE_BUILD": build}, self.git)
        for field, value in (("GITHUB_WORKFLOW_REF", "unrelated.yml"), ("GITHUB_RUN_ATTEMPT", "2"), ("NATIVE_FIXTURE_BUILD", "ordinary"), ("GITHUB_SHA", "f"*40),
                ("GITHUB_REF_PROTECTED", "false"), ("GITHUB_REF", "refs/heads/scratch"), ("NATIVE_STORAGE_HOSTS", "canonical"),
                ("GITHUB_EVENT_NAME", "pull_request"), ("NATIVE_STORAGE_ADMISSION", "open"), ("NATIVE_FIXTURE_SIGNER_SHA256", "0"*64),
                ("GITHUB_REPOSITORY", "a/fork"), ("FIXTURE_RELEASE_OPERATION", "resume-fixture-upload")):
            with self.subTest(field=field), self.assertRaises(ValueError):
                stage.verify_dispatch({**self.env, field: value}, self.git)
        for changed in ("apps/server/cloudflare/index.ts", "apps/web/package.json", "bun.lock",
                        "infra/cloudflare/native-fixture-upload.json", "unexpected\nfile"):
            self.changed = changed + "\0"
            with self.subTest(file=changed), self.assertRaises(ValueError):
                verify_tree(self.verifier, self.git)
        self.changed = ""
        self.ancestor = self.verifier
        with self.assertRaises(ValueError):
            verify_tree(self.verifier, self.git)

    def test_archives_are_verified_before_the_runner_publishes_the_source_pair(self):
        with tempfile.TemporaryDirectory() as temp:
            envfile = Path(temp) / "env"
            with patch.dict(os.environ, {**self.env, "GITHUB_ENV": str(envfile)}), patch("sys.argv", ["stage", "source"]), \
                    patch.object(stage, "verify_dispatch"), patch.object(stage, "staged_documents", side_effect=ValueError):
                with self.assertRaises(ValueError):
                    stage.main()
                self.assertFalse(envfile.exists())
            with patch.dict(os.environ, {**self.env, "GITHUB_ENV": str(envfile)}), patch("sys.argv", ["stage", "source"]), \
                    patch.object(stage, "verify_dispatch"), patch.object(stage, "staged_documents"):
                stage.main()
            self.assertEqual(envfile.read_text().splitlines(),
                             ["RELEASE_GIT_SHA=" + APPLICATION, "FIXTURE_STAGED_VERIFIER_SHA=" + self.verifier])
