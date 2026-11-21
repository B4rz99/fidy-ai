import unittest

from canonical_activity import CORE, outcomes

VERSION = "native-core-version"
START = 1_000
NOW = 9_000


def event(message, event_id, timestamp, version=VERSION):
    return {"$metadata": {"id": event_id, "message": message},
            "$workers": {"scriptName": CORE, "scriptVersion": {"id": version}},
            "timestamp": timestamp, "source": {"private": "must not appear in proof"}}


class CanonicalActivityTest(unittest.TestCase):
    def test_live_provider_and_background_observations_share_the_opened_core(self):
        opening = {"openedAt": "1970-01-01T00:00:01Z",
                   "workers": {CORE: {"version": VERSION}}}
        signup = event("fidy.operational component=canonical-signup operation=google state=created", "event-1", 2_000)
        traversal = event("fidy.operational component=inspection-coverage operation=ownerInspections state=complete",
                          "event-2", 3_000)
        def read(path, body):
            self.assertEqual(path, "accounts/account/workers/observability/telemetry/query")
            self.assertIs(body["dry"], True)
            self.assertEqual(body["parameters"]["filters"][1]["value"], VERSION)
            since = body["timeframe"]["from"]
            self.assertIn(since, (START, 2_000))
            rows = [signup] if since == START else [traversal]
            return {"success": True, "result": {"events": {"events": rows}}}

        def canary(account, since, until):
            self.assertEqual((account, since, until), ("account", 2_000, NOW))
            return "operational-canary-1"

        proof = outcomes(opening, "account", NOW, read, canary)
        self.assertEqual(set(proof), {"provider", "signupDigest", "background"})
        self.assertIs(proof["background"]["watchdogCompleted"], True)
        self.assertIs(proof["background"]["canaryCompleted"], True)
        self.assertNotIn("recovery", proof)

        signup["$workers"]["scriptVersion"]["id"] = "foreign"
        with self.assertRaisesRegex(ValueError, "Unexpected event"):
            outcomes(opening, "account", NOW, read, canary)
