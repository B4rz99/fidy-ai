from dataclasses import asdict
import unittest
from unittest.mock import patch

from protected_cohort import protected_runner
from native_budget import Usage, R2_OPERATIONS, MAX_R2_OPERATIONS, PILOT_WRITES, check, r2_usage, iso


class NativeBudgetTests(unittest.TestCase):
    def test_no_protected_workflow_or_no_fresh_account_rows_refuses(self):
        with patch.dict("os.environ", clear=True), self.assertRaisesRegex(ValueError, "protected"):
            protected_runner()
        now = 1795107000
        base = {"sqlite": asdict(Usage(now, now, 100, 100)), "r2":{"todayRequests":100}}
        check(base, base, "begin", now)
        for current in [Usage(now, now-601, 100, 100), Usage(now, now, 100, 95),
                        Usage(now, now, 100, PILOT_WRITES)]:
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
                sample({**row,field:value})

    def test_next_day_cleanup_can_reserve_only_its_bounded_recovery_work(self):
        from native_budget import recovery_reservation
        now = 1795107000
        original = {"sqlite":asdict(Usage(now-86400,now-86400,100,100))}
        current = {"sqlite":asdict(Usage(now,now,200,300))}
        self.assertEqual(recovery_reservation(original,current,now),current)
        with self.assertRaises(ValueError):
            recovery_reservation(original,{"sqlite":asdict(Usage(now,now,200,99_000))},now)
