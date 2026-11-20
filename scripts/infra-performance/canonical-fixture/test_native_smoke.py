import unittest
from unittest.mock import Mock, patch

import protected_cohort

from native_smoke import reserve_smoke


class NativeSmokeReservationTests(unittest.TestCase):
    def test_reserves_one_native_smoke_and_refuses_a_second_offer(self):
        proof = dict(nativeReceiptDigest="original", resourcePrefix="fidy-2259-0123456789ab")
        state = dict(stage="receipt-verified", receiptDigest="original", foregroundUntil=200)
        owner = Mock(state=state)
        owner.save.side_effect = lambda stage, **fields: state.update(stage=stage, **fields)
        port = Mock()
        port.marker_owner.return_value = proof["resourcePrefix"]
        with patch("native_smoke.time.time", return_value=100):
            self.assertEqual(reserve_smoke(owner, port, proof, {"GET /user": 1}), (200, 1))
            with self.assertRaisesRegex(ValueError, "unoffered original receipt"):
                reserve_smoke(owner, port, proof, {"GET /user": 1})
        port.guard.assert_called_once_with("foreground")
        self.assertEqual(state["browserReservation"], dict(
            refreshes=1, correction=1, staleBatch=1, authenticatedRequests=1,
            maximumPreflights=1, accountingWitnessReads=2, admission="one-use",
        ))
