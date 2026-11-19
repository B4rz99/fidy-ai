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
