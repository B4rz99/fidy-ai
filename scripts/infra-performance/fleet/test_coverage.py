import unittest

from coverage_report import coverage


class FleetCoverage(unittest.TestCase):
    def test_rolling_gap_can_fail_even_when_both_fixed_windows_include_the_owner(self):
        result = coverage({"idle": 0, "new": 400_000}, [
            {"name": "idle", "at": 10, "status": 503},
            {"name": "idle", "at": 320_000, "status": 204},
            {"name": "new", "at": 590_000, "status": 204},
        ], 0, 600_000)
        self.assertEqual(result["eligibleOwners"], 2)
        self.assertEqual(result["attemptedOwners"], 2)
        self.assertEqual(result["lateOwners"], ["idle"])
        self.assertEqual(result["maximumGapMs"], 319_990)

    def test_unanswered_check_counts_and_the_last_uncovered_interval_is_measured(self):
        result = coverage({"unknown": 0, "missed": 0}, [
            {"name": "unknown", "at": 300_000, "status": None},
        ], 0, 600_000)
        self.assertEqual(result["attemptedOwners"], 1)
        self.assertEqual(result["lateOwners"], ["missed"])
        self.assertEqual(result["maximumGapMs"], 600_000)
