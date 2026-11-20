import unittest

from fixture import facts
from mirror import bind_workspace_user


class BrowserWorkspaceTests(unittest.TestCase):
    def test_restores_original_user_and_trial_with_all_fixture_references(self):
        frozen = "24000000-0000-4000-8000-000000000481"
        uid = "23670bc5-ef46-49e2-bc99-48a672fb201b"
        opened = "2026-11-19T12:34:56.789Z"
        profile = dict(id=uid, createdAt=opened, serviceMarket="CO", locale="es-CO",
                       timeZone="America/Bogota",
                       trialPeriod=dict(startedAt=opened, endsAt="2026-11-26T12:34:56.789Z"))
        rows = [
            dict(sql="INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',0)", params=[frozen]),
            dict(sql="INSERT INTO transactions(id,user_id) SELECT ?,?", params=[facts(2)["counterparty"], frozen]),
        ]
        plan = dict(batches=[dict(batch=rows)])
        binding = bind_workspace_user(plan, {"profile": {"data": profile}})
        self.assertEqual(binding, dict(id=uid, startedAtMs=1795091696789, endsAtMs=1795696496789))
        self.assertEqual(rows[1]["params"], ["Evaluación 2", uid])
        self.assertEqual(rows[0]["params"], [uid, 1795091696789])
        self.assertTrue(rows[0]["sql"].endswith("'America/Bogota',?)"))
