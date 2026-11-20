from copy import deepcopy
import unittest
from uuid import UUID

from successor_artifacts import require_sealed_source
from successor_source import ACTIVE_ARTIFACT, ORIGINAL_CLEANUP, ORIGINAL_REVISION
from qualified_release import retained_provider, fixture_upload


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
