import unittest

from comparison import boundaries


class ComparisonTests(unittest.TestCase):
    def test_scheduled_offers_can_fail_even_when_dispatch_looks_fast(self):
        rows = []
        for pair in range(30):
            for variant, dispatch, scheduled in (("d1", 180, 180), ("do", 90, 150)):
                rows.append(dict(pair=pair, user=0, variant=variant, ok=True, bytes=120,
                                 digest="identical", httpMs=dispatch, backendMs=dispatch - 10,
                                 scheduledMs=scheduled, delayMs=scheduled - dispatch))
        report = boundaries(rows, expected_pairs=30, users=1)
        self.assertEqual(report["httpMs"]["status"], "pass")
        self.assertEqual(report["scheduledMs"]["status"], "fail")
        rows[-1]["digest"] = "different"
        self.assertEqual(boundaries(rows, expected_pairs=30, users=1)["httpMs"]["status"], "fail")


class D1BudgetTests(unittest.TestCase):
    def test_unknown_and_exceeded_request_cost_fence_later_work_across_processes(self):
        from budget import Ledger, Refused
        from pathlib import Path
        from tempfile import TemporaryDirectory

        for cost in (None, {"rowsRead": 60, "rowsWritten": 4}):
            with self.subTest(cost=cost), TemporaryDirectory() as tmp:
                directory = Path(tmp)
                decision = {"_tag": "Allowed", "maximumRowsRead": 100, "maximumRowsWritten": 10}
                account = "a" * 32
                ceiling = {"rowsRead": 50, "rowsWritten": 5}
                with Ledger(directory, account, decision) as budget:
                    with self.assertRaises(Refused):
                        budget.batch("transaction-read", ceiling, lambda: cost)
                with self.assertRaises(Refused):
                    with Ledger(directory, account, decision):
                        self.fail("The account should remain fenced")
