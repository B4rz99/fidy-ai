import hashlib
import unittest
from installation import BROWSER, HOST, SCRIPTS, validate_candidate, validate_qualification


class ClosedNativeCandidateTests(unittest.TestCase):
    def test_exact_versions_and_pinned_signer_precede_any_session(self):
        pub="a1"*90
        revision="c"*40
        versions={"ingress":"b24acd2d-f394-4991-bb05-7fbdd9ef479d","core":"1ede059a-5ea9-448b-9ccd-72c6ac706e66"}
        generation="a"*40
        smoke="fidy-native-smoke-"+generation
        fingerprint=hashlib.sha256(bytes.fromhex(pub)).hexdigest()
        def inspect(path):
            if "/domains?" in path:
                return [{"hostname":HOST,"service":SCRIPTS["ingress"],"enabled":True,"previews_enabled":False}]
            role="core" if SCRIPTS["core"] in path else "ingress"
            if path.endswith("/deployments"):
                return {"deployments":[{"id":versions[role],"versions":[{"version_id":versions[role],"percentage":100}]}]}
            fields={"NATIVE_STORAGE_ADMISSION":"closed","RECOVERY_ISOLATION":"isolated","RELEASE_GIT_SHA":revision,"BROWSER_ORIGIN":BROWSER}
            extra=[{"name":"CORE","type":"service","service":SCRIPTS["core"]}]
            if role=="core":
                fields["NATIVE_FIXTURE_SIGNER_SHA256"]=fingerprint
                fields["SMOKE_QUEUE_NAME"]=smoke
                extra=[{"name":"NATIVE_FIXTURE_SIGNING_KEY","type":"secret_text"},
                       {"name":"USER_STORE","type":"durable_object_namespace","class_name":"UserStore","namespace_id":"e"*32},
                       {"name":"SMOKE_QUEUE","type":"queue","queue_name":smoke},
                       {"name":"SMOKE_WORKFLOW","type":"workflow","workflow_name":smoke,"class_name":"ReleaseSmokeWorkflowV2","script_name":smoke},
                       {"name":"SMOKE_BUCKET","type":"r2_bucket","bucket_name":"fidy-native-release-smoke"}]
            original="8dd3b0d47d655868c1ab4f16b6145a06d99bd721"
            extra.append({"name":"RELEASE_FIXTURE","type":"service","service":"fidy-native-smoke-"+original})
            if role=="core":
                fields["ACCEPTANCE_PROVIDER_REVISION"]=original
            return {"id":versions[role],"resources":{"bindings":extra+[{"name":k,"type":"plain_text","text":v} for k,v in fields.items()]}}
        args=dict(account="c"*32,revision=revision,versions=versions,public_key=pub)
        self.assertEqual(validate_candidate(inspect,**args)["signerSha256"],fingerprint)
        legacy = validate_candidate(inspect, **args)
        self.assertEqual(legacy["resourceRevision"], generation)
        self.assertNotIn("fixtureMember", legacy)
        def with_binding(role, kind, member):
            def read(path):
                data = inspect(path)
                if "/versions/" in path and SCRIPTS[role] in path:
                    data["resources"]["bindings"].append(
                        {"name":"NATIVE_FIXTURE_MEMBER","type":kind,"text":member})
                return data
            return read
        selected = validate_candidate(with_binding("core", "plain_text", "performance-2"), **args)
        self.assertEqual(selected["fixtureMember"], "performance-2")
        for role, kind, member in (("core", "plain_text", "performance-3"),
                                   ("core", "plain_text", "performance-1"),
                                   ("core", "secret_text", "performance-2"),
                                   ("ingress", "plain_text", "performance-2")):
            with self.subTest(role=role, kind=kind, member=member), self.assertRaises(ValueError):
                validate_candidate(with_binding(role, kind, member), **args)
        snapshot = {"revision":revision, "core":{"name":SCRIPTS["core"]}, "public":{"name":SCRIPTS["ingress"]}}
        promotion = {"rollbackTested":True, "release":{"snapshot":snapshot,
                     "coreVersionId":versions["core"], "publicVersionId":versions["ingress"]},
                     "promoted":{"coreDeploymentId":versions["core"],"publicDeploymentId":versions["ingress"]}}
        installation = {**promotion["release"], "revision":revision, "admission":"closed",
                        "resourceRevision":generation, "userNamespace":"e"*32}
        validate_qualification(legacy, promotion, installation)
        with self.assertRaises(ValueError):
            validate_qualification(selected, promotion, installation)
        installation["fixtureMember"] = "performance-2"
        validate_qualification(selected, promotion, installation)
        with self.assertRaises(ValueError):
            validate_qualification(legacy, promotion, installation)
        for name, field in [("SMOKE_WORKFLOW","script_name"),("SMOKE_WORKFLOW","workflow_name"),
                            ("SMOKE_WORKFLOW","class_name"),("SMOKE_QUEUE","queue_name"),("SMOKE_QUEUE_NAME","text")]:
            def switched(path):
                value=inspect(path)
                if "/versions/" in path:
                    for binding in value["resources"]["bindings"]:
                        if binding["name"]==name:
                            binding[field]="fidy-native-smoke-"+revision
                return value
            with self.subTest(name=name,field=field),self.assertRaises(ValueError):
                validate_candidate(switched,**args)
        def rotated(path):
            value=inspect(path)
            if "/versions/" in path:
                for binding in value["resources"]["bindings"]:
                    if binding["name"]=="RELEASE_FIXTURE":
                        binding["service"]="fidy-native-smoke-"+revision
            return value
        with self.assertRaises(ValueError):
            validate_candidate(rotated, **args)
        for replacement in ({"revision":"d"*40},{"public_key":"b2"*90},{"versions":{**versions,"core":versions["ingress"]}}):
            with self.assertRaises(ValueError):
                validate_candidate(inspect,**{**args,**replacement})
