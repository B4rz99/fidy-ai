import copy
import unittest
from cohort import Cohort


class Store:
    def __init__(self):
        self.data = None
        self.version = 0

    def read(self):
        return self.version, copy.deepcopy(self.data)

    def replace(self, version, value):
        if version != self.version:
            raise ValueError("changed claim")
        self.version += 1
        self.data = copy.deepcopy(value)
        return self.version


class Port:
    def __init__(self):
        self.objects = {"a"*64: True, "b"*64: True}
        self.target = "c"*64
        self.operations = []
        self.marker = None

    def census(self):
        return self.objects.copy()

    def survivors(self):
        return ["alice", "bob"]

    def before_signup(self):
        self.operations.append("login-only absence")

    def register(self):
        self.operations.append("signup")
        self.objects[self.target] = True
        return "created", "carol", "a"*64

    def login(self):
        self.operations.append("login")
        return "carol"

    def erase(self, user):
        assert user == "carol"
        self.operations.append("erase")
        self.objects[self.target] = False

    def renew(self):
        self.operations.append("lease")

    def denial(self, _):
        self.operations.append("denied")

    def guard(self, phase):
        self.operations.append("guard-" + phase)

    def marker_owner(self):
        return self.marker

class CohortTests(unittest.TestCase):
    def test_a_fresh_process_finishes_owned_erasure_after_the_response_is_lost(self):
        port, store = Port(), Store()
        coordinates = dict(prefix="fidy-2259-0123456789ab", revision="a"*40)
        owner = Cohort(store, coordinates, port)
        owner.enroll()
        port.marker = coordinates["prefix"]
        owner.offer_receipt()
        erase = port.erase
        def interrupted(user):
            erase(user)
            raise IOError("response lost")
        port.erase = interrupted
        with self.assertRaises(IOError):
            owner.cleanup()
        restored = Cohort(store, coordinates, port)
        restored.cleanup()
        self.assertEqual(port.operations.count("erase"), 1)
        self.assertEqual(port.operations.count("signup"), 1)
        self.assertEqual(port.operations.count("denied"), 1)
        self.assertEqual(port.marker, coordinates["prefix"])
        self.assertEqual(store.data["stage"], "disposed")
        self.assertEqual(port.objects, {"a"*64: True, "b"*64: True, "c"*64: False})
        with self.assertRaises(ValueError):
            restored.enroll()

    def test_interruption_before_erasure_dispatch_recovers_with_matching_login_only(self):
        port, store = Port(), Store()
        coords = dict(prefix="fidy-2259-0123456789ab", revision="a"*40)
        owner = Cohort(store, coords, port)
        owner.enroll()
        def lost(user):
            raise IOError("before first erasure dispatch")
        erase = port.erase
        port.erase = lost
        with self.assertRaises(IOError):
            owner.cleanup()
        port.erase = erase
        port.recover_login = port.login
        Cohort(store, coords, port, sleep=lambda *_: self.fail("Still waiting for unoffered erasure")).cleanup()
        self.assertEqual(port.operations.count("erase"), 1)
        self.assertEqual(port.operations.count("signup"), 1)

    def test_lost_signup_reply_uses_established_login_and_preserves_existing_objects(self):
        port, store = Port(), Store()
        coords = dict(prefix="fidy-2259-0123456789ab", revision="a"*40)
        register = port.register
        def interrupted():
            register()
            raise IOError("lost signup response")
        port.register = interrupted
        owner = Cohort(store, coords, port)
        with self.assertRaises(IOError):
            owner.enroll()
        with self.assertRaisesRegex(ValueError, "Foreign native"):
            Cohort(store, {**coords, "prefix":"fidy-2259-ab0123456789"}, port)
        Cohort(store, coords, port).cleanup()
        self.assertEqual(port.operations.count("signup"), 1)
        self.assertEqual(port.operations.count("erase"), 1)
        self.assertEqual(store.data["stage"], "disposed")

    def test_ambiguous_or_changed_physical_ownership_never_submits_erasure(self):
        coords = dict(prefix="fidy-2259-0123456789ab", revision="a"*40)
        for change in ("retained", "extra", "identity"):
            port, store = Port(), Store()
            owner = Cohort(store, coords, port)
            owner.enroll()
            if change == "retained":
                port.objects["a"*64] = False
            elif change == "extra":
                port.objects["d"*64] = True
            else:
                port.login = lambda: "alice"
            with self.subTest(change=change), self.assertRaises(ValueError):
                owner.cleanup()
            self.assertNotIn("erase", port.operations)

    def test_existing_one_use_marker_or_private_provider_identity_prevent_signup(self):
        coords = dict(prefix="fidy-2259-0123456789ab", revision="a"*40)
        for reason in ("marker", "login"):
            port, store = Port(), Store()
            if reason == "marker":
                port.marker = coords["prefix"]
            else:
                def existing():
                    raise ValueError("performance User already exists")
                port.before_signup = existing
            with self.subTest(reason=reason), self.assertRaises(ValueError):
                Cohort(store, coords, port).enroll()
            self.assertNotIn("signup", port.operations)
            self.assertNotIn("erase", port.operations)
