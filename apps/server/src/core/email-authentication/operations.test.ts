import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Option } from "effect";
import {
  canRedeemOnboardingProof,
  decideBrowserPairingEmailRequest,
  decideEmailReplacementRequest,
  decideProofAttempt,
  emailWorkflowExpiry,
  proofExpiry,
  selectEmailCodeSymbols,
} from "./operations";

const acceptedAt = DateTime.makeUnsafe("2026-08-23T12:00:00Z");

it("accepts a live matching workflow revision and rejects a stale revision", () => {
  const workflow = {
    credentialRevisionMatches: true,
    deliveryGeneration: 1,
    resendAvailableAt: DateTime.makeUnsafe("2026-08-23T11:59:00Z"),
    expiresAt: DateTime.makeUnsafe("2026-08-23T12:10:00Z"),
  };
  expect(
    decideBrowserPairingEmailRequest({
      existing: Option.some(workflow),
      requestedAt: acceptedAt,
      processedAt: acceptedAt,
    })
  ).toBe("Continue");
  expect(
    decideBrowserPairingEmailRequest({
      existing: Option.some({ ...workflow, credentialRevisionMatches: false }),
      requestedAt: acceptedAt,
      processedAt: acceptedAt,
    })
  ).toBe("Reject");
});

it("uses exact half-open enrollment and proof lifetimes", () => {
  expect(emailWorkflowExpiry(acceptedAt)).toEqual(DateTime.makeUnsafe("2026-08-24T12:00:00Z"));
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

it("decides bounded replacement resend and supersession from locked state", () => {
  const requestedAt = DateTime.makeUnsafe("2026-08-23T12:00:00Z");
  expect(
    Effect.runSync(decideEmailReplacementRequest({ existing: Option.none(), requestedAt }))
  ).toBe("Start");
  expect(
    Effect.runSync(
      decideEmailReplacementRequest({
        existing: Option.some({
          candidateMatches: true,
          deliveryGeneration: 1,
          resendAvailableAt: DateTime.makeUnsafe("2026-08-23T12:00:01Z"),
          expiresAt: DateTime.makeUnsafe("2026-08-24T12:00:00Z"),
        }),
        requestedAt,
      })
    )
  ).toBe("Reject");
  expect(
    Effect.runSync(
      decideEmailReplacementRequest({
        existing: Option.some({
          candidateMatches: false,
          deliveryGeneration: 1,
          resendAvailableAt: DateTime.makeUnsafe("2026-08-23T12:00:01Z"),
          expiresAt: DateTime.makeUnsafe("2026-08-24T12:00:00Z"),
        }),
        requestedAt,
      })
    )
  ).toBe("UseExisting");
  expect(
    Effect.runSync(
      decideEmailReplacementRequest({
        existing: Option.some({
          candidateMatches: true,
          deliveryGeneration: 1,
          resendAvailableAt: requestedAt,
          expiresAt: requestedAt,
        }),
        requestedAt,
      })
    )
  ).toBe("ReplaceExpired");
});

it("selects only complete unbiased symbols from the unambiguous alphabet", () => {
  expect(selectEmailCodeSymbols({ bytes: [0, 1, 31, 32, 255], maximum: 4 })).toBe("AB9A");
});

it("redeems only armed onboarding proofs before both expiry boundaries", () => {
  const proof = {
    state: "awaiting_proof" as const,
    expiresAtMs: 2000,
    proofExpiresAtMs: 1500,
    nowMs: 1499,
  };
  expect(canRedeemOnboardingProof(proof)).toBe(true);
  expect(canRedeemOnboardingProof({ ...proof, nowMs: 1500 })).toBe(false);
  expect(canRedeemOnboardingProof({ ...proof, expiresAtMs: 1499 })).toBe(false);
  for (const state of ["awaiting_delivery", "sending", "rejected", "ambiguous"] as const) {
    expect(canRedeemOnboardingProof({ ...proof, state })).toBe(false);
  }
});

it("refuses a sixth delivery for either replacement or browser-pairing proof", () => {
  const workflow = {
    candidateMatches: false,
    credentialRevisionMatches: true,
    deliveryGeneration: 5,
    resendAvailableAt: DateTime.makeUnsafe("2026-08-23T11:59:00Z"),
    expiresAt: DateTime.makeUnsafe("2026-08-24T12:00:00Z"),
  };
  expect(
    Effect.runSync(
      decideEmailReplacementRequest({
        existing: Option.some(workflow),
        requestedAt: acceptedAt,
      })
    )
  ).toBe("Reject");
  expect(
    decideBrowserPairingEmailRequest({
      existing: Option.some(workflow),
      requestedAt: acceptedAt,
      processedAt: acceptedAt,
    })
  ).toBe("Reject");
});
