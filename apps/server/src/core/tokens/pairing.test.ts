import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Option, Schema } from "effect";
import {
  type PATPairingClaimDecision,
  PATPairingLifecycle,
  PATPairingPublicCode,
  PATPairingPublicCodeInput,
  decidePATPairingClaim,
  patPairingExpiry,
  selectPATPairingPublicCodeSymbols,
} from "./pairing";

const expiry = DateTime.makeUnsafe("2026-09-01T12:10:00.000Z");
const attemptedAt = DateTime.makeUnsafe("2026-09-01T12:00:05.000Z");
const base = {
  lifecycle: "pending_approval",
  proofMatches: true,
  wrongProofAttempts: 0,
  minimumPollIntervalSeconds: 5,
  lastAcceptedPollAt: Option.none<DateTime.Utc>(),
  expiresAt: expiry,
  attemptedAt,
} as const;
const decide = (input: Parameters<typeof decidePATPairingClaim>[0]): PATPairingClaimDecision =>
  Effect.runSync(decidePATPairingClaim(input));

it("normalizes only the public code's narrow ASCII presentation variants", () => {
  const decode = Schema.decodeUnknownOption(PATPairingPublicCodeInput);
  expect(Option.getOrThrow(decode("bcdfghjk"))).toBe("BCDF-GHJK");
  expect(Option.getOrThrow(decode(" \tbcdf-ghjk\r\n"))).toBe("BCDF-GHJK");
  expect(Option.isNone(decode("BCDF GHJK"))).toBe(true);
  expect(Option.isNone(decode("\u00a0BCDF-GHJK"))).toBe(true);
  expect(Schema.is(PATPairingPublicCode)("BCDF-GHJK")).toBe(true);
});

it("selects unbiased symbols and expires exactly ten minutes after start", () => {
  expect(selectPATPairingPublicCodeSymbols({ bytes: [239, 240, 255, 0], maximum: 3 })).toBe("ZB");
  expect(
    DateTime.toEpochMillis(patPairingExpiry(DateTime.makeUnsafe("2026-09-01T12:00:00.000Z")))
  ).toBe(DateTime.toEpochMillis(expiry));
});

it("covers every persisted lifecycle and rejects unknown values", () => {
  for (const lifecycle of [
    "pending_approval",
    "approved_awaiting_claim",
    "claimed",
    "expired_unapproved",
    "revoked_unclaimed",
  ] as const) {
    expect(Schema.is(PATPairingLifecycle)(lifecycle)).toBe(true);
  }
  expect(Schema.is(PATPairingLifecycle)("active")).toBe(false);
});

it("returns pending before approval and claim after approval for the correct proof", () => {
  expect(decide(base)).toEqual({
    _tag: "Pending",
    acceptedAt: attemptedAt,
    minimumPollIntervalSeconds: 5,
  });
  expect(decide({ ...base, lifecycle: "approved_awaiting_claim" })).toEqual({ _tag: "Claim" });
});

it("owns wrong-proof accounting and persisted polling slowdown", () => {
  expect(decide({ ...base, proofMatches: false })).toEqual({
    _tag: "WrongProof",
    wrongProofAttempts: 1,
  });
  expect(
    decide({
      ...base,
      lastAcceptedPollAt: Option.some(attemptedAt),
      attemptedAt: DateTime.addDuration(attemptedAt, "2 seconds"),
    })
  ).toEqual({ _tag: "SlowDown", minimumPollIntervalSeconds: 10, retryAfterSeconds: 8 });
});

it("distinguishes expiry work while making every terminal lifecycle invalid", () => {
  expect(decide({ ...base, attemptedAt: expiry })).toEqual({ _tag: "ExpireUnapproved" });
  expect(
    decide({
      ...base,
      lifecycle: "approved_awaiting_claim",
      attemptedAt: expiry,
    })
  ).toEqual({ _tag: "RevokeUnclaimed" });
  for (const lifecycle of ["claimed", "expired_unapproved", "revoked_unclaimed"] as const) {
    expect(decide({ ...base, lifecycle })).toEqual({ _tag: "Invalid" });
  }
});
