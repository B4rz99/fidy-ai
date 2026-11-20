import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from observations import COVERAGE, observation
from pilot import Usage, sample
from ten import ORDINALS, coverage, require_ten_room, written_objects


class TenCoverage(unittest.TestCase):
    start = 12 * 3600 * 1000
    def setUp(self):
        self.events = [{"stage": "member-bound", "ordinal": n, "at": self.start - 1} for n in ORDINALS]
        self.events += [{"stage":"signup-created","ordinal":n,"at":self.start-2000} for n in ORDINALS]
        self.evidence = {"requestedPilotUsers":10,"members":[{"ordinal":n,"user":f"00000000-0000-4000-8000-{n:012}",
                                "physical":f"{n:064x}"} for n in ORDINALS],"survivors":[],"baseline":[],"events":self.events}
        self.events += [{"stage":"observation-start", "at":self.start},
                        {"stage":"observation-end", "at":self.start + 604_834}]
        self.rows = []
        for i in range(10):
            at = self.start + i * 60_000 + 3000
            self.rows.append({"timestamp":at, "$metadata":{"id":str(i), "message":COVERAGE+"wrapped severity=none"},
                              "$workers":{"scriptName":"fidy-native-storage-core", "scriptVersion":{"id":"core"}},
                              "source":{"admitted":16, "attempted":16, "observed":14, "failed":1, "unknown":1,
                                        "unsupported":0, "repaired":2, "wraps":11+i, "wrapped_at":at-5}})
    def reduce(self):
        def get(start, end):
            return observation(lambda *_: {"success":True, "result":{"events":{"events":self.rows}}},
                               "account", "core", start, end, fleet=True)
        return coverage(self.evidence, get)

    def test_each_window_contains_an_entire_traversal_and_keeps_real_probe_outcomes(self):
        result = self.reduce()
        self.assertEqual(result["windows"], [{"admitted":80,"attempted":80,"observed":70,"failed":5,
                              "unknown":5,"unsupported":0,"repaired":10,"wraps":5}]*2)
        self.assertIsNone(result["individualAttempts"])
        self.assertIsNone(result["completedWatchdogRecoveries"])

    def test_partial_missing_duplicate_ticks_or_missing_cohort_refuse(self):
        for mutate in [
            lambda: self.rows.pop(2),
            lambda: self.rows.append(self.rows[0]),
            lambda: self.rows[1]["source"].pop("wraps"),
            lambda: self.rows[2]["source"].update(wraps=12),
            lambda: self.rows[2]["source"].update(admitted=17),
            lambda: self.rows[2]["source"].update(unknown=0),
            lambda: self.rows[2]["source"].update(admitted=14,attempted=14,observed=12),
            lambda: self.rows[0]["$metadata"].update(message=COVERAGE+"capacity severity=none"),
            lambda: self.rows[1]["source"].update(wrapped_at=self.start - 1),
            lambda: self.rows.__delitem__(slice(6,10)),
            lambda: self.events.pop(2),
            lambda: self.evidence["members"][0].update(physical=self.evidence["members"][1]["physical"]),
            lambda: self.events.append({"stage":"member-erased","ordinal":2,"at":self.start+1}),
            lambda: self.events[0].update(at=self.start+5),
        ]:
            with self.subTest(mutate=mutate):
                self.setUp()
                mutate()
                with self.assertRaises(ValueError): self.reduce()


class TenMeter(unittest.TestCase):
    def test_outstanding_work_is_reserved_even_with_a_current_account_sample(self):
        now = 12 * 3600
        current = Usage(now,now-120,100_000,1_000)
        # Nine existing signups have consumed budget, but their unconfirmed work still needs a hold.
        enrolled = list(ORDINALS[:-1])
        with patch.dict(os.environ, {"FLEET_PILOT_STARTED_AT":str(now)}):
            delta = {"reads":600_000,"writes":20_000}
            def require(events):
                require_ten_room("ten-signup", current, delta, now, enrolled, {"events":events})
            with self.assertRaises(ValueError): require([])
            old = [{"stage":"signup-created","at":(current.latest-61)*1000,"ordinal":n} for n in enrolled]
            require(old)
            with self.assertRaises(ValueError):
                require([{**e,"at":(current.latest-10)*1000} for e in old])
            with self.assertRaises(ValueError):
                require_ten_room("ten-cleanup", Usage(now,now,4_999_000,99_500),
                                 {"reads":0,"writes":0}, now, enrolled, {})
            with self.assertRaises(ValueError):
                require_ten_room("ten-resume", current, delta, now, [], {}, resumed=True)

    def test_next_signup_can_wait_for_known_completions_but_not_real_exhaustion(self):
        from ten import AwaitWatermark
        now = 20_000
        enrolled = list(ORDINALS[:5])
        evidence = {"events": [{"stage":"signup-created", "at":(now-40)*1000, "ordinal":ordinal}
                               for ordinal in enrolled]}
        with patch.dict(os.environ, {"FLEET_PILOT_STARTED_AT": str(now-600)}):
            delta = {"reads":420_000,"writes":14_000}
            with self.assertRaises(AwaitWatermark):
                require_ten_room("ten-signup",Usage(now,now-80,420_100,14_010),delta,now,enrolled,evidence)
            require_ten_room("ten-signup",Usage(now+30,now+30,420_100,14_010),delta,now+30,enrolled,evidence)
            with self.assertRaises(ValueError) as refused:
                require_ten_room("ten-signup",Usage(now,now-80,1_500_000,60_000),
                                 {"reads":1_500_000,"writes":60_000},now,enrolled,evidence)
            self.assertFalse(isinstance(refused.exception, AwaitWatermark))

    def test_physical_graphql_includes_unrelated_uuid_users_and_refuses_truncation(self):
        obj = {"dimensions":{"objectId":"a"*64,"name":"00000000-0000-4000-8000-000000000002"},
               "sum":{"rowsWritten":2161}}
        def measured(rows):
            def lookup(path, body):
                self.assertEqual(body["variables"]["n"],"b"*32)
                self.assertEqual(path,"graphql")
                return {"data":{"viewer":{"accounts":[{"accountTag":"c"*32, "durableObjectsPeriodicGroups":rows}]}}}
            return written_objects("c"*32,"b"*32,20_000_000,21_000,lookup)
        self.assertEqual(measured([obj,{**obj,"dimensions":{"name":"probe","objectId":"b"*64}}]),
                         [{"name":obj["dimensions"]["name"],"id":"a"*64}])
        with self.assertRaises(ValueError): measured([obj]*100)
        with self.assertRaises(ValueError): measured([obj,obj])

    def test_original_envelope_and_ordinal_carry_through_unsettled_source(self):
        now = 30_000
        installed, source, follow = "a"*40, "b"*40, "c"*40
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            env = {"GITHUB_REF":"refs/heads/trunk","GITHUB_EVENT_NAME":"workflow_dispatch",
                   "NATIVE_STORAGE_ADMISSION":"closed","GITHUB_SHA":source,"RELEASE_GIT_SHA":source,
                   "EXPECTED_INSTALLED_REVISION":installed,"RUNNER_TEMP":tmp,
                   "FLEET_PILOT_STARTED_AT":str(now), "SMOKE_ATTESTATION_FILE":tmp+"/receipt"}
            journal = directory/"native-fleet-meter.jsonl"
            with patch.dict(os.environ,env,clear=True), patch("ten.time.time", return_value=now), \
                    patch("ten.usage",return_value=Usage(now,now,20,30)):
                sample("ten-begin",installed)
                with self.assertRaises(ValueError): sample("ten-signup",installed,"3")
                sample("ten-signup",installed,"2")
                with self.assertRaises(ValueError): sample("ten-signup",installed,"2")
                with patch("ten.usage",return_value=Usage(now,now,1_999_990,74_990)):
                    with self.assertRaises(ValueError): sample("ten-check",installed)
                journal.rename(directory/"fleet-source-meter.jsonl")
                (directory/"fleet-provenance.json").write_text(json.dumps({"runId":"123","sourceRevision":source}))
                with patch.dict(os.environ, {"GITHUB_SHA":follow,"RELEASE_GIT_SHA":follow}), \
                        patch("ten.usage",return_value=Usage(now,now,1020,2030)):
                    checkpoint = {"revision":installed, "verifierRevision":source, "coreVersion":"core", "events":[], "members":[]}
                    receipt = directory/"receipt.fleet"
                    receipt.write_text(json.dumps(checkpoint))
                    sample("ten-resume",installed)
                    receipt.write_text(json.dumps({**checkpoint, "verifierRevision":follow,
                                                   "sourceVerifierRevision":source,"sourceRun":"123"}))
                    with self.assertRaises(ValueError): sample("ten-signup",installed,"3")
                    sample("ten-cleanup",installed)
                    checkpoint["events"] = [{"stage":"observation-start","at":3000}]
                    receipt.write_text(json.dumps({**checkpoint,"verifierRevision":follow,
                                                   "sourceVerifierRevision":source,"sourceRun":"123"}))
                    with self.assertRaisesRegex(ValueError,"Original observation windows"):
                        sample("ten-logs",installed)
                    with contextlib.redirect_stdout(io.StringIO()) as out:
                        sample("ten-settle",installed,str(now*1000))
                    self.assertEqual(out.getvalue(),"observed\n")
                rows = [json.loads(line) for line in journal.read_text().splitlines()]
                self.assertEqual(rows[-1]["reads"],1000)
                self.assertEqual(rows[-1]["writes"],2000)
                self.assertEqual(rows[0]["verifierRevision"],source)
                self.assertEqual(rows[-1]["verifierRevision"],follow)
