import unittest

from rehearse_cohort import check_window_accounts


class MountedWindowAccounts(unittest.TestCase):
    def setUp(self):
        self.delta = {
            "ingestion.getReviewWorkspace.success": 1,
            "transactions.listTransactions.success": 33,
            "transactions.updateTransaction.success": 1,
            "transactions.updateTransaction.validation_failed": 1,
            "operations.executeAtomicBatch.validation_failed": 1,
            "operations.executeAtomicBatch.success": 0,
            "transactions.createTransaction.success": 0,
            "canonicalUnits": 0,
            "receipts": 0,
        }

    def test_one_committed_correction_and_one_failed_batch_are_attributed(self):
        check_window_accounts(self.delta)

    def test_the_failed_child_does_not_substitute_for_the_batch_audit(self):
        del self.delta["operations.executeAtomicBatch.validation_failed"]
        with self.assertRaisesRegex(ValueError, "native Session Audit"):
            check_window_accounts(self.delta)

    def test_refuses_additional_effects_or_incomplete_accounting(self):
        for key, count in (
                ("operations.executeAtomicBatch.success", 1),
                ("transactions.createTransaction.success", 1),
                ("transactions.updateTransaction.success", 2),
                ("transactions.listTransactions.success", 32),
                ("ingestion.getReviewWorkspace.success", 0),
                ("canonicalUnits", 1),
                ("receipts", 1)):
            with self.subTest(key=key, count=count), self.assertRaises(ValueError):
                check_window_accounts({**self.delta, key: count})
        del self.delta["receipts"]
        with self.assertRaises(ValueError):
            check_window_accounts(self.delta)


if __name__ == "__main__":
    unittest.main()
