import unittest
from run import BOUNDARIES, compare


class ReferenceReport(unittest.TestCase):
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
