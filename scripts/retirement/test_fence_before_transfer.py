import unittest
from unittest.mock import Mock

from fence_before_transfer import ACCESS, disable_worker, pause_queue, require_access_plan
from provider import Refused


class TransferFence(unittest.TestCase):
    def test_exact_access_preview_before_fence(self):
        rows = [{"logicalId": name, "resourceType": "Cloudflare.Access.Application", "action": "update"}
                for name in sorted(ACCESS)]
        rows.append({"logicalId": "RecoveryOperators", "resourceType": "Cloudflare.Access.Group", "action": "noop"})
        plan = {"verifierRevision": "x", "applied": False, "resources": rows}
        require_access_plan(plan, "x")
        with self.assertRaises(Refused):
            require_access_plan({**plan, "applied": True}, "x")
        with self.assertRaises(Refused):
            require_access_plan({**plan, "resources": rows + [rows[0]]}, "x")

    def test_only_queue_delivery_setting_changes_and_is_read_back(self):
        provider, record = Mock(), Mock()
        before = {"queue_id": "exact", "queue_name": "old", "settings": {"delivery_delay": 0}}
        after = {**before, "settings": {"delivery_delay": 0, "delivery_paused": True}}
        provider.result.side_effect = [before, after, after]
        pause_queue(provider, "exact", "old", record)
        self.assertEqual(provider.result.call_args_list[1].kwargs,
                         {"method": "PATCH", "body": {"settings": {"delivery_paused": True}}})
        self.assertEqual(record.call_args.args[0]["stage"], "queue-pause-verified")

    def test_worker_fence_only_clears_cron_and_public_preview(self):
        provider, record = Mock(), Mock()
        provider.result.side_effect = [
            {"schedules": [{"cron": "* * * * *"}]},
            {"enabled": True, "previews_enabled": False}, {}, {},
            {"enabled": False, "previews_enabled": False}, {"schedules": []},
        ]
        disable_worker(provider, "old", record)
        mutations = [call for call in provider.result.call_args_list if call.kwargs]
        self.assertEqual([call.args[0] for call in mutations],
                         ["workers/scripts/old/schedules", "workers/scripts/old/subdomain"])
        self.assertEqual([call.kwargs["method"] for call in mutations], ["PUT", "POST"])
        self.assertEqual(record.call_args.args[0]["stage"], "worker-fence-verified")


if __name__ == "__main__":
    unittest.main()
