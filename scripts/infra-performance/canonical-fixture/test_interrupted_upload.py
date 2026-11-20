from io import BytesIO
import json
import unittest
from unittest.mock import patch
from zipfile import ZipFile

from interrupted_upload import ARCHIVE_DIGEST, ARTIFACT, CONTROLS_DIGEST, REPAIR_REVISION, REVISION, RUN, STEPS, source_documents, verify_dispatch
from qualified_release import REPO


class InterruptedUpload(unittest.TestCase):
    def setUp(self):
        self.repair = "a" * 40
        self.env = dict(GITHUB_REPOSITORY=REPO, GITHUB_REF="refs/heads/trunk", GITHUB_REF_PROTECTED="true",
                        GITHUB_EVENT_NAME="workflow_dispatch", GITHUB_RUN_ATTEMPT="1", GITHUB_SHA=self.repair,
                        FIXTURE_RELEASE_OPERATION="resume-fixture-upload", NATIVE_FIXTURE_BUILD="fallback",
                        NATIVE_STORAGE_ADMISSION="closed", NATIVE_STORAGE_HOSTS="acceptance", NATIVE_FIXTURE_SIGNER_SHA256="b"*64)
        self.release = {"name": "release", "conclusion": "failure",
                        "steps": [{"name": name, "conclusion": result} for name, result in STEPS.items()]}
        self.jobs = {"total_count": 1, "jobs": [self.release]}
        self.snapshot = {"revision": REVISION}
        self.controls = {"digest": CONTROLS_DIGEST}

    def load(self, run=RUN):
        archive = BytesIO()
        with ZipFile(archive, "w") as file:
            file.writestr("native-release.json", json.dumps(self.snapshot))
            file.writestr("native-release.json.controls", json.dumps(self.controls))
        def get(path):
            self.assertEqual(path, f"runs/{RUN}/attempts/1/jobs?per_page=100")
            return json.dumps(self.jobs)
        with patch("interrupted_upload.protected_archive", return_value=(run, archive.getvalue())) as authenticate:
            result = source_documents(get)
            authenticate.assert_called_once_with(REVISION, ARTIFACT, ARCHIVE_DIGEST, prefix="native-storage-release-",
                                                 conclusions={"failure"}, get=get)
            return result

    def test_pins_original_archive_stage_failure_and_controls(self):
        self.assertEqual(self.load(), (self.snapshot, self.controls))
        with self.assertRaises(ValueError):
            self.load("1234")
        for step in self.release["steps"]:
            with self.subTest(step=step["name"]), patch.dict(step, conclusion="cancelled"), self.assertRaises(ValueError):
                self.load()
        for document, changes in [(self.release, {"conclusion":"success"}), (self.jobs, {"total_count":2}),
                                  (self.snapshot, {"revision":self.repair}), (self.controls, {"digest":"0"*64})]:
            with patch.dict(document, changes), self.assertRaises(ValueError):
                self.load()

    def test_only_a_verifier_descendant_keeps_the_repair_sources(self):
        def git(*args):
            if args == ("rev-parse", "HEAD"):
                return self.repair
            if args == ("merge-base", REPAIR_REVISION, self.repair):
                return REPAIR_REVISION
            if args == ("diff", "--name-only", "--no-renames", "-z", REPAIR_REVISION, self.repair, "--"):
                return ".github/workflows/native-storage-release.yml\0infra/cloudflare/native-fixture-plan.ts\0"
            self.fail("Unexpected Git observation")

        for operation in ["plan-fixture-repair", "resume-fixture-upload"]:
            verify_dispatch({**self.env, "FIXTURE_RELEASE_OPERATION": operation}, git)
        for changed in ({"GITHUB_RUN_ATTEMPT":"2"}, {"GITHUB_SHA":REVISION}, {"GITHUB_REF_PROTECTED":"false"},
                        {"NATIVE_STORAGE_ADMISSION":"open"}, {"NATIVE_FIXTURE_BUILD":"ordinary"},
                        {"FIXTURE_RELEASE_OPERATION":"rollout"}, {"NATIVE_FIXTURE_SIGNER_SHA256":""}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                verify_dispatch({**self.env, **changed}, git)
        for command, output in (("rev-parse", "c"*40), ("merge-base", REVISION),
                                ("diff", "apps/web/vite.config.ts\0"), ("diff", "bun.lock\0"),
                                ("diff", "apps/server/cloudflare/fixture-fallback-ingress.ts\0")):
            with self.subTest(command=command, output=output), self.assertRaises(ValueError):
                verify_dispatch(self.env, lambda *args: output if args[0] == command else git(*args))
