import { ErasureDecision } from "../../src/core/erasure/contract";
import { UserId } from "../../src/core/identity/contract";

const retentionMilliseconds = 3456000000;
const recoveryWindowMilliseconds = 604800000;
const hourMilliseconds = 3600000;

const opaque = "12740000-0000-4000-8000-000000000003";
export const deletionDecision = (
  input: Readonly<{ userId: string; reference: string; current: number }>
): ErasureDecision => {
  const deletion = { action: "Delete" } as const;
  return ErasureDecision.make({
    reference: input.reference,
    userId: UserId.make(input.userId),
    caseRef: opaque,
    scopeRef: opaque,
    authorityRef: opaque,
    handoffRef: opaque,
    reviewRef: opaque,
    scope: "current-mvp",
    withdrawal: { status: "NotRequested" },
    dispositions: {
      identity: deletion,
      credentials: deletion,
      transactions: deletion,
      ingestion: deletion,
      conversation: deletion,
      memory: deletion,
      projections: deletion,
      schedules: deletion,
      billing: deletion,
      consent: deletion,
      audit: deletion,
    },
    responseRouteRef: opaque,
    recovery: {
      sourceRef: opaque,
      reviewRef: opaque,
      windowMs: recoveryWindowMilliseconds,
      retention: {
        sourceRef: opaque,
        reviewRef: opaque,
        purpose: "restore-enforcement",
        untilMs: input.current + retentionMilliseconds,
        reviewAtMs: input.current + hourMilliseconds,
        terminal: "delete",
      },
    },
    receiptRetention: {
      sourceRef: opaque,
      reviewRef: opaque,
      purpose: "rights-response",
      untilMs: input.current + retentionMilliseconds,
      reviewAtMs: input.current + hourMilliseconds,
      terminal: "delete",
    },
  });
};
