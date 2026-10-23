import {
  ErasureCustodyEvidence,
  ErasureDecision,
  ErasureOperatorReceipt,
  ErasureRequest,
  ErasureRetention,
} from "./contract";
import { Result, Schema } from "effect";
import { expect, it } from "vitest";

const reference = "10000000-0000-4000-8000-000000000001";
const retention = {
  sourceRef: reference,
  reviewRef: reference,
  purpose: "legal-hold",
  untilMs: 2,
  reviewAtMs: 1,
  terminal: "delete",
};

it("requires explicit erasure confirmation and bounded retention deadlines", () => {
  expect(Result.isSuccess(Schema.decodeResult(ErasureRequest)({ confirm: true }))).toBe(true);
  expect(Result.isFailure(Schema.decodeUnknownResult(ErasureRequest)({ confirm: false }))).toBe(
    true
  );
  const decode = Schema.decodeUnknownResult(ErasureRetention);
  expect(Result.isSuccess(decode(retention))).toBe(true);
  for (const field of ["untilMs", "reviewAtMs"] as const) {
    expect(Result.isSuccess(decode({ ...retention, [field]: 253402300799999 }))).toBe(true);
    for (const invalid of [0, -1, 253402300800000]) {
      expect(Result.isFailure(decode({ ...retention, [field]: invalid }))).toBe(true);
    }
  }
});

it("round trips an accountable erasure decision with a disposition for every retained data class", () => {
  const value = {
    reference,
    userId: reference,
    caseRef: reference,
    scopeRef: reference,
    authorityRef: reference,
    handoffRef: reference,
    reviewRef: reference,
    responseRouteRef: reference,
    scope: "current-mvp",
    withdrawal: { status: "NotRequested" },
    dispositions: {
      identity: { action: "Delete" },
      credentials: { action: "Delete" },
      transactions: { action: "Delete" },
      ingestion: { action: "Delete" },
      conversation: { action: "Delete" },
      memory: { action: "Delete" },
      projections: { action: "Delete" },
      schedules: { action: "Delete" },
      billing: { action: "Delete" },
      consent: { action: "Retain", retention },
      audit: { action: "Retain", retention },
    },
    receiptRetention: retention,
    recovery: { sourceRef: reference, reviewRef: reference, windowMs: 604800000, retention },
  };
  const decoded = Schema.decodeUnknownSync(ErasureDecision)(value);
  expect(Schema.encodeSync(ErasureDecision)(decoded)).toEqual(value);
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(ErasureDecision)({
        ...value,
        recovery: { ...value.recovery, windowMs: 2592000000 },
      })
    )
  ).toBe(true);
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(ErasureDecision)({
        ...value,
        recovery: { ...value.recovery, windowMs: 1 },
      })
    )
  ).toBe(true);
});

it("preserves completed, retained and unresolved external evidence in the operator receipt", () => {
  const value = {
    reference,
    responseRouteRef: reference,
    state: "ExternalPending",
    next: "provider-evidence",
    completed: ["transactions"],
    retained: [{ dataClass: "audit", retention }],
    custodians: [
      { custodian: "Cloudflare", status: "Accepted" },
      { custodian: "SupportInbox", status: "Retained", retention },
      { custodian: "CaseEvidence", status: "Unresolved", reason: "capability-unverified" },
    ],
    recoveryUntilMs: null,
    controlRetention: { receipt: retention, recovery: retention },
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
