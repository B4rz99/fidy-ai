import json
import unittest

from pinned_storage import inspect_body, observation, require_assignment


class PinnedStorageTest(unittest.TestCase):
    def test_failure_body_and_unknown_values_do_not_escape(self):
        self.assertEqual(inspect_body(b'', 'revision', 'version'), {'shape': 'empty'})
        self.assertEqual(inspect_body(b'{"status":"secret","message":"secret"}', 'revision', 'version'),
                         {'shape': 'unexpected-json'})

    def test_observability_is_aggregate_and_pins_exact_worker_version(self):
        def fetch(url, headers, body):
            request = json.loads(body)
            self.assertEqual(request["view"], "calculations")
            self.assertTrue(request["dry"])
            self.assertEqual({f["key"]: f["value"] for f in request["parameters"]["filters"]},
                             {"$workers.scriptName": "core", "$workers.scriptVersion.id": "exact"})
            return 200, {}, json.dumps({"success": True, "result": {"calculations": [{
                "alias": "events", "aggregates": [
                    {"groups": [{"key": "$workers.outcome", "value": "ok"}], "count": 2, "sampleInterval": 1},
                    {"groups": [{"key": "$workers.outcome", "value": "unexpected-sensitive-value"}],
                     "count": 1, "sampleInterval": 2},
                ], "series": [{"secret": "private"}]}]}}).encode()

        self.assertEqual(observation(fetch, "account", {}, "core", "exact", 1, 2),
                         {"status": 200, "availability": "available", "outcomes": [
                             {"outcome": "ok", "estimatedEvents": 2, "sampled": False},
                             {"outcome": "other", "estimatedEvents": 1, "sampled": True},
                         ]})

    def test_refuses_new_assignments_or_traffic(self):
        stable = {"version_id": "stable", "percentage": 100}
        candidate = {"version_id": "candidate", "percentage": 0}
        require_assignment({"deployments": [{"id": "original", "versions": [stable, candidate]}]},
                           "original", "stable", "candidate")
        with self.assertRaises(ValueError):
            require_assignment({"deployments": [{"id": "original", "versions": [stable, {**candidate, "percentage": 1}]}]},
                               "original", "stable", "candidate")
