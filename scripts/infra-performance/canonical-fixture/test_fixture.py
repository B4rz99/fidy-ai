import unittest
from fixture import validate_originals


class FixtureTests(unittest.TestCase):
    def test_foreign_history_cannot_be_adopted_as_the_synthetic_fixture(self):
        with self.assertRaises(ValueError):
            validate_originals([{"id": "a", "counterparty": "unrelated"}] * 8)
