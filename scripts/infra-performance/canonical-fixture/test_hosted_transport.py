import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from protected_cohort import HostedPort
from owner_transport import NATIVE_API


class HostedTransportTests(unittest.TestCase):
    def setUp(self):
        with patch.dict("os.environ", GITHUB_RUN_ID="fixture", GITHUB_RUN_ATTEMPT="1"):
            self.port = HostedPort(None, None, account="d"*32, verify=Mock(), store=Mock(), marker=Mock(), cloud=Mock())
        self.state = dict(stage="owned", foregroundUntil=int(time.time())+600, foregroundRun=self.port.run)
        self.port.owner = SimpleNamespace(state=self.state, save=Mock(side_effect=lambda stage,**kw: self.state.update(kw)))

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

    def test_foreign_expired_and_over_budget_claims_stop_before_private_http(self):
        with patch("protected_cohort.fetch") as fetch:
            outgoing = dict(url=NATIVE_API+"/transactions?limit=25",method="GET",body=None,headers={})
            for changes in [dict(foregroundUntil=0),dict(foregroundRun="other"),dict(foregroundRequests=100)]:
                with self.subTest(changes=changes), patch.dict(self.state,changes), self.assertRaises(ValueError):
                    self.port.exchange(outgoing, fetch)
            fetch.assert_not_called()
