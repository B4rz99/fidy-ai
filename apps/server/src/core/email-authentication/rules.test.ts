import { expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { decideProofAttempt, enrollmentExpiry, proofExpiry, selectEmailCodeSymbols } from "./rules";

const acceptedAt = DateTime.makeUnsafe("2026-08-23T12:00:00Z");

it("uses exact half-open enrollment and proof lifetimes", () => {
  expect(enrollmentExpiry(acceptedAt)).toEqual(DateTime.makeUnsafe("2026-08-24T12:00:00Z"));
  expect(proofExpiry(acceptedAt)).toEqual(DateTime.makeUnsafe("2026-08-23T12:10:00Z"));
  expect(
    Effect.runSync(
      decideProofAttempt({
        digestMatches: true,
        wrongAttempts: 0,
        proofExpiresAt: DateTime.makeUnsafe("2026-08-23T12:10:00Z"),
        enrollmentExpiresAt: DateTime.makeUnsafe("2026-08-24T12:00:00Z"),
        attemptedAt: DateTime.makeUnsafe("2026-08-23T12:10:00Z"),
      })
    )
  ).toEqual({ _tag: "Expired" });
});

it("accepts a matching live proof and rejects an enrollment-expired proof", () => {
  const base = {
    digestMatches: true,
    wrongAttempts: 0,
    proofExpiresAt: DateTime.makeUnsafe("2026-08-24T12:10:00Z"),
    enrollmentExpiresAt: DateTime.makeUnsafe("2026-08-24T12:00:00Z"),
  };
  expect(
    Effect.runSync(
      decideProofAttempt({
        ...base,
        attemptedAt: DateTime.makeUnsafe("2026-08-23T12:09:59Z"),
      })
    )
  ).toEqual({ _tag: "Accept" });
  expect(
    Effect.runSync(
      decideProofAttempt({
        ...base,
        attemptedAt: DateTime.makeUnsafe("2026-08-24T12:00:00Z"),
      })
    )
  ).toEqual({ _tag: "Expired" });
});

it("deletes bounded evidence on the fifth wrong proof", () => {
  expect(
    Effect.runSync(
      decideProofAttempt({
        digestMatches: false,
        wrongAttempts: 3,
        proofExpiresAt: DateTime.makeUnsafe("2026-08-23T12:10:00Z"),
        enrollmentExpiresAt: DateTime.makeUnsafe("2026-08-24T12:00:00Z"),
        attemptedAt: DateTime.makeUnsafe("2026-08-23T12:09:59Z"),
      })
    )
  ).toEqual({ _tag: "Wrong", wrongAttempts: 4 });
  expect(
    Effect.runSync(
      decideProofAttempt({
        digestMatches: false,
        wrongAttempts: 4,
        proofExpiresAt: DateTime.makeUnsafe("2026-08-23T12:10:00Z"),
        enrollmentExpiresAt: DateTime.makeUnsafe("2026-08-24T12:00:00Z"),
        attemptedAt: DateTime.makeUnsafe("2026-08-23T12:09:59Z"),
      })
    )
  ).toEqual({ _tag: "Delete" });
});

it("selects only complete unbiased symbols from the unambiguous alphabet", () => {
  expect(selectEmailCodeSymbols({ bytes: [0, 1, 31, 32, 255], maximum: 4 })).toBe("AB9A");
});
