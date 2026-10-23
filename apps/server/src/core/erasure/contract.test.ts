import { ErasureCustodyEvidence, ErasureOperatorReceipt, ErasureRequest } from "./contract";
import { Result, Schema } from "effect";
import { expect, it } from "vitest";

const reference = "10000000-0000-4000-8000-000000000001";
it("requires explicit erasure confirmation", () => {
  expect(Result.isSuccess(Schema.decodeResult(ErasureRequest)({ confirm: true }))).toBe(true);
  expect(Result.isFailure(Schema.decodeUnknownResult(ErasureRequest)({ confirm: false }))).toBe(
    true
  );
});

it("preserves completed work and unresolved external evidence in the operator receipt", () => {
  const value = {
    reference,
    state: "ExternalPending",
    next: "provider-evidence",
    completed: ["transactions"],
    custodians: [
      { custodian: "Cloudflare", status: "Accepted" },
      { custodian: "Resend", status: "Unresolved", reason: "capability-unverified" },
    ],
    recoveryUntilMs: null,
  };
  const decoded = Schema.decodeUnknownSync(ErasureOperatorReceipt)(value);
  expect(Schema.encodeSync(ErasureOperatorReceipt)(decoded)).toEqual(value);
});

it("retains accepted custody evidence and safe unresolved reasons", () => {
  const identity = {
    reference: "10000000-0000-4000-8000-000000000001",
    custodian: "Cloudflare",
    evidenceRef: "10000000-0000-4000-8000-000000000002",
  };
  const outcomes = [
    ...["Accepted", "Verified", "NotApplicable"].map((status) => ({ status })),
    ...["capability-unverified", "retention-conflict", "request-declined"].map((reason) => ({
      status: "Unresolved",
      reason,
    })),
  ];
  for (const outcome of outcomes) {
    const value = { ...identity, outcome };
    expect(
      Schema.encodeSync(ErasureCustodyEvidence)(
        Schema.decodeUnknownSync(ErasureCustodyEvidence)(value)
      )
    ).toEqual(value);
  }
});
