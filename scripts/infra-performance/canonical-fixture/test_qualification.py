import unittest
from copy import deepcopy

from installation import SCRIPTS, validate_qualification


class ReleaseQualificationTests(unittest.TestCase):
    def test_only_the_promoted_rollback_tested_pair_and_verified_user_namespace_are_admitted(self):
        versions = dict(core="bf90ea0f-ab51-4611-b7a8-600ef4a6babf", ingress="a79c9dc5-cb29-4fd0-af2d-a083a75e0508")
        deployments = dict(core="2e8da812-f8a1-42ab-82eb-6a00cf9177a3", ingress="039cbd10-6531-46c6-8454-d50033af164f")
        revision = "a" * 40
        candidate = dict(revision=revision, resourceRevision="c"*40, versions=versions, deployments=deployments, userNamespace="e" * 32)
        snapshot = dict(revision=revision, stableRevision="b" * 40,
                        public=dict(name=SCRIPTS["ingress"]), core=dict(name=SCRIPTS["core"]))
        release = dict(snapshot=snapshot, publicVersionId=versions["ingress"], coreVersionId=versions["core"])
        proof = dict(rollbackTested=True, release=release, promoted=dict(publicDeploymentId=deployments["ingress"],
                                                                          coreDeploymentId=deployments["core"]))
        installed = dict(revision=revision, resourceRevision=candidate["resourceRevision"], publicVersionId=versions["ingress"], coreVersionId=versions["core"],
                         userNamespace=candidate["userNamespace"], admission="closed")
        validate_qualification(candidate, proof, installed)
        for obj, field, value in [
            (proof, "rollbackTested", False), (proof["release"], "publicVersionId", versions["core"]),
            (proof["promoted"], "coreDeploymentId", deployments["ingress"]),
            (snapshot, "revision", snapshot["stableRevision"]), (installed, "admission", "open"),
            (installed, "resourceRevision", revision), (installed, "userNamespace", "f" * 32), (installed, "revision", "c" * 40),
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


class RetainedResourceQualificationTests(unittest.TestCase):
    def setUp(self):
        from unittest.mock import patch
        from qualified_release import retained_provider
        self.source, self.generation = "b"*40, "a"*40
        self.provider = retained_provider()
        self.roles = dict(Core="fidy-native-storage-core", Ingress="fidy-native-storage-ingress",
                          Web="fidy-native-web", ForwardedEmail="fidy-native-email",
                          Smoke="fidy-native-smoke-"+self.generation)
        self.workers = {
            role: dict(role=role, name=name, versionId="10000000-0000-4000-8000-"+str(i).zfill(12),
                       deploymentId="20000000-0000-4000-8000-"+str(i).zfill(12))
            for i,(role,name) in enumerate(self.roles.items())}
        support = {r: {k:self.workers[r][k] for k in ("versionId","deploymentId")} for r in ("Smoke","ForwardedEmail","Web")}
        # The repair uploads a new receiver to the existing Smoke Worker. Web and Email stay untouched.
        support["Smoke"] = dict(versionId="30000000-0000-4000-8000-000000000001",
                                deploymentId="40000000-0000-4000-8000-000000000001")
        self.pin = dict(revision=self.generation, support=support)
        self.patch = patch("qualified_release.fixture_upload",return_value=self.pin)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.sources = {name: self.source if role in ("Core","Ingress","Smoke") else self.generation for role,name in self.roles.items()}
        self.receiver_target = self.roles["Smoke"]
        self.active = {row["name"]:dict(id=row["deploymentId"],versions=[dict(version_id=row["versionId"],percentage=100)])
                       for row in self.workers.values()}
        self.active["fidy-native-smoke-"+self.provider["revision"]] = dict(id=self.provider["deploymentId"],
            versions=[dict(version_id=self.provider["versionId"],percentage=100)])
        self.installed = dict(revision=self.source, resourceRevision=self.generation, retainedProvider=self.provider,
            fixtureControlsDigest="a"*64, workers=list(self.workers.values()),
            coreVersionId=self.workers["Core"]["versionId"], publicVersionId=self.workers["Ingress"]["versionId"],
            website=[dict(browser="https://storage-web-acceptance.fidyapp.com", api="https://storage-acceptance.fidyapp.com",
                          revision=self.generation,entryAssets=["assets/main.js"])],
            resources=dict(buckets=["fidy-native-"+n for n in ("release-smoke","forwarded-email","approved-ingest-samples","statement-staging")]))

    def read(self, path):
        if "/r2/buckets/" in path:
            return dict(name=path.split("/")[-1],storage_class="Standard")
        script,kind,*version = path.split("/scripts/")[1].split("/")
        if kind == "deployments":
            return {"deployments":[self.active[script]]}
        self.assertEqual(kind, "versions")
        bindings = [dict(name="RELEASE_GIT_SHA",type="plain_text",text=self.sources[script])]
        if script == self.roles["Smoke"]:
            bindings += [dict(name="SMOKE_QUEUE_NAME",type="plain_text",text=script),
                         dict(name="SMOKE_WORKFLOW",type="workflow",workflow_name=self.receiver_target,class_name="ReleaseSmokeWorkflowV2")]
        return {"id": version[0], "resources": {"bindings": bindings}}

    def verify(self):
        from qualified_release import serving_graph
        serving_graph(self.read,"c"*32,self.source,self.installed)

    def test_qualifies_new_application_on_retained_generation_and_original_private_provider(self):
        self.verify()
        self.receiver_target = "fidy-native-smoke-"+self.source
        with self.assertRaisesRegex(ValueError, "receiver targets"):
            self.verify()

    def test_substituting_resource_provider_asset_or_support_receipt_refuses_before_cleanup(self):
        for owner,field,bad in [
            (self.installed,"resourceRevision",self.source), (self.installed,"resourceRevision",self.provider["revision"]),
            (self.installed,"revision",self.generation), (self.installed["website"][0],"revision",self.source),
            (self.installed["website"][0],"browser","https://other.invalid"),
            (self.installed,"retainedProvider",{**self.provider,"revision":self.generation}),
            (self.sources,self.roles["Smoke"],self.generation), (self.sources,self.roles["ForwardedEmail"],self.source),
            (self.workers["Web"],"versionId",self.workers["Smoke"]["versionId"]),
            (self.workers["Smoke"],"name","fidy-native-smoke-"+self.source),
            (self.workers["Core"],"versionId",self.workers["Ingress"]["versionId"]),
            (self.active["fidy-native-smoke-"+self.provider["revision"]]["versions"][0],"percentage",0),
        ]:
            with self.subTest(field=field):
                original=owner[field]
                owner[field]=bad
                try:
                    with self.assertRaises(ValueError):
                        self.verify()
                finally:
                    owner[field]=original
        # A served old receiver or its original deployment cannot qualify after source repair.
        worker=self.workers["Smoke"]
        for key,active,key_on_active in [("deploymentId",self.active[worker["name"]],"id"),
                                         ("versionId",self.active[worker["name"]]["versions"][0],"version_id")]:
            previous=worker[key]
            worker[key]=active[key_on_active]=self.pin["support"]["Smoke"][key]
            with self.subTest(key=key),self.assertRaises(ValueError):
                self.verify()
            worker[key]=active[key_on_active]=previous
        # Matching a substituted Web deployment to a forged archive receipt still fails its independent pin.
        worker=self.workers["Web"]
        worker["deploymentId"]=self.active[worker["name"]]["id"]=self.workers["Smoke"]["deploymentId"]
        with self.assertRaises(ValueError):
            self.verify()
