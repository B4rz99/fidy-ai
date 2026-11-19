import unittest

from pilot import Usage, admit


class PilotBudget(unittest.TestCase):
    def test_full_account_counter_and_cleanup_reserve_precede_any_signup(self):
        noon = 12 * 60 * 60
        self.assertRaises(ValueError, admit, Usage(noon, noon, 0, 30000), noon)
        self.assertRaises(ValueError, admit, Usage(noon, noon - 601, 0, 0), noon)
        self.assertRaises(ValueError, admit, Usage(noon, noon, 0, 0), 86400 - 900)
        self.assertIsNone(admit(Usage(noon, noon, 12000, 1000), noon))
