from copy import deepcopy
import unittest

from disposition import HOSTS, NATIVE_WORKERS
from opening_source import opening_coordinates, verify_activity
from provider import Refused


class CanonicalProof(unittest.TestCase):
    def setUp(self):
        self.opening = {
            "revision": "f" * 40,
            "contractDigest": "a" * 64,
            "admission": "open",
            "workers": {name: {"deployment": "00000000-0000-4000-8000-000000000000",
                               "version": "00000000-0000-4000-8000-000000000001"}
                        for name in NATIVE_WORKERS},
            "hosts": {name: f"{index:036x}" for index, name in enumerate(HOSTS, start=1)},
            "namespaces": {f"{index:032x}": name for index, name in enumerate(
                ["Directory", "UserStore", "Pricing", "Maintenance", "Erasure"], start=1)},
        }
        coordinates = opening_coordinates(self.opening)
        self.coordinates = coordinates
        self.activity = {
            **self.opening, "openingArtifact": "42", "openingSha256": "e" * 64,
            "signup": {"provider": "google", "outcome": "created", "synthetic": False,
                       "origin": "https://api.fidyapp.com",
                       "coreVersion": coordinates["workers"]["fidy-native-storage-core"]["version"],
                       "userNamespace": f"{2:032x}",
                       "proof": {"kind": "new-userstore", "digest": "b" * 64}},
            "recovery": {"owner": "Maintenance", "outcome": "recovered",
                         "namespace": f"{4:032x}", "digest": "c" * 64},
        }

    def test_closed_release_cannot_authorize_disposal(self):
        with self.assertRaises(Refused):
            opening_coordinates({**self.opening, "admission": "closed"})

    def test_same_opening_with_new_ordinary_signup_and_actual_recovery(self):
        verify_activity(self.activity, self.coordinates, "42", "e" * 64)
        for group, field, value in (("signup", "synthetic", True),
                                    ("signup", "outcome", "approved"),
                                    ("signup", "origin", "https://storage-acceptance.fidyapp.com"),
                                    ("signup", "userNamespace", f"{1:032x}"),
                                    ("recovery", "owner", "Pricing"),
                                    ("recovery", "outcome", "offered")):
            changed = deepcopy(self.activity)
            changed[group][field] = value
            with self.assertRaises(Refused):
                verify_activity(changed, self.coordinates, "42", "e" * 64)
        with self.assertRaises(Refused):
            verify_activity(self.activity, self.coordinates, "43", "e" * 64)


if __name__ == "__main__":
    unittest.main()
