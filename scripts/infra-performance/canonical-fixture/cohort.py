"""Custody of one closed performance User on an independently qualified native installation."""
import hashlib
import re
import time


def identity(value):
    return hashlib.sha256(value.encode()).hexdigest()


def retained(before, current):
    if any(current.get(key) is not value for key, value in before.items()):
        raise ValueError("Retained physical User inventory changed")
    return set(current) - set(before)


class Cohort:
    def __init__(self, store, coordinates, port, *, sleep=time.sleep):
        self.store, self.coordinates, self.port, self.sleep = store, coordinates, port, sleep
        self.version, self.state = store.read()
        if self.state and self.state["coordinates"] != coordinates:
            raise ValueError("Foreign native cohort custody")

    def save(self, stage, **fields):
        self.state.update(stage=stage, **fields)
        self.version = self.store.replace(self.version, self.state)

    def survivor_ids(self):
        users = self.port.survivors()
        if len(users) != 2 or len(set(users)) != 2:
            raise ValueError("Two distinct established smoke Users required")
        return [identity(user) for user in users]

    def census(self):
        result = self.port.census()
        if (len(result) > 36 or any(not re.fullmatch("[a-f0-9]{64}", key)
                                     or type(stored) is not bool for key, stored in result.items())):
            raise ValueError("Native inventory outside the calibrated envelope")
        return result

    def fresh_object(self):
        for attempt in range(40):
            current = self.census()
            added = retained(self.state["before"], current)
            if len(added) > 1:
                raise ValueError("Ambiguous new physical User objects")
            if added:
                subject, = added
                if current[subject]:
                    return subject
            if attempt < 39:
                self.sleep(30)
        raise ValueError("Fresh performance User storage unobserved")

    def enroll(self):
        if self.state is not None:
            raise ValueError("Native cohort already claimed")
        self.port.guard("begin")
        self.state = dict(coordinates=self.coordinates)
        self.save("claimed")
        self.port.guard("preflight")
        if self.port.marker_owner() is not None:
            raise ValueError("Release already issued its one-use receipt")
        survivors = self.survivor_ids()
        self.port.before_signup()
        before = self.census()
        if len(before) >= 36 or sum(before.values()) < 2:
            raise ValueError("Missing independently stored survivor Users")
        self.port.guard("signup")
        self.save("signup-offered", before=before, survivors=survivors)
        outcome, user, session_digest = self.port.register()
        if outcome != "created" or identity(user) in survivors:
            self.save("foreign-registration")
            raise ValueError("Protected signup did not create the expected fresh User")
        self.save("signup-created", user=identity(user), originalSessionDigest=session_digest)
        self.save("owned", physical=self.fresh_object())

    def offer_receipt(self):
        if self.state["stage"] != "owned":
            raise ValueError("The receipt was already offered or the User is unowned")
        self.port.guard("foreground")
        self.save("receipt-offered")

    def physical_state(self):
        current = self.census()
        additions = retained(self.state["before"], current)
        target = self.state["physical"]
        if additions - {target}:
            raise ValueError("Unowned User appeared during native cleanup")
        return "absent" if target not in current else ("populated" if current[target] else "empty")

    def cleanup(self):
        if self.state is None:
            raise ValueError("Native cohort has no independent custody")
        stage = self.state["stage"]
        if stage == "disposed":
            return
        if stage in ("claimed", "foreign-registration"):
            raise ValueError("No new performance User is attributable to this registration")
        self.port.guard("cleanup")
        if "physical" not in self.state:
            physical = self.fresh_object()
            user = identity(self.port.login())
            if (user in self.state["survivors"] or user != self.state.get("user", user)
                    or stage not in ("signup-offered", "signup-created")):
                raise ValueError("Cannot attribute the established performance User")
            self.save("owned", physical=physical, user=user)
        current = self.physical_state()
        if current == "populated" and stage == "erasure-offered":
            user = self.port.recover_login()
            if user is not None:
                if identity(user) != self.state["user"]:
                    raise ValueError("A different User authenticated during interrupted cleanup")
                self.port.renew()
                self.port.erase(user)
        elif current == "populated":
            user = self.port.login()
            if identity(user) != self.state["user"]:
                raise ValueError("Cleanup authenticated another User")
            self.port.guard("cleanup")
            self.port.renew()
            self.save("erasure-offered", receiptOffered=stage in ("receipt-offered", "receipt-verified"),
                      receiptVerified=stage == "receipt-verified")
            self.port.erase(user)
        elif current != "populated" and stage != "erasure-offered":
            raise ValueError("Physical User disappeared before owned erasure")
        for attempt in range(40):
            current = self.physical_state()
            if current != "populated":
                break
            if attempt == 39:
                raise ValueError("Native erasure did not converge")
            self.port.guard("cleanup")
            self.port.renew()
            self.sleep(30)
        self.port.denial(self.state.get("originalSessionDigest"))
        if self.survivor_ids() != self.state["survivors"] or self.physical_state() == "populated":
            raise ValueError("Independent erasure and survivor identities differ")
        marker = self.port.marker_owner()
        if self.state.get("receiptVerified") and marker is None:
            raise ValueError("Verified receipt lost its one-use fence")
        if marker is not None and (not self.state.get("receiptOffered") or marker != self.coordinates["prefix"]):
            raise ValueError("Unowned one-use marker")
        self.port.guard("finish")
        self.save("disposed", physicalState=current, receiptMarkerRetained=marker is not None)
