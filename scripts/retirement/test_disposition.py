from copy import deepcopy
import unittest
from unittest.mock import Mock, patch

from disposition import KINDS, SCOPE, dispose, hold_reasons, require_isolation, unchanged_remaining, validate_scope, worker_deletion_order
from provider import Provider, Refused


class InventorySafety(unittest.TestCase):
    def setUp(self):
        self.empty = {kind: {} for kind in (*KINDS, "legacyNamespaces")}

    def test_exact_pinned_ids_cannot_be_renamed_or_substituted(self):
        key, exact = next(iter(SCOPE["databases"].items()))
        for row in ({**exact, "name": "foreign"}, {**exact, "created_at": "different"}):
            graph = {**self.empty, "databases": {key: row}}
            with self.assertRaises(Refused):
                validate_scope(graph)

    def test_account_wide_references_are_not_a_disposal_target(self):
        d1 = next(iter(SCOPE["databases"]))
        with self.assertRaises(Refused):
            require_isolation(set(SCOPE["workers"]), {}, {"fidy-native-storage-core": {"databases": {d1}}})

    def test_worker_consumers_before_their_targets_and_refuse_cycles(self):
        graph = {"web": [], "ingress": ["core"], "mail": ["core"], "core": ["smoke"], "smoke": []}
        plan = worker_deletion_order(graph)
        for consumer, targets in graph.items():
            for target in targets:
                self.assertLess(plan.index(consumer), plan.index(target))
        with self.assertRaises(Refused):
            worker_deletion_order({"a": ["b"], "b": ["a"]})

    def test_disposable_samples_are_distinct_from_unfinished_writers(self):
        snapshot = {"census": {"exact": [{"source": "structural_samples", "attention_rows": 7},
                                 {"source": "billing_attempts", "attention_rows": 2},
                                 {"source": "whatsapp_deliveries", "attention_rows": 4}]},
                    "objects": {"exact": {"count": 0, "multipartClear": None}}}
        self.assertEqual(hold_reasons(snapshot), [])
        snapshot["objects"]["exact"]["multipartClear"] = False
        self.assertEqual([hold["source"] for hold in hold_reasons(snapshot)], ["multipart-unverified"])
        snapshot["objects"]["exact"]["multipartClear"] = None
        snapshot["census"]["exact"].append({"source": "issued_r2_writers", "attention_rows": 1})
        snapshot["objects"]["exact"]["count"] = 1
        self.assertEqual([hold["source"] for hold in hold_reasons(snapshot)],
                         ["issued_r2_writers", "multipart-unverified"])

    def test_opened_release_drift_and_new_targets_refuse(self):
        plan = {"opening": "exact", "targets": {kind: [] for kind in KINDS}, "preserve": {},
                "workers": {}, "census": {}, "objects": {}, "workerDependencies": {}, "queues": {}}
        unchanged_remaining(plan, deepcopy(plan))
        for change in ({"opening": "wrong"}, {"preserve": {"databases": ["new"]}},
                       {"targets": {**plan["targets"], "workers": ["unreviewed"]}}):
            with self.assertRaises(Refused):
                unchanged_remaining(plan, {**plan, **change})

    def test_no_delete_before_current_opening_and_active_writer_checks(self):
        provider = Mock()
        plan = {"opening": "exact", "targets": {kind: [] for kind in KINDS}, "preserve": {},
                "workers": {}, "census": {}, "objects": {}, "workerDependencies": {}, "queues": {}}
        with self.assertRaises(Refused):
            dispose(provider, {}, plan, Mock(), observe=Mock(return_value={**plan, "opening": "changed"}))
        provider.delete.assert_not_called()
        plan["census"] = {"db": [{"source": "issued_r2_writers", "attention_rows": 1}]}
        record = Mock()
        with self.assertRaises(Refused):
            dispose(provider, {}, plan, record, observe=Mock(return_value=deepcopy(plan)))
        self.assertEqual(record.call_args.args[0]["status"], "held")
        provider.delete.assert_not_called()

    @patch("disposition.releases_match")
    @patch("disposition.validate_scope")
    @patch("disposition.provider_inventory")
    def test_only_exact_observed_targets_are_offered_and_read_back(self, graph, _scope, release):
        worker = SCOPE["workers"][0]
        version = {"deployment": "00000001-1111-4111-8111-000000000000",
                   "version": "00000001-1111-4111-8111-000000000001"}
        queue = next(iter(SCOPE["queues"]))
        targets = {kind: [] for kind in KINDS}
        targets.update(workers=[worker], queues=[queue])
        approved = {"opening": "exact", "targets": targets, "preserve": {"workers": ["fidy-site"]},
                    "workers": {worker: version}, "census": {}, "objects": {}, "legacyNamespaces": [],
                    "workerDependencies": {worker: []}, "queues": {}}
        final = {**approved, "targets": {kind: [] for kind in KINDS}}
        graph.return_value = {"hosts": {}, "legacyNamespaces": {}}
        provider, record, deleted = Mock(), Mock(), Mock()
        entries = []
        provider.result.return_value = {"deployments": [{"id": version["deployment"],
            "versions": [{"percentage": 100, "version_id": version["version"]}]}]}
        provider.delete.side_effect = lambda kind, key: entries.append(("delete", kind, key))
        record.side_effect = lambda event: entries.append((event["status"], event.get("kind"), event.get("id")))
        deleted.side_effect = lambda _, opening, scope, kind, key: entries.append(("readback", kind, key))
        dispose(provider, {}, approved, record, observe=Mock(side_effect=[approved, final]), deleted=deleted)
        self.assertEqual(entries, [
            ("offered", "queues", queue), ("delete", "queues", queue),
            ("readback", "queues", queue), ("absent", "queues", queue),
            ("offered", "workers", worker), ("delete", "workers", worker),
            ("readback", "workers", worker), ("absent", "workers", worker),
            ("verified", None, None),
        ])
        self.assertEqual(release.call_count, 2)



class ProviderReads(unittest.TestCase):
    def test_complete_provider_pages_with_no_total_pages(self):
        class Read:
            pages = Provider.pages

            def request(self, _, **kwargs):
                return {"result": [{"id": "exact"}], "result_info": {"page": 1, "count": 1, "total_count": 1}}

        self.assertEqual(Read().pages("workers/durable_objects/namespaces", "id"), [{"id": "exact"}])

    def test_declared_truncated_bucket_cannot_look_empty(self):
        class Read:
            objects = Provider.objects

            def request(self, _):
                return {"result": [], "result_info": {"is_truncated": True}}

        with self.assertRaises(Refused):
            Read().objects("legacy-bucket")


if __name__ == "__main__":
    unittest.main()
