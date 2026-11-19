import unittest
from fixture import facts, instant, validate_originals
from hosted import verify_signed_originals, verify_signed_views


class NativeReceiptFactsTests(unittest.TestCase):
    def test_cannot_swap_facts_between_two_authenticated_originals(self):
        originals = [dict(**facts(i), id=f"50000000-0000-4000-8000-{i:012d}", revision=0,
                          notes=None, createdAt="2026-11-19T00:00:00.000Z") for i in range(8)]
        capture = [dict(transactionId=r["id"], **r["money"], direction=r["direction"],
                        counterparty=r["counterparty"], categoryId=r["categoryId"],
                        occurred=instant(r["occurredAt"]), createdAtMs=instant(r["createdAt"]),
                        revision=0, notes=None) for r in originals]
        verify_signed_originals(originals, capture)
        originals[3]["id"], originals[4]["id"] = originals[4]["id"], originals[3]["id"]
        validate_originals(originals)
        with self.assertRaisesRegex(ValueError, "owner facts differ"):
            verify_signed_originals(originals, capture)


    def test_inspection_identities_and_signed_link_are_required_before_admission(self):
        originals = [dict(**facts(i), id=f"50000000-0000-4000-8000-{i:012d}", revision=0,
                          notes=None, createdAt="2026-11-19T00:00:00.000Z") for i in range(8)]
        first, second = originals[:2]
        link = dict(first=first["id"], second=second["id"], visible=first["id"])
        inspections = {r["id"]:{} for r in originals}
        manifest = dict(originals=originals, inspections=inspections, visible=first["id"],
                        suppressed=second["id"])
        for invalid in (dict(list(inspections.items())[1:]),
                        {**dict(list(inspections.items())[1:]), "other":{}}):
            with self.assertRaisesRegex(ValueError,"exact eight"):
                verify_signed_views({**manifest, "inspections":invalid}, [link])
        with self.assertRaisesRegex(ValueError, "signed link"):
            verify_signed_views({**manifest,"visible":second["id"],"suppressed":first["id"]},[link])
