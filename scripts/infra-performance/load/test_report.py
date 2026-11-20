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

    def test_an_incomplete_response_breaks_the_entire_comparison(self):
        rows = [dict(variant=variant, user=0, sample=sample, ok=True, status=200,
                     dispatchMs=2, scheduledMs=2, bytes=20, digest="complete")
                for sample in range(30) for variant in ("d1", "do")]
        rows[-1].update(ok=False, status=429)
        report = summarize(rows, 1, 30)
        self.assertEqual(report["do"]["throttled"], 1)
        self.assertEqual(report["dispatchMs"]["status"], "fail")
        self.assertEqual(report["do"]["incomplete"], 1)

    def test_rollback_keeps_financial_equivalence_and_audit_failure_separately_visible(self):
        rows = [dict(variant=variant, user=0, sample=sample, ok=True, status=200,
                     dispatchMs=3, scheduledMs=3, bytes=100, digest="refusal-and-fresh-history")
                for sample in range(30) for variant in ("d1", "do")]
        report = summarize(rows, 1, 30, audit=False)
        self.assertEqual(report["pairedPayloadsMatch"], True)
        self.assertEqual(report["auditMatches"], False)
        self.assertEqual(report["scheduledMs"]["status"], "fail")

    def test_missing_retained_fixture_verification_withholds_a_latency_pass(self):
        rows = [dict(variant=variant, user=0, sample=sample, ok=True, status=200,
                     dispatchMs=6 if variant == "d1" else 2, scheduledMs=6 if variant == "d1" else 2,
                     bytes=100, digest="history")
                for sample in range(30) for variant in ("d1", "do")]
        result = summarize(rows, 1, 30, fixture=False)
        self.assertFalse(result["fixtureVerified"])
        self.assertEqual(result["dispatchMs"]["status"], "fail")

    def test_offered_history_requires_the_prescribed_cadence_for_every_user_and_block(self):
        rows = []
        for block, order in enumerate((("d1", "do"), ("do", "d1"))):
            for position, variant in enumerate(order):
                for sample in range(15):
                    for user in range(20):
                        scheduled = (2 * block + position) * 20_000 + sample * 1000 + user * 50
                        latency = 8 if variant == "d1" else 2
                        rows.append(dict(variant=variant, user=user, sample=sample + block * 15,
                                         scheduled=scheduled, dispatched=scheduled + 1,
                                         completedAt=scheduled + 1 + latency, status=200, ok=True,
                                         dispatchMs=latency, scheduledMs=latency + 1,
                                         bytes=100, digest="history"))
        def report():
            return summarize(rows, 20, 30, offered_history=True)
        self.assertEqual(report()["scheduledMs"]["status"], "pass")
        self.assertEqual(report()["do"]["dispatchDelayMs"]["p95"], 1)
        # A row offered a second late can have fast timings but misses its User's declared slot.
        row = rows[-1]
        for key in ("scheduled", "dispatched", "completedAt"):
            row[key] += 1000
        self.assertEqual(report()["scheduledMs"]["status"], "fail")
        self.assertFalse(report()["offeredScheduleVerified"])
        for key in ("scheduled", "dispatched", "completedAt"):
            row[key] -= 1000
        # Dispatching the offer early would also defeat the scheduled-completion boundary.
        row["dispatched"] -= 100
        row["dispatchMs"] += 100
        self.assertEqual(report()["scheduledMs"]["status"], "fail")
        del row["scheduled"]
        self.assertEqual(report()["scheduledMs"]["status"], "missing")
