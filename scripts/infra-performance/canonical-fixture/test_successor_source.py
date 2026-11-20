import hashlib
import json
import unittest
from io import BytesIO
from zipfile import ZipFile
from copy import deepcopy

from successor_source import (ORIGINAL_REVISION, PLAN_STEPS, approved_plan, live_return_bindings,
                              verify_live_predecessor, verify_prior_custody)


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


    def test_old_return_pair_still_exists_with_the_same_closed_bindings(self):
        roles = ("core", "public")
        release = {"snapshot":{role:{"name":"fidy-native-"+role, "stableVersionId":role+"-dormant"} for role in roles},
                   **{role+"VersionId":role+"-active" for role in roles}}
        bindings = [{"name":key, "type":"plain_text", "text":value} for key,value in
                    (("RELEASE_GIT_SHA", ORIGINAL_REVISION), ("NATIVE_STORAGE_ADMISSION", "closed"),
                     ("RECOVERY_ISOLATION", "isolated"), ("SMOKE_QUEUE_NAME", "retained-old-smoke"))]
        versions = {role+"-"+phase:{"id":role+"-"+phase, "resources":{"bindings":deepcopy(bindings)}}
                    for role in roles for phase in ("active", "dormant")}
        def read(path):
            return versions[path.split("/")[-1]]
        self.assertEqual(live_return_bindings(read, "a"*32, {"release":release})["SMOKE_QUEUE_NAME"], bindings[-1])
        for target, change in (("core-dormant", {"id":"other"}),
                               ("public-dormant", {"resources":{"bindings":[*bindings[:-1], {**bindings[-1], "text":"new-smoke"}]}})):
            original = versions[target]
            versions[target] = {**original, **change}
            try:
                with self.subTest(target=target), self.assertRaisesRegex(ValueError, "dormant rollback"):
                    live_return_bindings(read, "a"*32, {"release":release})
            finally:
                versions[target] = original


    def test_only_the_exact_successful_read_only_plan_authorizes_stage(self):
        revision, run, artifact = "a"*40, "123", "456"
        document = {"revision":revision, "applied":False, "member":"performance-2"}
        steps = [dict(name=name, conclusion=conclusion) for name,conclusion in PLAN_STEPS.items()]
        def check(*, content=document, branch="trunk", recorded_revision=revision, verified=True):
            artifact_zip = BytesIO()
            with ZipFile(artifact_zip, "w") as archive:
                archive.writestr("native-fixture-successor-plan.json", json.dumps(content))
            archive_bytes = artifact_zip.getvalue()
            digest = hashlib.sha256(archive_bytes).hexdigest()
            repository = {"full_name":"B4rz99/fidy-ai"}
            jobs = deepcopy(steps)
            if not verified:
                for step in jobs:
                    if step["name"] == "Upload the approved successor resources":
                        step["conclusion"] = "success"
            records = {
                "artifacts/"+artifact: dict(id=int(artifact), workflow_run=dict(id=int(run),head_sha=recorded_revision),
                                           name="native-fixture-successor-plan-"+run, expired=False,
                                           size_in_bytes=len(archive_bytes), digest="sha256:"+digest),
                "runs/"+run: dict(id=int(run), repository=repository, head_repository=repository,
                                  path=".github/workflows/native-fixture-successor-plan.yml",
                                  head_branch=branch, head_sha=recorded_revision, event="workflow_dispatch",
                                  conclusion="success", run_attempt=1),
                f"runs/{run}/attempts/1/jobs?per_page=100": dict(total_count=1, jobs=[
                    dict(name="plan", conclusion="success", steps=jobs)
                ]),
            }
            def read(path):
                return archive_bytes if path == "artifacts/"+artifact+"/zip" else json.dumps(records[path])
            return approved_plan(revision, artifact, digest, read)

        self.assertEqual(check(), document)
        for change in ({"branch":"feature"}, {"recorded_revision":"b"*40}, {"verified":False},
                       {"content":{**document, "applied":True}}, {"content":{**document, "member":"performance-1"}},
                       {"content":{**document, "revision":"b"*40}}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                check(**change)
