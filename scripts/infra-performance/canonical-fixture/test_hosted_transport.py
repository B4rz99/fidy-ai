from datetime import datetime, timezone
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, call, patch

from protected_cohort import HostedPort, checked_browser_origin
from owner_transport import NATIVE_API
from owner_state import CustodyObject, Refused
from hosted import RECEIPT_PATHS
from test_cohort import Store
from cohort import Cohort, MAX_USER_OBJECTS


class BrowserOriginTests(unittest.TestCase):
    def test_fresh_evidence_accepts_different_countries_and_colos(self):
        now = 1_795_107_000.125
        report = {
            "observedAt": datetime.fromtimestamp(now, timezone.utc).isoformat(),
            "origins": {
                "api": {"country": "US", "colo": "IAD"},
                "browser": {"country": "CA", "colo": "YYZ"},
            },
        }
        with TemporaryDirectory() as directory:
            evidence = Path(directory) / "origin.json"
            evidence.write_text(json.dumps(report))
            checked_browser_origin(evidence, now)
            with self.assertRaises(ValueError):
                checked_browser_origin(evidence, now + 121)
            report["origins"]["browser"].pop("colo")
            evidence.write_text(json.dumps(report))
            with self.assertRaises(ValueError):
                checked_browser_origin(evidence, now)


class HostedTransportTests(unittest.TestCase):
    def setUp(self):
        with patch.dict("os.environ", GITHUB_RUN_ID="fixture", GITHUB_RUN_ATTEMPT="1"):
            self.port = HostedPort(None, None, account="d"*32, verify=Mock(), store=Mock(), marker=Mock(), cloud=Mock())
        self.state = dict(stage="owned", foregroundUntil=int(time.time())+600, foregroundRun=self.port.run)
        self.port.owner = SimpleNamespace(state=self.state, coordinates={}, save=Mock(side_effect=lambda stage,**kw: self.state.update(kw)))

    def test_census_follows_actual_terminal_empty_page(self):
        namespace = "d"*32
        self.port.owner.coordinates = dict(userNamespace=namespace)
        ids = {f"{index:064x}": index < 3 for index in range(15)}
        self.port.cloud.request.side_effect = [
            dict(result=[dict(id=key, hasStoredData=value) for key, value in ids.items()],
                 result_info=dict(cursors=dict(after="next+page="))),
            dict(result=[], result_info=dict(cursor="")),
        ]
        self.assertEqual(self.port.census(), ids)
        root = f"workers/durable_objects/namespaces/{namespace}/objects?limit=100"
        self.assertEqual(self.port.cloud.request.call_args_list,
                         [call("GET", root), call("GET", root+"&cursor=next%2Bpage%3D")])

    def test_census_rejects_duplicate_rows_cursors_and_excess_objects(self):
        self.port.owner.coordinates = dict(userNamespace="d"*32)
        row = dict(id="a"*64, hasStoredData=True)
        first = dict(result=[row], result_info=dict(cursor="next"))
        cases = [
            ([first, dict(result=[row])], "Duplicate"),
            ([first, dict(result=[], result_info=dict(cursor="next"))], "Incomplete"),
            ([dict(result=[], result_info=dict(cursor="one", cursors=dict(after="two")))], "Conflicting"),
            ([dict(result=[dict(id=f"{index:064x}", hasStoredData=False)
                           for index in range(MAX_USER_OBJECTS+1)])], "calibrated envelope"),
            ([dict(result=[], result_info=dict(cursor=str(index)))
              for index in range(MAX_USER_OBJECTS+1)], "page budget"),
        ]
        for pages, error in cases:
            with self.subTest(error=error), self.assertRaisesRegex(ValueError, error):
                self.port.cloud.request.side_effect = pages
                self.port.census()

    def test_only_fixed_phase_routes_can_reach_the_closed_transport(self):
        with patch("protected_cohort.fetch",return_value=(200,{},b"{}")) as fetch:
            outgoing = dict(url=NATIVE_API+"/web/privacy/erasure",method="POST",body='{"confirm":true}',headers={})
            for route in ["/web/privacy/erasure","/unowned","/internal/release-smoke?acceptance=charge-receipt"]:
                with self.subTest(route=route), self.assertRaises(ValueError):
                    self.port.exchange({**outgoing,"url":NATIVE_API+route}, fetch)
            self.state.update(stage="erasure-offered",cleanupRun=self.port.run,cleanupUntil=int(time.time())+60)
            with self.assertRaises(ValueError):
                self.port.exchange({**outgoing,"url":NATIVE_API+"/operations/atomic-batch"}, fetch)
            fetch.assert_not_called()
            self.port.exchange(outgoing, fetch)
            self.assertEqual(self.state["cleanupRequests"],1)
            fetch.assert_called_once()

    def test_receipt_route_matches_only_the_bound_member(self):
        self.state["stage"] = "receipt-offered"
        transport = Mock(return_value=(200, {}, b"{}"))
        def receipt(member):
            return dict(url=NATIVE_API+RECEIPT_PATHS[member], method="POST", body="{}", headers={})
        with self.assertRaises(ValueError):
            self.port.exchange(receipt("performance-2"), transport)
        self.port.exchange(receipt("performance-1"), transport)
        self.port.owner.coordinates["fixtureMember"] = "performance-2"
        with self.assertRaises(ValueError):
            self.port.exchange(receipt("performance-1"), transport)
        self.port.exchange(receipt("performance-2"), transport)
        self.assertEqual(self.state["foregroundRequests"], 2)

    def test_new_member_credentials_do_not_overlap_original_paths(self):
        account, revision = "a"*32, "b"*40
        source = Mock(auth="token")
        source.result.return_value = {"id":"c"*32, "status":"active"}
        with patch.dict("os.environ", GITHUB_ACTIONS="true", GITHUB_REF="refs/heads/trunk",
                        GITHUB_REPOSITORY="B4rz99/fidy-ai", GITHUB_REF_PROTECTED="true"):
            original = CustodyObject(account, source, native_revision=revision)
            original_marker = CustodyObject(account, source, native_revision=revision, receipt_marker=True)
            next_member = CustodyObject(account, source, native_revision=revision, member="performance-2")
            next_marker = CustodyObject(account, source, native_revision=revision, receipt_marker=True,
                                        member="performance-2")
            with self.assertRaises(Refused):
                CustodyObject(account, source, native_revision=revision, member="performance-3")
        self.assertEqual(original.key, f"protected-storage/account/{account}/performance-1/{revision}.json")
        self.assertEqual(original_marker.key, f"_release-smoke/{revision}/acceptance/transactions/performance-1")
        self.assertEqual(next_member.key, f"protected-storage/account/{account}/performance-2/{revision}.json")
        self.assertEqual(next_marker.key, f"_release-smoke/{revision}/acceptance/transactions/performance-2")

    def test_foreign_expired_and_over_budget_claims_stop_before_private_http(self):
        with patch("protected_cohort.fetch") as fetch:
            outgoing = dict(url=NATIVE_API+"/transactions?limit=25",method="GET",body=None,headers={})
            for changes in [dict(foregroundUntil=0),dict(foregroundRun="other"),dict(foregroundRequests=100)]:
                with self.subTest(changes=changes), patch.dict(self.state,changes), self.assertRaises(ValueError):
                    self.port.exchange(outgoing, fetch)
            fetch.assert_not_called()


class HostedClaimTests(unittest.TestCase):
    def setUp(self):
        self.now = 1_900_000_000
        self.coords = dict(prefix="fidy-2259-0123456789ab", revision="a"*40)
        self.store = Store()
        self.previous = dict(stage="claimed", coordinates=self.coords, foregroundUntil=self.now-90,
                             foregroundRun="111/1", usageBefore={"original": True}, foregroundRequests=14,
                             lastDispatch=self.now-110)
        self.store.replace(0, self.previous)
        marker = Mock()
        marker.read.return_value = (None, None)
        with patch.dict("os.environ", GITHUB_RUN_ID="222", GITHUB_RUN_ATTEMPT="1"):
            self.port = HostedPort(None, None, account="d"*32, verify=Mock(),
                                   store=self.store, marker=marker, cloud=Mock())
        self.owner = Cohort(self.store, self.coords, self.port)
        self.port.owner = self.owner
        self.port.survivors = Mock(side_effect=RuntimeError("stop before enrollment"))
        self.sample = {"current": True}

    def test_resume_reserves_again_and_conditionally_replaces_the_same_unoffered_claim(self):
        with patch("protected_cohort.time.time", return_value=self.now), \
                patch("protected_cohort.observe", return_value=self.sample) as observe, \
                patch("protected_cohort.check") as check:
            with self.assertRaisesRegex(RuntimeError, "stop before enrollment"):
                self.owner.enroll()
        self.assertEqual(observe.call_count, 2)
        check.assert_any_call(self.sample, self.sample, "begin", self.now)
        self.assertEqual(self.store.data, {**self.previous, "foregroundRun": "222/1",
                         "foregroundUntil": self.now+1200, "usageBefore": self.sample,
                         "lastUsage": self.sample})
        self.assertEqual(self.store.version, 3)

    def test_resume_refuses_fenced_or_active_claims_before_fresh_reservation(self):
        denied = [
            dict(foregroundUntil=self.now-89),
            dict(foregroundRun="222/1"),
            dict(foregroundUntil=None),
            dict(stage="signup-offered"),
            dict(stage="signup-created"),
            dict(physical="b"*64),
            dict(pending={"mutation": "signup"}),
            dict(receiptDigest="c"*64),
            dict(cleanupRun="333/1"),
        ]
        for fields in denied:
            with self.subTest(fields=fields), patch.dict(self.owner.state, fields), \
                    patch("protected_cohort.time.time", return_value=self.now), \
                    patch("protected_cohort.observe") as observe, self.assertRaises(ValueError):
                self.owner.enroll()
            observe.assert_not_called()
        self.port.marker.read.return_value = ("etag", self.coords["prefix"])
        with patch("protected_cohort.time.time", return_value=self.now), \
                patch("protected_cohort.observe") as observe, self.assertRaisesRegex(ValueError, "one-use"):
            self.owner.enroll()
        observe.assert_not_called()
        self.port.survivors.assert_not_called()
        self.assertEqual(self.store.data, self.previous)

    def test_changed_claim_loses_compare_and_swap_before_resuming_preflight(self):
        replacement = {**self.previous, "stage": "signup-offered"}
        self.store.replace(self.store.version, replacement)
        with patch("protected_cohort.time.time", return_value=self.now), \
                patch("protected_cohort.observe", return_value=self.sample), patch("protected_cohort.check"), \
                self.assertRaisesRegex(ValueError, "changed claim"):
            self.owner.enroll()
        self.port.survivors.assert_not_called()
        self.assertEqual(self.store.data, replacement)

    def test_unoffered_cleanup_evidence_does_not_update_custody_or_dispatch_http(self):
        self.port.run = self.previous["foregroundRun"]
        self.port.unoffered_claim()
        self.port.survivors.assert_not_called()
        self.port.cloud.request.assert_not_called()
        self.assertEqual(self.store.data, self.previous)
