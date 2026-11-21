from base64 import b64decode, urlsafe_b64decode
from copy import deepcopy
from hashlib import sha256
import hmac
import json
from subprocess import CalledProcessError
import unittest
from unittest.mock import MagicMock, Mock, patch

from disposition import (KINDS, SCOPE, dispose, hold_reasons, require_isolation, retire_queue_consumers,
                         unchanged_remaining, validate_scope, worker_deletion_order)
from provider import Provider, Refused, multipart_read_session


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
                    "objects": {"exact": {"count": 0, "multipartClear": True}}}
        self.assertEqual(hold_reasons(snapshot), [])
        snapshot["objects"]["exact"]["multipartClear"] = False
        self.assertEqual([hold["source"] for hold in hold_reasons(snapshot)], ["multipart-unverified"])
        snapshot["objects"]["exact"]["multipartClear"] = None
        snapshot["census"]["exact"].append({"source": "issued_r2_writers", "attention_rows": 1})
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
    @patch("disposition.require_detached_queue")
    def test_only_exact_observed_targets_are_offered_and_read_back(self, detached, graph, _scope, release):
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
            ("offered", "workers", worker), ("delete", "workers", worker),
            ("readback", "workers", worker), ("absent", "workers", worker),
            ("offered", "queues", queue), ("delete", "queues", queue),
            ("readback", "queues", queue), ("absent", "queues", queue),
            ("verified", None, None),
        ])
        detached.assert_called_once_with(provider, queue)
        self.assertEqual(release.call_count, 2)

    def test_retires_only_the_observed_paused_consumer_and_checks_absence(self):
        queue, name = next(iter(SCOPE["queues"].items()))
        worker = SCOPE["workers"][0]
        consumer = "2" * 32
        approved = {queue: {"consumers": [[consumer, worker, ""]]}}
        resource = {"consumer_id": consumer, "script": worker, "type": "worker"}
        provider, record = Mock(), Mock()
        provider.result.return_value = {"queue_id": queue, "queue_name": name, "settings": {"delivery_paused": True}}
        provider.pages.side_effect = [[resource], []]
        retire_queue_consumers(provider, approved, record)
        provider.delete_queue_consumer.assert_called_once_with(queue, consumer)
        self.assertEqual(record.call_args.args[0]["status"], "queue-consumer-absent")
        provider.delete_queue_consumer.reset_mock()
        provider.pages.side_effect = [[{**resource, "script": "not-approved"}]]
        with self.assertRaisesRegex(Refused, "Unexpected consumer"):
            retire_queue_consumers(provider, approved, record)
        provider.delete_queue_consumer.assert_not_called()



class ProviderReads(unittest.TestCase):
    def test_retirement_accepts_the_longest_pinned_workflow_name(self):
        service = Provider(account="0" * 32, zone="1" * 32, token="synthetic", builds_token="synthetic")
        service.request = Mock()
        workflow = next(name for name in SCOPE["workflows"] if len(name) == 64)
        service.delete("workflows", workflow)
        service.request.assert_called_once_with("workflows/" + workflow, method="DELETE", absent=True)
        with self.assertRaisesRegex(Refused, "Invalid exact retirement address"):
            service.delete("workflows", workflow + "x")

    def test_provider_delete_accepts_acknowledgement_and_empty_success_but_reads_need_data(self):
        service = Provider(account="0" * 32, zone="1" * 32, token="synthetic", builds_token="synthetic")
        service.http = MagicMock()
        response = service.http.open.return_value.__enter__.return_value
        response.read.return_value = b'{"status":"deleted","success":true}'
        service.delete("workflows", next(iter(SCOPE["workflows"])))
        with self.assertRaisesRegex(Refused, "Incomplete provider confirmation"):
            service.result("workflows")
        response.read.return_value = b""
        self.assertIsNone(service.delete("workflows", next(iter(SCOPE["workflows"]))))
        response.read.return_value = b'{"success":false}'
        with self.assertRaisesRegex(Refused, "Incomplete provider confirmation"):
            service.delete("workflows", next(iter(SCOPE["workflows"])))

    @patch("provider.time", return_value=1770000000)
    def test_r2_session_only_lists_one_bucket_for_two_minutes(self, _time):
        account, access, parent = "0" * 32, "1" * 32, "synthetic-parent"
        hostname = f"{account}.r2.cloudflarestorage.com"
        bucket = next(iter(SCOPE["buckets"]))
        settings = multipart_read_session(account, hostname, access, parent, bucket)
        session = b64decode(settings["AWS_SESSION_TOKEN"])
        self.assertTrue(session.startswith(b"jwt/"))
        jwt = session.removeprefix(b"jwt/")
        header, payload, signature = jwt.split(b".")

        def decode(part):
            return urlsafe_b64decode(part + b"=" * (-len(part) % 4))

        self.assertEqual(json.loads(decode(header)), {"alg": "HS256", "typ": "JWT"})
        self.assertEqual(json.loads(decode(payload)), {
            "bucket": bucket, "actions": ["ListMultipartUploads"], "sub": account, "iss": access,
            "aud": hostname, "iat": 1770000000, "exp": 1770000120,
        })
        self.assertEqual(decode(signature), hmac.digest(sha256(parent.encode()).hexdigest().encode(),
                                                        header + b"." + payload, "sha256"))
        self.assertEqual(settings["AWS_SECRET_ACCESS_KEY"], sha256(jwt).hexdigest())
        self.assertEqual(settings["AWS_ACCESS_KEY_ID"], access)

    @patch("provider.subprocess.run")
    def test_r2_permission_failure_keeps_credential_and_provider_error_private(self, command):
        service = Provider(account="0" * 32, zone="1" * 32, token="synthetic", builds_token="synthetic")
        service.result = Mock(side_effect=Refused("private-provider-response"))
        service._request = Mock(side_effect=Refused("private-provider-response"))
        bucket = next(iter(SCOPE["buckets"]))
        with self.assertRaisesRegex(Refused, "^Protected Cloudflare token could not be verified for R2$"):
            service.multipart_clear(bucket)
        command.assert_not_called()
        service._request.return_value = {"result": {"status": "active", "id": "2" * 32}}
        service._request.side_effect = None
        command.side_effect = CalledProcessError(1, "aws", stderr=b"(AccessDenied) private-provider-response")
        with self.assertRaisesRegex(Refused, "^Protected Cloudflare token did not authorize scoped R2 multipart inspection$"):
            service.multipart_clear(bucket)

    @patch("provider.subprocess.run")
    def test_multipart_inspection_refuses_foreign_or_incomplete_listing(self, command):
        service = Provider(account="0" * 32, zone="1" * 32, token="synthetic", builds_token="synthetic")
        service.r2_parent_access_key = Mock(return_value="2" * 32)
        bucket = next(iter(SCOPE["buckets"]))
        with self.assertRaises(Refused):
            service.multipart_clear("unrelated")
        service.r2_parent_access_key.assert_not_called()
        command.assert_not_called()
        command.return_value.stdout = json.dumps({"Bucket": bucket, "IsTruncated": False})
        self.assertTrue(service.multipart_clear(bucket))
        command.return_value.stdout = json.dumps({"Bucket": bucket, "IsTruncated": True})
        self.assertFalse(service.multipart_clear(bucket))
        command.return_value.stdout = json.dumps({"Bucket": bucket, "IsTruncated": False,
                                                  "Uploads": [{"Key": "private", "UploadId": "private"}]})
        self.assertFalse(service.multipart_clear(bucket))
        command.return_value.stdout = json.dumps({"Bucket": "unrelated", "IsTruncated": False})
        with self.assertRaises(Refused):
            service.multipart_clear(bucket)

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
