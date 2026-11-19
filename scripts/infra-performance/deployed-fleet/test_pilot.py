import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pilot import Usage, admit, sample


class PilotBudget(unittest.TestCase):
    def test_full_account_counter_and_cleanup_reserve_precede_any_signup(self):
        noon = 12 * 60 * 60
        self.assertRaises(ValueError, admit, Usage(noon, noon, 0, 30000), noon)
        self.assertRaises(ValueError, admit, Usage(noon, noon - 601, 0, 0), noon)
        self.assertRaises(ValueError, admit, Usage(noon, noon, 0, 0), 86400 - 900)
        self.assertIsNone(admit(Usage(noon, noon, 12000, 1000), noon))


class CoverageEvidence(unittest.TestCase):
    def test_coverage_query_runs_without_persisting_the_results(self):
        from observations import observation
        def telemetry(path, body):
            self.assertEqual(path, "accounts/account/workers/observability/telemetry/query")
            self.assertIs(body.get("dry"), True)
            return {"success": True, "result": {"events": {"events": []}}}
        self.assertEqual(observation(telemetry, "account", "release", 0, 600000)["coverageEvents"], [])

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

    def test_an_empty_and_a_foreign_result_cannot_establish_coverage(self):
        from observations import COVERAGE, observation
        def lookup(events):
            return observation(lambda *_: {"success": True, "result": {"events": {"events": events}}},
                               "account", "expected", 0, 600000)
        self.assertEqual(lookup([])["firstWindowTicks"], 0)
        self.assertRaises(ValueError, lookup, [{
            "$workers": {"scriptName": "fidy-native-storage-core", "scriptVersion": {"id": "other"}},
            "$metadata": {"id": "other", "message": COVERAGE + "wrapped"}, "timestamp": 1,
        }])

class InstalledRelease(unittest.TestCase):
    def test_meter_records_runtime_and_verifier_separately_and_requires_two_installed_windows(self):
        deployed = "a" * 40
        verifier = "b" * 40
        now = 12 * 3600
        with tempfile.TemporaryDirectory() as root:
            receipt = Path(root) / "verification"
            env = {"GITHUB_REF": "refs/heads/trunk", "GITHUB_EVENT_NAME": "workflow_dispatch",
                   "NATIVE_STORAGE_ADMISSION": "closed", "RELEASE_GIT_SHA": verifier, "GITHUB_SHA": verifier, "FLEET_PILOT_STARTED_AT": str(now),
                   "EXPECTED_INSTALLED_REVISION": deployed, "RUNNER_TEMP": root,
                   "CLOUDFLARE_ACCOUNT_ID": "c" * 32, "SMOKE_ATTESTATION_FILE": str(receipt)}
            start = (now - 610) * 1000
            evidence = {"revision": deployed, "verifierRevision": verifier, "coreVersion": "core",
                        "events": [{"stage": "observation-start", "at": start},
                                   {"stage": "observation-end", "at": start + 600_000}]}
            attestation = Path(str(receipt) + ".fleet")
            attestation.write_text(json.dumps(evidence))
            with patch.dict(os.environ, env, clear=True), patch("pilot.time.time", return_value=now), \
                    patch("pilot.usage", return_value=Usage(now, now, 10_000, 2_000)) as read:
                self.assertRaises(ValueError, sample, "begin", verifier)
                read.assert_not_called()
                sample("begin", deployed)
                sample("check", deployed)
                # Fresh samples just before enrollment must leave room for all remaining phases.
                sample("signup", deployed)
                with patch("pilot.usage", return_value=Usage(now, now, 12_000, 7_000)):
                    self.assertRaises(ValueError, sample, "signup", deployed)
                with patch.dict(os.environ, {"FLEET_PILOT_STARTED_AT": str(now - 26 * 60)}):
                    self.assertRaises(ValueError, sample, "signup", deployed)
                with patch.dict(os.environ, {"FLEET_PILOT_STARTED_AT": str(now - 67 * 60)}):
                    self.assertRaises(ValueError, sample, "check", deployed)
                    sample("cleanup", deployed)
                with patch("pilot.usage", return_value=Usage(now, now, 12_000, 80_000)):
                    self.assertRaises(ValueError, sample, "cleanup", deployed)
                with patch("pilot.observation", return_value={"firstWindowWraps": 1, "secondWindowWraps": 0}):
                    self.assertRaises(ValueError, sample, "logs", deployed)
                with patch("pilot.observation", return_value={"firstWindowWraps": 1, "secondWindowWraps": 1}) as query:
                    sample("logs", deployed)
                    self.assertEqual(query.call_args.args[2:], ("core", start, start + 600_000))
                    attestation.write_text(json.dumps({**evidence, "revision": verifier}))
                    self.assertRaises(ValueError, sample, "logs", deployed)
                    self.assertEqual(query.call_count, 1)
                with patch("pilot.usage", return_value=Usage(now, now, 10_500, 2_100)):
                    sample("finish", deployed, str(now * 1000))
            rows = [json.loads(line) for line in (Path(root) / "native-fleet-meter.jsonl").read_text().splitlines()]
            self.assertTrue(all(row["revision"] == deployed and row["verifierRevision"] == verifier for row in rows))
            self.assertEqual((rows[-1]["stage"], rows[-1]["reads"], rows[-1]["writes"]), ("delta", 500, 100))
