import unittest

from pilot import Usage, admit


class PilotBudget(unittest.TestCase):
    def test_full_account_counter_and_cleanup_reserve_precede_any_signup(self):
        noon = 12 * 60 * 60
        self.assertRaises(ValueError, admit, Usage(noon, noon, 0, 30000), noon)
        self.assertRaises(ValueError, admit, Usage(noon, noon - 601, 0, 0), noon)
        self.assertRaises(ValueError, admit, Usage(noon, noon, 0, 0), 86400 - 900)
        self.assertIsNone(admit(Usage(noon, noon, 12000, 1000), noon))


class CoverageEvidence(unittest.TestCase):
    def test_preserves_aggregate_probe_outcomes_and_emits_only_allowlisted_fields(self):
        from observations import COVERAGE, observation
        event = {
            "$metadata": {"id": "evt1", "message": COVERAGE + "wrapped severity=none"},
            "$workers": {"scriptName": "fidy-native-storage-core", "scriptVersion": {"id": "version"}},
            "timestamp": 1000,
            "source": {"attempted": 4, "observed": 3, "failed": 0, "unknown": 1,
                       "unsupported": 0, "repaired": 1, "private": "never retain"},
        }
        data = observation(lambda *_: {"success": True, "result": {"events": {"events": [event]}}},
                           "account", "version", 0, 600000)
        self.assertEqual(data["coverageEvents"][0], {
            "at": 1000, "halt": "wrapped", "attempted": 4, "observed": 3, "failed": 0,
            "unknown": 1, "unsupported": 0, "repaired": 1})
        self.assertIsNone(data["completedWatchdogRecoveries"])
