from contextlib import contextmanager
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from run import BOUNDARIES, CALIBRATION_VIEWS, browser_workload, compare, failure_metadata, observation


class ReferenceReport(unittest.TestCase):
    def test_read_only_plan_and_report_cover_actual_startup_and_fresh_history(self):
        expected = {"startup.browser", "read.browser", "read.http", "read.backend"}
        plan = browser_workload("production", read_only=True)
        self.assertEqual(set(plan["boundaries"]), expected)
        self.assertNotIn("additionalCalibrationSetup", plan)
        report = compare(1, self.rows(1), ["d1", "do"], read_only=True)
        self.assertEqual(set(report), expected)
        self.assertEqual(report["read.browser"]["d1"]["completed"], 1)
        self.assertEqual(report["read.browser"]["status"], "missing")

    def test_extreme_manifest_declares_only_the_transaction_journeys_it_runs(self):
        plan = browser_workload("extreme")
        self.assertEqual(plan["boundaries"], BOUNDARIES)
        for key in ("additionalCalibrationSetup", "dashboardNormalization", "recurringHistory"):
            self.assertNotIn(key, plan)
        self.assertNotIn("Budget", plan["browserEnd"])
        self.assertNotIn("Additional views", plan["browserStart"])
        calibrated = browser_workload("production")
        self.assertEqual(calibrated["boundaries"], BOUNDARIES + CALIBRATION_VIEWS)
        self.assertIn("additionalCalibrationSetup", calibrated)
        self.assertIn("pending review", calibrated["browserEnd"])

    def test_diagnostics_select_only_fixed_labels_and_source_locations(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "api.log"
            log.write_text(
                "REFERENCE_STAGE transactions\nREFERENCE_STAGE private-verifier\n"
                "Error: FOREIGN KEY constraint failed; Bearer sensitive\n"
                "    at /runner/scripts/infra-performance/reference/native-seed.ts:39:12\n"
            )
            self.assertEqual(failure_metadata(log), {
                "stage": "transactions", "reason": "foreign-key",
                "source": "native-seed.ts:39:12",
            })

    def test_failed_canonical_response_exports_only_the_observed_method_and_status(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "browser.log"
            log.write_text(
                "REFERENCE_STAGE fresh-read\nREFERENCE_HTTP PUT 429\n"
                "REFERENCE_HTTP DELETE 403\nREFERENCE_HTTP GET 999\n"
                "REFERENCE_HTTP GET 401 Bearer sensitive\n"
            )
            self.assertEqual(failure_metadata(log), {
                "stage": "fresh-read", "httpMethod": "PUT", "httpStatus": 429,
            })

    def test_first_review_failure_survives_later_responses_with_allowlisted_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "browser.log"
            log.write_text(
                "REFERENCE_STAGE review-pending\n"
                "REFERENCE_HTTP GET 429 review-context rate_limited bucket\n"
                "REFERENCE_STAGE dashboard-fresh\nREFERENCE_HTTP GET 403\n"
            )
            self.assertEqual(failure_metadata(log), {
                "stage": "review-pending", "httpMethod": "GET", "httpStatus": 429,
                "reviewResponse": "review-context", "errorCode": "rate_limited",
                "pressureAfterResponse": "bucket",
            })
            log.write_text(
                "REFERENCE_STAGE review-pending\n"
                "REFERENCE_HTTP GET 429 review-context private-verifier bucket\n"
            )
            self.assertEqual(failure_metadata(log), {"stage": "review-pending"})

    def test_failed_preview_releases_native_fixture_images(self):
        images = []

        @contextmanager
        def preview(args, cwd, env, log):
            if "TMPDIR" in env:
                image = Path(env["TMPDIR"]) / "fixture.sqlite"
                image.touch()
                images.append(image)
            yield

        with tempfile.TemporaryDirectory() as destination:
            root = Path(destination)
            with patch("run.serve", preview), patch("run.prepare", side_effect=TimeoutError):
                with self.assertRaises(TimeoutError):
                    observation(root, {}, root)
            self.assertEqual(len(images), 1)
            self.assertFalse(images[0].parent.exists())

    def rows(self, samples):
        return [
            {"variant": variant, "pair": value - 1, "status": "ok", "timings": {k: value for k in BOUNDARIES + CALIBRATION_VIEWS}}
            for value in range(1, samples + 1)
            for variant in ["d1", "do"]
        ]

    def test_calibration_requires_fresh_month_navigation_on_both_installations(self):
        rows = self.rows(30)
        for row in rows:
            row["timings"]["budgets.month.browser"] = 200 if row["variant"] == "d1" else 100
        cells = compare(30, rows, ["d1", "do"], calibration=True)
        self.assertEqual(cells["budgets.month.browser"]["status"], "pass")
        self.assertEqual(cells["budgets.month.browser"]["do"]["completed"], 30)

    def test_pending_review_rejects_a_slow_click_to_usable_source_context(self):
        rows = self.rows(30)
        cells = compare(30, rows, ["d1", "do"], calibration=True)
        self.assertEqual(cells["review.pending.browser"]["status"], "fail")
        self.assertEqual(cells["review.pending.browser"]["d1"]["p95"], 29)

    def test_dashboard_fresh_view_requires_its_own_observations(self):
        report = compare(1, self.rows(1), ["d1", "do"], calibration=True)
        self.assertEqual(report["dashboard.fresh.browser"]["status"], "missing")
        self.assertEqual(report["dashboard.fresh.browser"]["d1"]["completed"], 1)

    def test_recurring_compact_selective_and_full_history_have_distinct_boundaries(self):
        report = compare(1, self.rows(1), ["d1", "do"], calibration=True)
        for key in ["recurring.month.browser", "recurring.selective.browser", "recurring.full.http"]:
            self.assertEqual(report[key]["d1"]["completed"], 1)
            self.assertEqual(report[key]["status"], "missing")
        self.assertEqual(report["recurring.full.browser"]["status"], "not-exposed")

    def test_no_match_recurring_search_has_its_own_browser_gate(self):
        key = "recurring.no-match.browser"
        self.assertIn(key, browser_workload("production")["boundaries"])
        rows = self.rows(30)
        for row in rows:
            row["timings"][key] = 190 if row["variant"] == "d1" else 110
        self.assertEqual(compare(30, rows, ["d1", "do"], calibration=True)[key]["status"], "fail")

    def test_partial_pair_keeps_completed_offered_and_unreached_views_separate(self):
        from run import observed_work
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "workspace-events.jsonl"
            log.write_text('{"stage":"post-setup-idle","elapsedMs":1000}\n'
                           '{"type":"d1-cost","stage":"verified-refresh","rowsWritten":23}\n'
                           '{"type":"offered","journey":"budgets.month.browser"}\n'
                           '{"type":"completed","journey":"budgets.month.browser"}\n'
                           '{"type":"offered","journey":"review.pending.browser"}\n'
                           '{"type":"failed","journey":"review.pending.browser"}\n')
            row = {"variant": "do", "pair": 0, "status": "failed", "work": observed_work(log)}
            report = compare(1, [row], ["do"], calibration=True)
        for name, offered, completed in [
            ("budgets.month.browser", 1, 1),
            ("review.pending.browser", 1, 0),
            ("recurring.month.browser", 0, 0),
        ]:
            self.assertEqual(report[name]["status"], "fail")
            counts = report[name]["do"]
            self.assertEqual((counts["planned"], counts["offered"], counts["completed"],
                              counts["comparable"]), (1, offered, completed, 0))

    def test_verified_timings_prove_completion_when_a_journal_lacks_that_event(self):
        rows = self.rows(1)
        for row in rows:
            row["work"] = {}
        cell = compare(1, rows, ["d1", "do"])["startup.browser"]
        self.assertEqual((cell["d1"]["offered"], cell["d1"]["completed"]), (1, 1))

    def test_archived_success_leaves_an_unmeasured_cell_missing(self):
        key = "recurring.no-match.browser"
        rows = self.rows(30)
        for row in rows:
            del row["timings"][key]
        cell = compare(30, rows, ["d1", "do"], calibration=True)[key]
        self.assertEqual(cell["status"], "missing")
        self.assertIsNone(cell["d1"]["offered"])
        self.assertEqual(cell["d1"]["comparable"], 0)

    def test_every_boundary_requires_the_minimum_paired_count(self):
        summary = compare(29, self.rows(29), ["d1", "do"])
        self.assertEqual(summary["read.http"]["status"], "missing")

    def test_nearest_rank_and_a_slow_cell_stay_visible(self):
        rows = self.rows(30)
        for row in rows:
            if row["variant"] == "d1":
                row["timings"]["read.http"] *= 2
        report = compare(30, rows, ["d1", "do"])
        self.assertEqual(report["read.http"]["d1"]["p95"], 58)
        self.assertEqual(report["read.http"]["status"], "pass")
        self.assertEqual(report["read.browser"]["status"], "fail")
        rows[-1]["status"] = "failed"
        failed = compare(30, rows, ["d1", "do"])
        self.assertEqual(failed["read.http"]["status"], "fail")
        self.assertEqual(failed["read.http"]["d1"]["comparable"], 29)
        self.assertEqual(failed["read.http"]["do"]["comparable"], 29)
        self.assertEqual(failed["read.http"]["do"]["completed"], 30)

    def test_stress_evidence_uses_no_comparative_gate(self):
        report = compare(30, self.rows(30), ["d1", "do"], stress=True)
        self.assertEqual(report["read.http"]["status"], "stress")
        self.assertNotIn("ratio", report["read.http"])


if __name__ == "__main__":
    unittest.main()
