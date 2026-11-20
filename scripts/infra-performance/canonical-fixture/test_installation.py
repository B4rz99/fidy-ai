import hashlib
import unittest
from installation import BROWSER, HOST, SCRIPTS, validate_candidate


class ClosedNativeCandidateTests(unittest.TestCase):
    def test_exact_versions_and_pinned_signer_precede_any_session(self):
        pub="a1"*90
        revision="c"*40
        versions={"ingress":"b24acd2d-f394-4991-bb05-7fbdd9ef479d","core":"1ede059a-5ea9-448b-9ccd-72c6ac706e66"}
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
                extra=[{"name":"NATIVE_FIXTURE_SIGNING_KEY","type":"secret_text"},
                       {"name":"USER_STORE","type":"durable_object_namespace","class_name":"UserStore","namespace_id":"e"*32},
                       {"name":"SMOKE_BUCKET","type":"r2_bucket","bucket_name":"fidy-native-release-smoke"}]
            return {"id":versions[role],"resources":{"bindings":extra+[{"name":k,"type":"plain_text","text":v} for k,v in fields.items()]}}
        args=dict(account="c"*32,revision=revision,versions=versions,public_key=pub)
        self.assertEqual(validate_candidate(inspect,**args)["signerSha256"],fingerprint)
        for replacement in ({"revision":"d"*40},{"public_key":"b2"*90},{"versions":{**versions,"core":versions["ingress"]}}):
            with self.assertRaises(ValueError):
                validate_candidate(inspect,**{**args,**replacement})
