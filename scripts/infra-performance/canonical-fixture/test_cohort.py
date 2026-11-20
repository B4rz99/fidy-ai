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
        return "created", "carol"

    def login(self):
        self.operations.append("login")
        return "carol"

    def erase(self, user):
        assert user == "carol"
        self.operations.append("erase")
        self.objects[self.target] = False

    def renew(self):
        self.operations.append("lease")

    def denial(self):
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
