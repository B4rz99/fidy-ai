import json
import unittest
from unittest.mock import patch

from pinned_storage import inspect_body, observation, probe, require_assignment


class PinnedStorageTest(unittest.TestCase):
    def test_failure_body_and_unknown_values_do_not_escape(self):
        self.assertEqual(inspect_body(b'', 'revision', 'version'), {'shape': 'empty'})
        self.assertEqual(inspect_body(b'{"status":"secret","message":"secret"}', 'revision', 'version'),
                         {'shape': 'unexpected-json'})

    def test_observability_scopes_events_and_emits_only_bounded_counts(self):
        def fetch(url, headers, body):
            request = json.loads(body)
            self.assertEqual(request["view"], "events")
            self.assertEqual(request["queryId"], "native-pinned-storage")
            self.assertTrue(request["dry"])
            self.assertEqual({f["key"]: f["value"] for f in request["parameters"]["filters"]},
                             {"$workers.scriptName": "core", "$workers.scriptVersion.id": "exact"})
            worker = {"scriptName": "core", "scriptVersion": {"id": "exact"}, "eventType": "fetch"}
            return 200, {}, json.dumps({"success": True, "result": {"events": {"count": 2, "events": [
                {"timestamp": 2, "$workers": {**worker, "outcome": "ok",
                    "event": {"request": {"url": "https://storage-acceptance.fidyapp.com/internal/release-smoke?storage=compatibility"},
                              "response": {"status": 503}}}},
                {"timestamp": 2, "$workers": {**worker, "outcome": "private-unexpected",
                    "executionModel": "durableObject", "durableObjectId": "private",
                    "event": {"request": {"url": "https://store.invalid/release-readiness"}}},
                 "$metadata": {"statusCode": 200, "message": "private"}},
            ]}}}).encode()

        self.assertEqual(observation(fetch, "account", {}, "core", "exact", 1, 3),
                         {"status": 200, "availability": "available", "events": 2,
                          "outcomes": {"ok": 1, "other": 1}, "responseStatuses": {"503": 1, "200": 1},
                          "routes": {"compatibility": 1, "ownerReadiness": 1}, "durableObjectEvents": 1})

    def test_unpinned_stable_probe_retains_only_known_failure_and_colo(self):
        pair = {"revision": "stable", "ingress": "ingress", "core": "core"}
        with patch("pinned_storage.fetch", return_value=(503, {
            "x-fidy-smoke-worker-version": "ingress", "x-fidy-smoke-failure": "core_response",
            "cf-ray": "deadbeefdeadbeef-IAD"}, b'{"status":"unavailable","reason":"private"}')) as send:
            self.assertEqual(probe("readiness", pair, "proof", pinned=False), {
                "status": 503, "ingressMatches": True, "shape": "unavailable",
                "failureStage": "core_response", "colo": "IAD",
            })
            self.assertEqual(send.call_args.args[1], {"x-fidy-smoke-proof": "proof"})

    def test_refuses_new_assignments_or_traffic(self):
        stable = {"version_id": "stable", "percentage": 100}
        candidate = {"version_id": "candidate", "percentage": 0}
        require_assignment({"deployments": [{"id": "original", "versions": [stable, candidate]}]},
                           "original", "stable", "candidate")
        with self.assertRaises(ValueError):
            require_assignment({"deployments": [{"id": "original", "versions": [stable, {**candidate, "percentage": 1}]}]},
                               "original", "stable", "candidate")
