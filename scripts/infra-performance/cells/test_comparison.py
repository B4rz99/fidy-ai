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


class SurveyTests(unittest.TestCase):
    def test_timed_shapes_keep_their_own_pair_counts_and_refuse_payload_drift(self):
        from rehearse import survey_timing_results

        shapes = ("transactions.maximum", "review.counts", "budgets.currency")
        rows = [
            dict(operation=shape, pair=pair, user=0, variant=variant, ok=True,
                 bytes=120, digest=shape, httpMs=duration, scheduledMs=duration)
            for shape, count in zip(shapes, (30, 30, 29))
            for pair in range(count)
            for variant, duration in (("d1", 18), ("do", 10))
        ]
        rows[119]["digest"] = "different"
        result = survey_timing_results(rows, shapes, 30)
        self.assertEqual(result["transactions.maximum"]["httpMs"]["status"], "pass")
        self.assertEqual(result["transactions.maximum"]["backendMs"]["status"], "missing")
        self.assertEqual(result["review.counts"]["httpMs"]["status"], "fail")
        self.assertEqual(result["budgets.currency"]["httpMs"]["status"], "missing")

    def test_prepared_dashboard_compares_all_fields_except_its_observation_time(self):
        from rehearse import survey_read
        from unittest.mock import Mock

        subject = Mock()
        subject.canonical.side_effect = [
            (200, {}, b'{"data":{"context":{"calculatedAt":"first"},"value":7}}'),
            (200, {}, b'{"data":{"context":{"calculatedAt":"later"},"value":7}}'),
            (200, {}, b'{"data":{"context":{"calculatedAt":"later"},"value":8}}'),
        ]
        first, later, changed = [survey_read(subject, "/dashboard/view", meter=False) for _ in range(3)]
        self.assertNotEqual(first["sha256"], later["sha256"])
        self.assertEqual(first["comparableSha256"], later["comparableSha256"])
        self.assertNotEqual(first["comparableSha256"], changed["comparableSha256"])

    def test_refused_read_retains_its_observed_cost_without_counting_as_success(self):
        from rehearse import survey_read
        from unittest.mock import Mock

        subject = Mock()
        subject.control.side_effect = [b'{"rowsRead":7,"rowsWritten":3}',
                                       b'{"rowsRead":12,"rowsWritten":4}']
        subject.canonical.return_value = (429, {}, b'{"error":"rate_limited"}')
        row = survey_read(subject, "/dashboard/view", meter=True)
        self.assertEqual(row["status"], 429)
        self.assertEqual(row["cost"], {"rowsRead": 5, "rowsWritten": 1})
        self.assertEqual(row["bytes"], 24)
        self.assertNotIn("body", row)


class D1BudgetTests(unittest.TestCase):
    def test_unprepared_entry_reports_missing_evidence_without_credentials(self):
        import json
        import subprocess
        import sys
        from pathlib import Path
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as tmp:
            out = Path(tmp) / "evidence"
            reply = subprocess.run([sys.executable, str(Path(__file__).with_name("pilot.py")),
                                    "--bundle", str(Path(tmp) / "absent"), "--out", str(out)],
                                   env={}, capture_output=True, check=False)
            self.assertEqual(reply.returncode, 1)
            report = json.loads((out / "report.json").read_text())
            self.assertEqual(report["reason"], "verified_bundle_missing")
            self.assertEqual(report["attempts"], [])
