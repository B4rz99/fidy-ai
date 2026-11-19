from contextlib import contextmanager
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from run import BOUNDARIES, compare, failure_metadata, observation


class ReferenceReport(unittest.TestCase):
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
            {"variant": variant, "status": "ok", "timings": {k: value for k in BOUNDARIES}}
            for value in range(1, samples + 1)
            for variant in ["d1", "do"]
        ]

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
        self.assertEqual(failed["read.http"]["do"]["completed"], 29)

    def test_stress_evidence_uses_no_comparative_gate(self):
        report = compare(30, self.rows(30), ["d1", "do"], stress=True)
        self.assertEqual(report["read.http"]["status"], "stress")
        self.assertNotIn("ratio", report["read.http"])


if __name__ == "__main__":
    unittest.main()
