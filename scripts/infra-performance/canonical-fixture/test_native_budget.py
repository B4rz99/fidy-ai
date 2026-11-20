from dataclasses import asdict
import unittest
from unittest.mock import patch

from protected_cohort import protected_runner
from native_budget import Usage, R2_OPERATIONS, MAX_R2_OPERATIONS, COHORT_WRITES, check, r2_usage, r2_room, iso


class NativeBudgetTests(unittest.TestCase):
    def test_small_fixture_reserves_its_foreground_and_cleanup_inside_the_daily_limit(self):
        now = 1795107000
        def sample(reads, writes):
            return {"sqlite": asdict(Usage(now, now, reads, writes)), "r2": {
                "requests": 10, "todayRequests": 10, "upperBoundBytes": 100}}
        # 5M daily minus 2.5M reserved for other work and 750k for this fixture.
        # 100k daily minus 10k for other work and 30k for this fixture.
        base = sample(1_750_000, 60_000)
        check(base, base, "begin", now)
        for over in (sample(1_750_001, 60_000), sample(1_750_000, 60_001)):
            with self.assertRaises(ValueError):
                check(over, over, "begin", now)
        check(base, sample(2_250_000, 80_000), "foreground", now)
        for over in (sample(2_250_001, 80_000), sample(2_250_000, 80_001)):
            with self.assertRaises(ValueError):
                check(base, over, "foreground", now)
        check(base, sample(2_500_000, 90_000), "finish", now)

    def test_no_protected_workflow_or_no_fresh_account_rows_refuses(self):
        with patch.dict("os.environ", clear=True), self.assertRaisesRegex(ValueError, "protected"):
            protected_runner()
        now = 1795107000
        base = {"sqlite": asdict(Usage(now, now, 100, 100)), "r2":{"todayRequests":100,"requests":200,"upperBoundBytes":100}}
        check(base, base, "begin", now)
        for current in [Usage(now, now-601, 100, 100), Usage(now, now, 100, 95),
                        Usage(now, now, 100, COHORT_WRITES)]:
            with self.subTest(current=current), self.assertRaises(ValueError):
                check(base, {**base, "sqlite": asdict(current)}, "foreground", now)

    def test_r2_shared_account_requires_storage_and_operations_headroom(self):
        now, account = 1795107000, "a"*32
        row = dict(accountTag=account, total=[dict(sum=dict(requests=100))], today=[dict(sum=dict(requests=30))],
                   latest=[dict(dimensions=dict(datetime=iso(now)))],
                   storage=[dict(dimensions=dict(bucketName="fidy-native-release-smoke"),
                                 max=dict(payloadSize=1,metadataSize=2))])
        def sample(example):
            return r2_usage(lambda *_: {"viewer":{"accounts":[example]}},account,now)
        self.assertEqual(sample(row)["upperBoundBytes"], 3)
        for field, value in [
            ("accountTag", "b"*32), ("storage", []), ("total", []),
            ("total", [dict(sum=dict(requests=MAX_R2_OPERATIONS-R2_OPERATIONS+1))]),
            ("latest", [dict(dimensions=dict(datetime=iso(now-601)))]),
            ("storage",[dict(dimensions=dict(bucketName="fidy-native-release-smoke"),
                             max=dict(payloadSize=10_000_000_000,metadataSize=0))]),
        ]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                r2_room(sample({**row,field:value}), R2_OPERATIONS, 1_048_576)

    def test_next_day_cleanup_can_reserve_only_its_bounded_recovery_work(self):
        from native_budget import recovery_reservation
        now = 1795107000
        original = {"sqlite":asdict(Usage(now-86400,now-86400,100,100))}
        current = {"sqlite":asdict(Usage(now,now,200,300)), "r2":{"requests":100,"upperBoundBytes":100}}
        self.assertEqual(recovery_reservation(original,current,now),current)
        with self.assertRaises(ValueError):
            recovery_reservation(original,{**current,"sqlite":asdict(Usage(now,now,200,99_000))},now)

    def test_native_cleanup_can_spend_its_already_reserved_r2_operations(self):
        now = 1795107000
        initial = dict(sqlite=asdict(Usage(now,now,100,100)),r2=dict(
            todayRequests=42,requests=MAX_R2_OPERATIONS-R2_OPERATIONS,upperBoundBytes=50))
        current = dict(sqlite=asdict(Usage(now,now,200,140)),r2=dict(
            todayRequests=142,requests=MAX_R2_OPERATIONS-R2_OPERATIONS+100,upperBoundBytes=60))
        check(initial,initial,"begin",now)
        check(initial,current,"cleanup",now)
        with self.assertRaises(ValueError):
            check(current,current,"begin",now)
