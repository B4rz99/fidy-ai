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
