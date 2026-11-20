from copy import deepcopy
from io import BytesIO
import json
import unittest
from unittest.mock import patch
from zipfile import ZipFile

import successor_partial as partial
from qualified_release import fixture_upload


class PartialSuccessorTests(unittest.TestCase):
    def test_refuses_a_partial_archive_from_a_job_that_reached_traffic_assignment(self):
        job = dict(name="plan", conclusion="failure", steps=[dict(name=name, conclusion=outcome)
                    for name, outcome in partial.FAILED_STEPS.items()])
        archive = BytesIO()
        with ZipFile(archive, "w") as data:
            data.writestr("native-release.json", "{}")
            data.writestr("native-release.json.controls", json.dumps({"digest": fixture_upload()["controlsDigest"]}))
        with patch.object(partial, "protected_archive", return_value=(partial.FAILED_RUN, archive.getvalue())):
            get = lambda _: json.dumps(dict(total_count=1, jobs=[job]))
            self.assertEqual(partial.archived_partial(get), {})
            for step in job["steps"]:
                if step["name"] == "Stage the verified successors at zero traffic":
                    step["conclusion"] = "success"
            with self.assertRaisesRegex(ValueError, "interrupted successor operation"):
                partial.archived_partial(get)

    def test_pinned_candidates_require_unchanged_old_traffic_and_exact_binding_changes(self):
        account, contract = "a"*32, "c"*64
        source = dict(oldSmokeVersionId="old-smoke")
        snapshot = dict(stableContractDigest=contract, core=dict(stableVersionId="old-core", deploymentId="old-core-deploy"),
                        public=dict(stableVersionId="old-ingress", deploymentId="old-ingress-deploy"))
        old_smoke = "fidy-native-smoke-" + fixture_upload()["revision"]
        graph = {}
        graph[f"accounts/{account}/workers/scripts/{partial.SMOKE}/subdomain"] = {
            "enabled": False, "previews_enabled": False}

        def storage(protocol):
            return dict(type="plain_text", text=json.dumps({
                "histories": {owner: ["e"*64] for owner in partial.OWNERS},
                "protocol": {"write": protocol, "readers": [protocol]},
            }))

        def version(version_id, bindings, annotations=None):
            result = dict(id=version_id, resources=dict(bindings=[dict(name=name, **fields) for name, fields in bindings.items()]))
            if annotations is not None:
                result["annotations"] = annotations
            return result

        base = f"accounts/{account}/workers/scripts/"
        for role, name, original, candidate, deployment in (
                ("core", partial.CORE, "old-core", partial.CORE_VERSION, "old-core-deploy"),
                ("public", partial.INGRESS, "old-ingress", partial.INGRESS_VERSION, "old-ingress-deploy"),
                ("smoke", partial.SMOKE, "old-smoke", partial.SMOKE_VERSION, partial.SMOKE_DEPLOYMENT)):
            prior = {name: dict(type="plain_text", text=value) for name, value in {
                "CONTRACT_DIGEST": contract, "RELEASE_GIT_SHA": "0"*40,
                "NATIVE_STORAGE_ADMISSION": "closed",
                "ALCHEMY_WORKER_NAME": old_smoke if role == "smoke" else name}.items()}
            candidate_bindings = deepcopy(prior)
            candidate_bindings["RELEASE_GIT_SHA"]["text"] = partial.REVISION
            if role in {"core", "smoke"}:
                for bindings, smoke in ((prior, old_smoke), (candidate_bindings, partial.SMOKE)):
                    bindings["SMOKE_QUEUE_NAME"] = dict(type="plain_text", text=smoke)
                    bindings["SMOKE_WORKFLOW"] = dict(type="workflow", workflow_name=smoke, script_name=smoke)
                    if role == "core":
                        bindings["SMOKE_QUEUE"] = dict(type="queue", queue_name=smoke)
            if role == "smoke":
                candidate_bindings["ALCHEMY_WORKER_NAME"]["text"] = partial.SMOKE
            if role == "core":
                candidate_bindings["NATIVE_FIXTURE_MEMBER"] = dict(type="plain_text", text="performance-2")
            if role != "smoke":
                prior["SQLITE_STORAGE_RELEASE"] = storage(partial.STABLE_PROTOCOL)
                candidate_bindings["SQLITE_STORAGE_RELEASE"] = storage(partial.CANDIDATE_PROTOCOL)
            prior_name = old_smoke if role == "smoke" else name
            graph[base + prior_name + "/versions/" + original] = version(original, prior)
            graph[base + name + "/versions/" + candidate] = version(
                candidate, candidate_bindings, {"workers/tag": "release-" + partial.FAILED_RUN + "-1"})
            graph[base + name + "/deployments"] = {"deployments": [dict(id=deployment, versions=[
                dict(version_id=candidate if role == "smoke" else original, percentage=100)])]}

        def read(path):
            return 200, dict(success=True, result=graph[path])

        partial.require_workers(read, account, snapshot, source)
        core_path = base + partial.CORE + "/deployments"
        graph[core_path]["deployments"][0]["versions"][0]["percentage"] = 99
        with self.assertRaisesRegex(ValueError, "Live traffic differs"):
            partial.require_workers(read, account, snapshot, source)
        graph[core_path]["deployments"][0]["versions"][0]["percentage"] = 100
        version_case = graph[base + partial.CORE + "/versions/" + partial.CORE_VERSION]
        marker = next(row for row in version_case["resources"]["bindings"]
                      if row["name"] == "SQLITE_STORAGE_RELEASE")
        changed_marker = deepcopy(marker)
        marker.update(storage(partial.STABLE_PROTOCOL))
        with self.assertRaisesRegex(ValueError, "Core and Ingress storage release markers differ"):
            partial.require_workers(read, account, snapshot, source)
        marker.update(changed_marker)
        version_case["resources"]["bindings"].append(dict(name="unexpected", type="secret_text"))
        with self.assertRaisesRegex(ValueError, "Worker bindings differ"):
            partial.require_workers(read, account, snapshot, source)

    def test_workflow_absence_requires_authority_and_complete_inventory(self):
        account = "a"*32
        base = f"accounts/{account}/"
        consumer = dict(consumer_id=partial.CONSUMER, type="worker", script=partial.SMOKE,
                        queue_name=partial.SMOKE, dead_letter_queue=partial.DLQ,
                        settings=dict(batch_size=1, max_retries=3, max_wait_time_ms=0))
        observed = {
            "queues/"+partial.QUEUE: (200, dict(success=True, result=dict(queue_id=partial.QUEUE, queue_name=partial.SMOKE))),
            "queues/"+partial.QUEUE+"/consumers": (200, dict(success=True, result=[consumer])),
            "workflows/"+partial.SMOKE: (404, dict(success=False, errors=[dict(code=10200)])),
            "workflows?per_page=100&page=1": (200, dict(success=True, result=[dict(name=str(i)) for i in range(100)])),
            "workflows?per_page=100&page=2": (200, dict(success=True, result=[])),
        }
        read = lambda path: observed[path.removeprefix(base)]
        partial.require_support(read, account)
        observed["workflows?per_page=100&page=2"][1]["result"].append(dict(name=partial.SMOKE))
        with self.assertRaisesRegex(ValueError, "unexpectedly exists"):
            partial.require_support(read, account)
        observed["workflows/"+partial.SMOKE] = (403, dict(success=False, errors=[dict(code=10200)]))
        with self.assertRaisesRegex(ValueError, "Expected exact missing"):
            partial.require_support(read, account)
        consumer["script"] = "foreign"
        with self.assertRaisesRegex(ValueError, "Queue or consumer differs"):
            partial.require_support(read, account)


if __name__ == "__main__":
    unittest.main()
