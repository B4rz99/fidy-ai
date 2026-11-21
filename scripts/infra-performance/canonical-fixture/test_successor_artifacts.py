from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import UUID
from zipfile import ZipFile

from successor_artifacts import (
    ACCOUNTING_FINALIZE_FILE, ACCOUNTING_FINALIZE_PROOF, ACCOUNTING_FINALIZE_RUN, ACCOUNTING_FINALIZE_STEPS,
    ACCOUNTING_FINALIZE_VERIFIER, PROMOTE_STEP, RESTORE_STEP, accounting_finalize_receipt, artifacts,
    require_active_finalize, ACCOUNTING_FORWARD_PROOF, ACCOUNTING_FORWARD_RUN, ACCOUNTING_FORWARD_STEPS,
    ACCOUNTING_FORWARD_VERIFIER, ACTIVE_STEPS, RECOVERY_STEPS, RESUMED_STAGE_STEPS, RESUME_CAPTURE_STEP,
    STAGE_STEPS, WORKFLOW, accounting_forward_receipt, active_successor, continuation_steps, main,
    recovered_successor, require_active_forward, require_sealed_source, sealed_successor,
)
from successor_partial import (
    CORE_VERSION, INGRESS_VERSION, PLAN, PLAN_RUN, REVISION,
    SMOKE_DEPLOYMENT, SMOKE_VERSION,
)
from successor_source import ACTIVE_ARTIFACT, ORIGINAL_CLEANUP, ORIGINAL_REVISION
from qualified_release import REPO, retained_provider, fixture_upload


class SuccessorArtifactTests(unittest.TestCase):
    def test_successor_seal_requires_exact_approved_predecessor_and_fresh_assignments(self):
        rev = "a"*40
        version_ids = [str(UUID(int=i)) for i in range(1, 13)]
        labels = ("stableCoreVersion", "stableCoreDeployment", "stableIngressVersion",
                  "stableIngressDeployment", "oldSmokeVersionId", "oldSmokeDeploymentId")
        source = dict(revision=rev, previousRevision=ORIGINAL_REVISION, previousRelease=ACTIVE_ARTIFACT,
                      previousCleanup=ORIGINAL_CLEANUP[2], signerSha256=fixture_upload()["fingerprint"],
                      namespaces=[f"{i:032x}" for i in range(1, 6)],
                      **dict(zip(labels, version_ids)))
        plan = dict(**source, member="performance-2", applied=False, resources=[])
        snapshot = dict(revision=rev, stableRevision=ORIGINAL_REVISION,
                        core=dict(name="fidy-native-storage-core", stableVersionId=version_ids[0], deploymentId=version_ids[1]),
                        public=dict(name="fidy-native-storage-ingress", stableVersionId=version_ids[2], deploymentId=version_ids[3]))
        stage = dict(revision=rev, stableRevision=ORIGINAL_REVISION, fixtureMember="performance-2", predecessor=source,
                     provider=retained_provider(), controlsDigest=fixture_upload()["controlsDigest"],
                     smoke=dict(versionId=version_ids[10], deploymentId=version_ids[11]),
                     namespaces=dict(zip(("user", "directory", "pricing", "maintenance", "erasure"), source["namespaces"])),
                     release=dict(snapshot=snapshot, **dict(zip(
                         ("coreVersionId", "coreDeploymentId", "publicVersionId", "publicDeploymentId"),
                         version_ids[6:10]))))
        require_sealed_source(rev, stage, plan)
        for edit in (
            lambda value: value.update(fixtureMember="performance-1"),
            lambda value: value.update(revision="b"*40),
            lambda value: value.update(controlsDigest="d"*64),
            lambda value: value["smoke"].update(versionId=source["oldSmokeVersionId"]),
            lambda value: value["release"]["snapshot"]["public"].update(deploymentId=version_ids[7]),
            lambda value: value["namespaces"].update(directory="b"*32),
            lambda value: value["release"].update(coreVersionId=source["stableCoreVersion"]),
        ):
            changed = deepcopy(stage)
            edit(changed)
            with self.assertRaises(ValueError):
                require_sealed_source(rev, changed, plan)


SUPPORT = "1" * 40
STAGE = "2" * 40
RECOVERY = "3" * 40
ROLLOUT = "4" * 40
CHECKOUT = "5" * 40
LINEAGE = (REVISION, SUPPORT, STAGE, RECOVERY, ROLLOUT, CHECKOUT)
STAGE_FILE = "native-fixture-successor-stage.json"
RECOVERY_FILE = "native-fixture-successor-recovered.json"


def git_lineage(operation, *revisions):
    if operation == "rev-parse" and revisions == ("HEAD",):
        return CHECKOUT
    if operation == "merge-base" and all(revision in LINEAGE for revision in revisions):
        return min(revisions, key=LINEAGE.index)
    return "f" * 40


class ArchiveEvidence:
    def __init__(self):
        self.documents = {}

    def add(self, artifact_id, producer, prefix, files, steps, *, run_id=None, conclusion="success"):
        run_id = run_id or str(int(artifact_id) + 100)
        stream = BytesIO()
        with ZipFile(stream, "w") as archive:
            for name, contents in files.items():
                archive.writestr(name, json.dumps(contents))
        body = stream.getvalue()
        digest = sha256(body).hexdigest()
        self.documents["artifacts/" + artifact_id] = json.dumps({
            "id": int(artifact_id), "expired": False, "name": prefix + run_id,
            "workflow_run": {"id": int(run_id), "head_sha": producer},
            "digest": "sha256:" + digest, "size_in_bytes": len(body),
        }).encode()
        self.documents["runs/" + run_id] = json.dumps({
            "id": int(run_id), "repository": {"full_name": REPO},
            "head_repository": {"full_name": REPO}, "path": ".github/workflows/" + WORKFLOW,
            "head_branch": "trunk", "head_sha": producer, "event": "workflow_dispatch",
            "conclusion": conclusion, "run_attempt": 1,
        }).encode()
        self.documents[f"runs/{run_id}/attempts/1/jobs?per_page=100"] = json.dumps({
            "total_count": 1, "jobs": [{"name": "plan", "conclusion": conclusion, "steps": [
                {"name": name, "conclusion": conclusion} for name, conclusion in steps.items()
            ]}],
        }).encode()
        self.documents["artifacts/" + artifact_id + "/zip"] = body
        return {"artifactId": artifact_id, "sha256": digest}

    def get(self, path):
        return self.documents[path]



class AccountingForwardArchiveTests(unittest.TestCase):
    def test_receipt_requires_the_exact_protected_failure_and_unchanged_stage(self):
        evidence = ArchiveEvidence()
        stage = {"publicDeploymentId": "original", "coreDeploymentId": "staged", "snapshot": {}}

        def lineage(operation, *revisions):
            self.assertEqual((operation, revisions), ("merge-base", (ACCOUNTING_FORWARD_VERIFIER, CHECKOUT)))
            return ACCOUNTING_FORWARD_VERIFIER

        def check(files, steps=ACCOUNTING_FORWARD_STEPS, run_id=ACCOUNTING_FORWARD_RUN):
            ref = evidence.add(ACCOUNTING_FORWARD_PROOF["artifactId"], ACCOUNTING_FORWARD_VERIFIER,
                               "native-fixture-successor-rollout-diagnostics-", files, steps,
                               run_id=run_id, conclusion="failure")
            proof = {**ACCOUNTING_FORWARD_PROOF, **ref}
            with patch("successor_artifacts.ACCOUNTING_FORWARD_PROOF", proof):
                return accounting_forward_receipt(stage, CHECKOUT, evidence.get, lineage)

        files = {"native-release.json": stage}
        self.assertEqual(check(files)["coreDeploymentId"], ACCOUNTING_FORWARD_PROOF["coreDeploymentId"])
        with self.assertRaisesRegex(ValueError, "Unexpected accounting partial rollout"):
            check(files, run_id="66")
        with self.assertRaisesRegex(ValueError, "did not stop at promotion"):
            check(files, {**ACCOUNTING_FORWARD_STEPS, "Upload the reviewed active successor pair": "success"})
        with self.assertRaisesRegex(ValueError, "differs from its exact stage"):
            check({"native-release.json": {**stage, "coreDeploymentId": "changed"}})
        with self.assertRaises(ValueError):
            check({**files, "native-release.json.promoted": {}})

    def test_active_forward_requires_proof_only_when_preserving_exact_partial_core(self):
        promotion = {"release": {"publicDeploymentId": "original", "snapshot": {"public": {"deploymentId": "stable"}}},
                     "promoted": {"coreDeploymentId": ACCOUNTING_FORWARD_PROOF["coreDeploymentId"],
                                  "publicDeploymentId": str(UUID(int=99))}}
        with self.assertRaisesRegex(ValueError, "lacks the authenticated partial"):
            require_active_forward(promotion, None, CHECKOUT, None, None)
        with patch("successor_artifacts.accounting_forward_receipt", return_value=ACCOUNTING_FORWARD_PROOF) as receipt:
            require_active_forward(promotion, ACCOUNTING_FORWARD_PROOF, CHECKOUT, None, None)
            receipt.assert_called_once_with(promotion["release"], CHECKOUT, None, None)
        promotion["promoted"]["coreDeploymentId"] = "different"
        require_active_forward(promotion, None, CHECKOUT, None, None)
        with self.assertRaisesRegex(ValueError, "Unexpected accounting partial"):
            require_active_forward(promotion, ACCOUNTING_FORWARD_PROOF, CHECKOUT, None, None)



class AccountingFinalizeArchiveTests(unittest.TestCase):
    def setUp(self):
        self.evidence = ArchiveEvidence()
        self.stage = {"coreDeploymentId": "staged", "publicDeploymentId": "staged", "snapshot": {}}
        self.promotion = {"release": self.stage, "rollbackTested": True,
                          "promoted": {key: ACCOUNTING_FINALIZE_PROOF[key]
                                       for key in ("coreDeploymentId", "publicDeploymentId")}}

    def check_receipt(self, promotion, steps=ACCOUNTING_FINALIZE_STEPS):
        ref = self.evidence.add(ACCOUNTING_FINALIZE_PROOF["artifactId"], ACCOUNTING_FINALIZE_VERIFIER,
                                "native-fixture-successor-rollout-diagnostics-",
                                {"native-release.json": self.stage, "native-release.json.promoted": promotion},
                                steps, run_id=ACCOUNTING_FINALIZE_RUN, conclusion="failure")
        proof = {**ACCOUNTING_FINALIZE_PROOF, **ref}
        with patch("successor_artifacts.ACCOUNTING_FINALIZE_PROOF", proof):
            return accounting_finalize_receipt(self.stage, CHECKOUT, self.evidence.get,
                                               lambda *_args: ACCOUNTING_FINALIZE_VERIFIER)

    def test_exact_failure_after_promotion_is_required(self):
        promotion, proof = self.check_receipt(self.promotion)
        self.assertEqual(promotion, self.promotion)
        self.assertEqual(proof["publicDeploymentId"], self.promotion["promoted"]["publicDeploymentId"])
        with self.assertRaisesRegex(ValueError, "did not fail after forward promotion"):
            self.check_receipt(promotion, {**ACCOUNTING_FINALIZE_STEPS, RESTORE_STEP: "success"})
        with self.assertRaisesRegex(ValueError, "differs from the verified live pair"):
            self.check_receipt({**promotion, "promoted": {**promotion["promoted"], "publicDeploymentId": "other"}})
        with self.assertRaisesRegex(ValueError, "differs from the verified live pair"):
            self.check_receipt({**promotion, "rollbackTested": False})

    def test_finalized_pair_reauthenticates_exact_promotion(self):
        with self.assertRaisesRegex(ValueError, "lacks its exact finalization receipt"):
            require_active_finalize(self.promotion, None, CHECKOUT, None, None)
        with patch("successor_artifacts.accounting_finalize_receipt",
                   return_value=(self.promotion, ACCOUNTING_FINALIZE_PROOF)) as receipt:
            require_active_finalize(self.promotion, ACCOUNTING_FINALIZE_PROOF, CHECKOUT, None, None)
            receipt.assert_called_once_with(self.stage, CHECKOUT, None, None)
        with self.assertRaisesRegex(ValueError, "different pair"):
            require_active_finalize({"promoted": {}}, ACCOUNTING_FINALIZE_PROOF, CHECKOUT, None, None)

    def test_finalize_file_requires_skipped_promotion_step(self):
        promotion = "native-release.json.promoted"
        files = {promotion: self.promotion, ACCOUNTING_FINALIZE_FILE: ACCOUNTING_FINALIZE_PROOF}
        prefix = "native-fixture-successor-active-"
        options = {"optional": (ACCOUNTING_FINALIZE_FILE,),
                   "steps_for_file": {ACCOUNTING_FINALIZE_FILE: {PROMOTE_STEP: "skipped"}}}
        ref = self.evidence.add("707", ROLLOUT, prefix, files, {**ACTIVE_STEPS, PROMOTE_STEP: "skipped"})
        self.assertEqual(artifacts(ROLLOUT, ref, prefix, ACTIVE_STEPS, [promotion], self.evidence.get, **options), files)
        ref = self.evidence.add("707", ROLLOUT, prefix, files, ACTIVE_STEPS)
        with self.assertRaisesRegex(ValueError, "step outcomes differ"):
            artifacts(ROLLOUT, ref, prefix, ACTIVE_STEPS, [promotion], self.evidence.get, **options)


def resumed_stage():
    ids = [str(UUID(int=i)) for i in range(1, 9)]
    source = dict(
        revision=REVISION, previousRevision=ORIGINAL_REVISION,
        previousRelease=ACTIVE_ARTIFACT, previousCleanup=ORIGINAL_CLEANUP[2],
        signerSha256=fixture_upload()["fingerprint"],
        namespaces=[f"{i:032x}" for i in range(1, 6)],
        stableCoreVersion=ids[0], stableCoreDeployment=ids[1],
        stableIngressVersion=ids[2], stableIngressDeployment=ids[3],
        oldSmokeVersionId=ids[4], oldSmokeDeploymentId=ids[5],
    )
    snapshot = dict(
        revision=REVISION, stableRevision=ORIGINAL_REVISION, stableContractDigest="a" * 64,
        core=dict(name="fidy-native-storage-core", stableVersionId=ids[0], deploymentId=ids[1]),
        public=dict(name="fidy-native-storage-ingress", stableVersionId=ids[2], deploymentId=ids[3]),
    )
    stage = dict(
        revision=REVISION, stableRevision=ORIGINAL_REVISION, fixtureMember="performance-2",
        predecessor=source, provider=retained_provider(), controlsDigest=fixture_upload()["controlsDigest"],
        smoke=dict(versionId=SMOKE_VERSION, deploymentId=SMOKE_DEPLOYMENT),
        namespaces=dict(zip(("user", "directory", "pricing", "maintenance", "erasure"), source["namespaces"])),
        approval=dict(zip(("artifactId", "sha256"), PLAN)),
        release=dict(snapshot=snapshot, coreVersionId=CORE_VERSION, publicVersionId=INGRESS_VERSION,
                     coreDeploymentId=ids[6], publicDeploymentId=ids[7]),
        resume=dict(verifierRevision=STAGE, supportVerifierRevision=SUPPORT, supportArtifact="51",
                    supportSha256="f" * 64, coreVersionId=CORE_VERSION, publicVersionId=INGRESS_VERSION),
    )
    changes = [
        ("Core", "Cloudflare.Worker", "update"), ("Ingress", "Cloudflare.Worker", "update"),
        ("ReleaseSmoke-" + REVISION, "Cloudflare.Worker", "create"),
        ("ReleaseSmokeQueue-" + REVISION, "Cloudflare.Queues.Queue", "create"),
        ("ReleaseSmokeWorkflowV2-" + REVISION, "Cloudflare.Workflow", "create"),
        ("ReleaseSmokeConsumer-" + REVISION, "Cloudflare.Queues.Consumer", "create"),
    ]
    plan = dict(source, member="performance-2", applied=False,
                resources=[dict(logicalId=logical_id, resourceType=kind, action=action)
                           for logical_id, kind, action in changes])
    return stage, plan


class ResumedSuccessorArchiveTests(unittest.TestCase):
    def setUp(self):
        self.stage, self.plan = resumed_stage()
        self.archive = ArchiveEvidence()
        self.approved = dict(verifierRevision=SUPPORT, candidateRevision=REVISION,
                             stateProof="c" * 64, instanceProof="d" * 64)
        self.support = dict(self.approved, workflowId=str(UUID(int=70)))
        for patcher in (
            patch("successor_artifacts.approved_plan", return_value=self.plan),
            patch("successor_artifacts.archived_partial", return_value=deepcopy(self.stage["release"]["snapshot"])),
            patch("successor_resume.workflow_receipt", side_effect=lambda *_args, **_kwargs: (self.support, self.approved)),
        ):
            value = patcher.start()
            self.addCleanup(patcher.stop)
            self.__dict__[patcher.attribute + "_mock"] = value

    def stage_archive(self, stage=None, producer=STAGE, steps=RESUMED_STAGE_STEPS):
        return self.archive.add("101", producer, "native-fixture-successor-stage-",
                                {STAGE_FILE: self.stage if stage is None else stage}, steps)

    def recovery_archive(self, seal, stage=None, producer=RECOVERY):
        receipt = dict(seal=seal, stage=self.stage if stage is None else stage,
                       promoted=dict(coreDeploymentId=str(UUID(int=31)), publicDeploymentId=str(UUID(int=32))))
        ref = self.archive.add("102", producer, "native-fixture-successor-recovered-",
                               {RECOVERY_FILE: receipt}, continuation_steps(True, RECOVERY_STEPS))
        return ref, receipt

    def active_archive(self, seal, recovery, recovered):
        release = deepcopy(self.stage["release"])
        snapshot = release["snapshot"]
        snapshot["stableRevision"] = REVISION
        for role, value, ordinal in (("core", CORE_VERSION, 41), ("public", INGRESS_VERSION, 42)):
            snapshot[role].update(deploymentId=recovered["promoted"][role + "DeploymentId"], stableVersionId=value)
            release[role + "VersionId"] = str(UUID(int=ordinal))
        promotion = dict(rollbackTested=True, release=release)
        installed = dict(revision=REVISION, verifierRevision=ROLLOUT, admission="closed",
                         fixtureMember="performance-2", resourceRevision=REVISION,
                         retainedProvider=self.stage["provider"], fixtureControlsDigest=self.stage["controlsDigest"],
                         namespaces=self.stage["predecessor"]["namespaces"], userNamespace=self.stage["namespaces"]["user"],
                         workers=[dict(role="Smoke", **self.stage["smoke"])],
                         coreVersionId=release["coreVersionId"], publicVersionId=release["publicVersionId"])
        files = {"native-release.json.promoted": promotion, "native-verification.json": installed,
                 "fixture-successor-seal-reference.json": seal, "fixture-successor-recovery-reference.json": recovery}
        steps = continuation_steps(True, ACTIVE_STEPS)
        ref = self.archive.add("103", ROLLOUT, "native-fixture-successor-active-", files, steps)
        return ref, files, steps

    def test_exact_same_source_archive_still_authenticates_without_resume(self):
        stage = dict(self.stage)
        stage.pop("resume")
        seal = self.stage_archive(stage=stage, producer=REVISION, steps=STAGE_STEPS)
        self.assertEqual(sealed_successor(REVISION, seal, self.archive.get, verifier=REVISION, git=git_lineage), stage)
        self.workflow_receipt_mock.assert_not_called()
        self.approved_plan_mock.assert_called_once_with(REVISION, *PLAN, self.archive.get)

    def test_hosted_admission_qualifies_historical_candidate_and_current_lineage(self):
        seal = self.stage_archive()
        recovery, recovered = self.recovery_archive(seal)
        ref, files, steps = self.active_archive(seal, recovery, recovered)
        self.assertEqual(
            active_successor(REVISION, ref, self.archive.get, git=git_lineage),
            (files["native-release.json.promoted"], files["native-verification.json"]),
        )
        self.workflow_receipt_mock.assert_called_once_with(
            STAGE, "51", "f" * 64, get=self.archive.get, git=git_lineage)
        self.approved_plan_mock.assert_called_once_with(REVISION, *PLAN, self.archive.get, expected_run=PLAN_RUN)
        files["native-verification.json"]["verifierRevision"] = REVISION
        ref = self.archive.add("103", ROLLOUT, "native-fixture-successor-active-", files, steps)
        with self.assertRaisesRegex(ValueError, "tested dormant installation"):
            active_successor(REVISION, ref, self.archive.get, verifier=CHECKOUT, git=git_lineage)

    def test_accounting_app_keeps_verified_dormant_and_support_generation(self):
        seal = self.stage_archive()
        recovery, recovered = self.recovery_archive(seal)
        _, files, _ = self.active_archive(seal, recovery, recovered)
        promotion = files["native-release.json.promoted"]
        installed = files["native-verification.json"]
        promotion["release"]["snapshot"]["revision"] = ROLLOUT
        installed.update(revision=ROLLOUT, nativeAccountingWitness=True)
        ref = self.archive.add("104", ROLLOUT, "native-fixture-successor-active-", files, ACTIVE_STEPS)
        self.assertEqual(
            active_successor(ROLLOUT, ref, self.archive.get, verifier=CHECKOUT, git=git_lineage),
            (promotion, installed),
        )
        for changed in (
            {"resourceRevision": ROLLOUT},
            {"verifierRevision": REVISION},
            {"nativeAccountingWitness": False},
        ):
            forged = {**files, "native-verification.json": {**installed, **changed}}
            ref = self.archive.add("104", ROLLOUT, "native-fixture-successor-active-", forged, ACTIVE_STEPS)
            with self.assertRaises(ValueError):
                active_successor(ROLLOUT, ref, self.archive.get, verifier=CHECKOUT, git=git_lineage)

    def test_refuses_a_foreign_or_later_archive_in_the_chain(self):
        seal = self.stage_archive(producer="f" * 40)
        with self.assertRaisesRegex(ValueError, "outside the protected verifier lineage"):
            sealed_successor(REVISION, seal, self.archive.get, verifier=CHECKOUT, git=git_lineage)
        seal = self.stage_archive()
        recovery, _ = self.recovery_archive(seal, producer=SUPPORT)
        with self.assertRaisesRegex(ValueError, "outside the protected verifier lineage"):
            recovered_successor(REVISION, recovery, seal, self.archive.get, verifier=CHECKOUT, git=git_lineage)

    def test_refuses_incomplete_resume_steps_and_unexpected_stage_upload(self):
        for edit in (
            {RESUME_CAPTURE_STEP: "skipped"},
            {"Upload the approved successor resources": "success"},
            {"Retain successor staging coordinates": "skipped"},
        ):
            seal = self.stage_archive(steps={**RESUMED_STAGE_STEPS, **edit})
            with self.assertRaisesRegex(ValueError, "step outcomes differ"):
                sealed_successor(REVISION, seal, self.archive.get, verifier=CHECKOUT, git=git_lineage)

    def test_refuses_candidate_support_approval_and_capture_substitutions(self):
        for edit in (
            lambda stage: stage.pop("resume"),
            lambda stage: stage["resume"].update(verifierRevision=CHECKOUT),
            lambda stage: stage["resume"].update(supportVerifierRevision=CHECKOUT),
            lambda stage: stage["resume"].update(coreVersionId=str(UUID(int=77))),
            lambda stage: stage["release"].update(publicVersionId=str(UUID(int=77))),
            lambda stage: stage["smoke"].update(deploymentId=str(UUID(int=77))),
            lambda stage: stage["approval"].update(artifactId="200"),
            lambda stage: stage["release"]["snapshot"].update(stableContractDigest="b" * 64),
        ):
            stage = deepcopy(self.stage)
            edit(stage)
            seal = self.stage_archive(stage=stage)
            with self.assertRaises(ValueError):
                sealed_successor(REVISION, seal, self.archive.get, verifier=CHECKOUT, git=git_lineage)
        self.support["instanceProof"] = "b" * 64
        with self.assertRaisesRegex(ValueError, "approved Workflow state"):
            sealed_successor(REVISION, self.stage_archive(), self.archive.get, verifier=CHECKOUT, git=git_lineage)

    def test_refuses_recovery_that_dropped_resume_evidence(self):
        seal = self.stage_archive()
        truncated = dict(self.stage)
        truncated.pop("resume")
        recovery, _ = self.recovery_archive(seal, stage=truncated)
        with self.assertRaisesRegex(ValueError, "another successor seal"):
            recovered_successor(REVISION, recovery, seal, self.archive.get, verifier=CHECKOUT, git=git_lineage)

    def test_protected_resume_binds_explicit_mode_candidate_and_checkout(self):
        with tempfile.TemporaryDirectory() as folder:
            env = {
                "FIXTURE_RELEASE_OPERATION": "recover-fixture-successor", "FIXTURE_SUCCESSOR_RESUME": "true",
                "RELEASE_GIT_SHA": REVISION, "GITHUB_SHA": CHECKOUT, "GITHUB_ACTIONS": "true",
                "GITHUB_REF_PROTECTED": "true", "GITHUB_REF": "refs/heads/trunk",
                "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_WORKFLOW_REF": "B4rz99/fidy-ai/.github/workflows/native-fixture-successor-plan.yml@refs/heads/trunk",
                "GITHUB_RUN_ATTEMPT": "1", "NATIVE_STORAGE_ADMISSION": "closed",
                "NATIVE_STORAGE_HOSTS": "acceptance", "SUCCESSOR_SEAL_ARTIFACT": "101",
                "SUCCESSOR_SEAL_DIGEST": "f" * 64, "RUNNER_TEMP": folder,
            }
            for edit in ({"FIXTURE_SUCCESSOR_RESUME": "false"}, {"RELEASE_GIT_SHA": CHECKOUT}, {"RELEASE_GIT_SHA": STAGE}):
                with patch.dict("os.environ", {**env, **edit}, clear=True), self.assertRaises(ValueError):
                    main()
            with patch.dict("os.environ", env, clear=True):
                with patch("successor_artifacts.git_read", return_value=STAGE), self.assertRaisesRegex(ValueError, "current checkout"):
                    main()
                with patch("successor_artifacts.git_read", return_value=CHECKOUT):
                    with patch("successor_artifacts.sealed_successor", return_value=self.stage) as seal:
                        main()
                    seal.assert_called_once_with(REVISION, {"artifactId": "101", "sha256": "f" * 64}, verifier=CHECKOUT)
            self.assertEqual(json.loads((Path(folder) / STAGE_FILE).read_text()), self.stage)
