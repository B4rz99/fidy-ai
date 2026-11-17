import json
from pathlib import Path
import subprocess
import sys
import tempfile
from run import execute
import unittest

HERE = Path(__file__).resolve().parent


class CalibrationTests(unittest.TestCase):
    def test_dry_run_verifies_the_pinned_fixture_and_estimates_every_batch(self):
        result = subprocess.run(
            [sys.executable, str(HERE / "run.py")], text=True, capture_output=True, check=True
        )
        report = json.loads(Path(result.stdout.strip()).read_text())
        self.assertEqual(report["status"], "rehearsed")
        self.assertEqual(report["baseline"], "fb53d9e755c14393048dc945fc0b7f117730d872")
        self.assertEqual(report["verified"], dict(transactions=8, currencies=2,
            effectiveTransactions=7, links=1, plans=2, revisions=4, review=4))
        self.assertGreater(report["estimate"]["rowsRead"], report["native"]["rowsRead"])
        self.assertLessEqual(report["estimate"]["rowsWritten"], 5_000)
        self.assertEqual(report["batches"], 99)


class NativeService:
    account = "a" * 32
    database = "99077dd6-86fd-4725-8d31-94929951babb"

    def __init__(self, fault=None):
        self.fault = fault
        self.calls = []
        self.name = None
        self.cost = 0

    def call(self, method, path, data=None):
        self.calls.append((method, path))
        if path == "graphql" and self.fault == "missing-usage":
            return {"data": {"viewer": {"accounts": []}}}
        if path == "graphql":
            return {"data":{"viewer":{"accounts":[{"d1AnalyticsAdaptiveGroups":[{"sum": {"rowsRead": 10, "rowsWritten": 10}}]}]}}}
        if path.endswith("/database") and method == "POST":
            self.name = data["name"]
            return {"success": True, "result": {"name": self.name, "uuid": self.database}}
        if path.endswith("/query"):
            self.cost += 1
            return {"success":True, "result":[{"success":True, "meta": {} if self.fault=="unknown-cost" else {"rows_read":2,"rows_written":1},
                    "results":[{"verified":8}] if self.fault!="wrong-result" else []}]}
        if method == "GET" and path.endswith(self.database):
            return {"success":True, "result":{"uuid": self.database, "name":"live-product" if self.fault=="foreign" else self.name}}
        if method == "DELETE":
            return {"success":True}
        if method == "GET" and "?name=" in path:
            return {"success":True, "result":[]}
        raise AssertionError(self.calls)


class HostedExecutionTests(unittest.TestCase):
    def run_fixture(self, service, directory):
        plan = {"verified":{"verified":8},"batches":[{"reads":2,"writes":1,"batch":[{"sql":"SELECT 8 AS verified","params":[]}]}]}
        return execute(service, plan, {"planSha256":"p"}, directory / "report.json", directory / "journal.json")

    def test_counts_native_metadata_and_independently_verifies_deletion(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            service = NativeService()
            self.run_fixture(service, directory)
            report = json.loads((directory / "report.json").read_text())
            self.assertTrue(report["deletionVerified"])
            self.assertEqual(report["status"], "passed")
            self.assertEqual(report["actual"], {"rowsRead":2,"rowsWritten":1})
            self.assertEqual(report["attempts"][0]["status"], "returned")
            self.assertIn(("DELETE", "accounts/" + service.account + "/d1/database/" + service.database), service.calls)

    def test_refuses_to_touch_a_database_whose_created_identity_cannot_be_verified(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            service = NativeService("foreign")
            with self.assertRaises(RuntimeError):
                self.run_fixture(service, directory)
            self.assertFalse(any(path.endswith("/query") or method == "DELETE" for method,path in service.calls))
            self.assertFalse(json.loads((directory / "report.json").read_text())["deletionVerified"])

    def test_budget_and_analytics_refusals_precede_database_creation(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            missing = NativeService("missing-usage")
            with self.assertRaises(RuntimeError):
                self.run_fixture(missing, directory)
            self.assertEqual(missing.calls, [("POST", "graphql")])

            from run import today
            journal = {"day": today(), "spent": {"rowsRead": 100000, "rowsWritten": 5000}, "observed": {}}
            (directory / "journal.json").write_text(json.dumps(journal))
            spent = NativeService()
            with self.assertRaises(RuntimeError):
                self.run_fixture(spent, directory)
            self.assertEqual(spent.calls, [("POST", "graphql")])

    def test_mismatched_domain_result_is_a_failed_attempt_with_verified_cleanup(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            service = NativeService("wrong-result")
            with self.assertRaises(RuntimeError):
                self.run_fixture(service, directory)
            report = json.loads((directory / "report.json").read_text())
            self.assertEqual(report["status"], "failed")
            self.assertTrue(report["deletionVerified"])

    def test_missing_native_counters_fence_retries_but_still_allow_verified_cleanup(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            service = NativeService("unknown-cost")
            with self.assertRaises(RuntimeError):
                self.run_fixture(service, directory)
            self.assertTrue(json.loads((directory / "report.json").read_text())["deletionVerified"])
            second = NativeService()
            with self.assertRaises(RuntimeError):
                self.run_fixture(second, directory)
            self.assertFalse(second.calls)

if __name__ == "__main__":
    unittest.main()
