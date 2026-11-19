import copy
import unittest

from budget import Refused, today
from owner_state import AccountExperiment


class ConditionalObject:
    def __init__(self):
        self.value = None
        self.version = 0

    def read(self):
        return self.version, copy.deepcopy(self.value)

    def replace(self, version, value):
        if version != self.version:
            raise Refused('stale account ledger')
        self.value = copy.deepcopy(value)
        self.version += 1
        return self.version


class OwnerTests(unittest.TestCase):
    def test_interrupted_reservation_survives_runner_loss_and_refuses_replay(self):
        obj = ConditionalObject()
        account, prefix = 'a' * 32, 'fidy-2259-123456abcdef'
        maximum = dict(rowsRead=18000, rowsWritten=4754)
        decision = dict(_tag='Allowed', maximumRowsRead=18000, maximumRowsWritten=4754)
        first = AccountExperiment(obj, account)
        contender = AccountExperiment(obj, account)
        first.begin(prefix, decision, today())
        with self.assertRaises(Refused):
            contender.begin('fidy-2259-abcdef123456', decision, today())
        def lost():
            raise TimeoutError()
        with self.assertRaises(TimeoutError):
            first.batch('materialize-0', maximum, lost)
        restored = AccountExperiment(obj, account)
        self.assertEqual(restored.active['pending']['name'], 'materialize-0')
        with self.assertRaises(Refused):
            restored.batch('materialize-0', maximum, lambda: self.fail('replayed'))
        with self.assertRaises(Refused):
            restored.begin('fidy-2259-abcdef123456', decision, today())

    def test_cleaned_uncertain_read_cannot_be_retried_under_another_name(self):
        from owner import teardown
        from types import SimpleNamespace

        account, prefix = 'a'*32, 'fidy-2259-123456abcdef'
        obj = ConditionalObject()
        owner = AccountExperiment(obj,account)
        decision = dict(_tag='Allowed', maximumRowsRead=200, maximumRowsWritten=20)
        owner.begin(prefix, decision, today())
        with self.assertRaises(Refused):
            owner.batch('history', dict(rowsRead=90,rowsWritten=9), lambda:None)
        teardown(owner, SimpleNamespace(prefix=prefix,namespaces=lambda: []))
        fresh = AccountExperiment(obj,account)
        with self.assertRaises(Refused):
            fresh.begin('fidy-2259-abcdef123456',decision,today())

    def test_reconciled_work_and_another_run_share_the_full_account_estimate(self):
        from owner import teardown
        from types import SimpleNamespace

        account, prefix = 'a'*32, 'fidy-2259-123456abcdef'
        obj = ConditionalObject()
        first = AccountExperiment(obj,account)
        first.begin(prefix,dict(_tag='Allowed',maximumRowsRead=200,maximumRowsWritten=20),today())
        first.batch('history',dict(rowsRead=100,rowsWritten=12),lambda:dict(rowsRead=44,rowsWritten=5))
        teardown(first,SimpleNamespace(prefix=prefix,namespaces=lambda: []))
        next_run = AccountExperiment(obj,account)
        self.assertEqual(next_run.full_estimate(dict(rowsRead=100,rowsWritten=20), today()),
                         dict(rowsRead=144,rowsWritten=25))
        next_run.begin('fidy-2259-abcdef123456',dict(_tag='Allowed',maximumRowsRead=144,maximumRowsWritten=25),today())
        with self.assertRaises(Refused):
            next_run.batch('outside-ceiling',dict(rowsRead=100,rowsWritten=21),lambda:self.fail('dispatched'))
