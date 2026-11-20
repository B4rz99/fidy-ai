import unittest

from report import summarize, two_tab_evidence


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

    def test_candidate_only_capacity_preserves_the_missing_original_comparator(self):
        rows = [dict(variant="do", user=u, sample=s, scheduled=s * 1000 + u * 50,
                     dispatched=s * 1000 + u * 50 + 1, completedAt=s * 1000 + u * 50 + 6,
                     dispatchMs=5, scheduledMs=6, bytes=100, digest=str(u), status=200, ok=True)
                for s in range(30) for u in range(20)]
        def report(retained):
            return summarize(rows, 20, 30, audit=True, fixture=retained,
                             offered_history=True, native_only=True)
        self.assertEqual(report(True)["nativeWorkload"], "pass")
        self.assertEqual(report(True)["scheduledMs"], dict(ratio=None, status="missing"))
        self.assertEqual(report(False)["nativeWorkload"], "fail")
        rows.pop()
        self.assertEqual(report(True)["nativeWorkload"], "missing")

    def test_tail_attribution_uses_the_same_responses_and_preserves_missing_spans(self):
        from report import history_spans
        rows = [dict(variant="do", cell="history", user=0, sample=n, ok=True, dispatchMs=n + 1)
                for n in range(30)]
        spans = [dict(variant="do", cell="history", user=0, sample=n,
                      responses=[dict(ingressMs=n, coreMs=n - 1 if n else 0)])
                 for n in range(29)]
        report = history_spans(rows, spans)["do"]
        self.assertEqual(report["eligible"], 30)
        self.assertEqual(report["matched"], 29)
        self.assertEqual(report["dispatchTail"]["eligible"], 2)
        self.assertEqual(report["dispatchTail"]["matched"], 1)
        self.assertEqual(report["dispatchTail"]["coreMs"]["p95"], 27)


    def test_same_session_requires_both_calls_to_be_in_flight_together(self):
        rows = [
            dict(variant=variant, user=0, sample=sample, ok=True,
                 dispatchMs=latency, scheduledMs=latency, bytes=100, digest="both histories",
                 dispatched=100, completedAt=100 + latency, responses=[
                     dict(status=200, dispatched=100, completedAt=100 + latency - 1),
                     dict(status=200, dispatched=101, completedAt=100 + latency),
                 ])
            for sample in range(30) for variant, latency in (("d1", 12), ("do", 4))
        ]
        def report():
            result = summarize(rows, 1, 30)
            two_tab_evidence(result, rows, 30)
            return result
        result = report()
        self.assertTrue(result["sameSessionOverlap"]["verified"])
        self.assertEqual(result["sameSessionOverlap"]["do"]["readDispatchMs"]["p95"], 3)
        # Correct, fast responses alone cannot establish that the calls overlapped.
        rows[-1]["responses"][1]["dispatched"] = 103
        result = report()
        self.assertEqual(result["sameSessionOverlap"]["do"]["overlappingPairs"], 29)
        self.assertEqual(result["dispatchMs"]["status"], "fail")
        del rows[-1]["dispatched"]
        self.assertFalse(report()["sameSessionOverlap"]["verified"])
