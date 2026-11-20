import unittest

from report import summarize


class OfferedLoadEvidence(unittest.TestCase):
    def test_slow_scheduled_completions_fail_even_when_dispatch_is_fast(self):
        rows = [
            dict(variant=variant, user=user, sample=sample, ok=True, status=200,
                 dispatchMs=dispatch, scheduledMs=scheduled, bytes=320, digest=str(user))
            for sample in range(30) for user in range(20)
            for variant, dispatch, scheduled in (("d1", 90, 100), ("do", 40, 110))
        ]
        result = summarize(rows, users=20, samples=30)
        self.assertEqual("pass", result["dispatchMs"]["status"])
        self.assertEqual("fail", result["scheduledMs"]["status"])
        self.assertEqual(600, result["d1"]["completed"])
        rows[-1]["user"] = 0
        self.assertEqual("missing", summarize(rows, users=20, samples=30)["dispatchMs"]["status"])
