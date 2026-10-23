import {
  decidePATPairingClaim,
  patPairingExpiry,
  selectPATPairingPublicCodeSymbols,
} from "./operations";
import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Option, Result, Schema } from "effect";
import {
  type PATPairingClaimDecision,
  PATPairingDeviceCode,
  PATPairingLifecycle,
  PATPairingPublicCode,
  PATPairingPublicCodeInput,
} from "./contract";

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

it("limits selected public-code symbols after discarding biased bytes", () => {
  expect(selectPATPairingPublicCodeSymbols({ bytes: [240, 0, 1, 2], maximum: 2 })).toBe("BC");
});

it("accepts a pairing poll at the exact persisted minimum interval", () => {
  expect(
    decide({
      ...base,
      lastAcceptedPollAt: Option.some(attemptedAt),
      attemptedAt: DateTime.addDuration(attemptedAt, "5 seconds"),
    })
  ).toEqual({
    _tag: "Pending",
    acceptedAt: DateTime.addDuration(attemptedAt, "5 seconds"),
    minimumPollIntervalSeconds: 5,
  });
});

it("round trips canonical pairing codes and bounds the private device proof to base64url", () => {
  const code = PATPairingPublicCode.make("BCDF-GHJK");
  expect(Schema.encodeSync(PATPairingPublicCodeInput)(code)).toBe("BCDF-GHJK");
  const decode = Schema.decodeUnknownResult(PATPairingDeviceCode);
  const valid = `${"Az09_-".repeat(7)}A`;
  expect(Result.isSuccess(decode(valid))).toBe(true);
  for (const value of [valid.slice(1), `${valid}A`, `!${valid}`, `${valid}!`, "!".repeat(43)]) {
    expect(Result.isFailure(decode(value))).toBe(true);
  }
});

it("rejects any suffix after a canonical public pairing identity", () => {
  for (const value of ["BCDF-GHJKX", "BCDF-GHJKBCDF"]) {
    expect(Schema.is(PATPairingPublicCode)(value)).toBe(false);
    expect(Option.isNone(Schema.decodeOption(PATPairingPublicCodeInput)(value))).toBe(true);
  }
});
