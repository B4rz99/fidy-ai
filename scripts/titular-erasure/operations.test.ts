import { expect, it } from "vitest";
import { Effect, Option, Schema } from "effect";
import { ErasureDecision } from "../../apps/server/src/core/erasure/contract";
import { applyCaseCommand } from "../titular-requests/operations";
import { prepareErasureReview } from "./operations";

const ref = (value: number): string => `12740000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const current = 1792083600000;
const retention = {
  sourceRef: ref(3),
  reviewRef: ref(3),
  purpose: "rights-response",
  untilMs: current + 3456000000,
  reviewAtMs: current + 3600000,
  terminal: "delete",
} as const;
const decision = Schema.decodeSync(ErasureDecision)({
  userId: ref(1),
  reference: ref(2),
  caseRef: ref(3),
  scopeRef: ref(3),
  authorityRef: ref(3),
  handoffRef: ref(3),
  reviewRef: ref(3),
  responseRouteRef: ref(3),
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
    consent: { action: "Delete" },
    audit: { action: "Delete" },
  },
  receiptRetention: retention,
  recovery: {
    sourceRef: ref(3),
    reviewRef: ref(3),
    windowMs: 604800000,
    retention: { ...retention, purpose: "restore-enforcement" },
  },
});
const verifiedCase = Effect.gen(function* () {
  const received = yield* applyCaseCommand({
    previous: Option.none(),
    atMs: current,
    command: {
      action: "Receive",
      commandId: ref(10),
      caseId: decision.caseRef,
      ownerRef: ref(11),
      requestRef: ref(12),
      scopeRef: decision.scopeRef,
      requester: "User",
      kind: "Erasure",
      receivedAtMs: current,
    },
  });
  const verified = yield* applyCaseCommand({
    previous: Option.some(received),
    atMs: current,
    command: {
      action: "RecordVerification",
      caseId: decision.caseRef,
      commandId: ref(13),
      revision: received.revision,
      evidenceRef: decision.authorityRef,
    },
  });
  return yield* applyCaseCommand({
    previous: Option.some(verified),
    atMs: current,
    command: {
      action: "ReferErasure",
      caseId: decision.caseRef,
      commandId: ref(14),
      revision: verified.revision,
      evidenceRef: decision.handoffRef,
      withdrawal: { status: "NotRequested" },
    },
  });
});
it("consumes the verified case handoff without inventing withdrawal or accepting unrelated evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const registered = yield* verifiedCase;
      expect(yield* prepareErasureReview({ case: registered, decision })).toEqual({
        action: "Review",
        decision,
      });
      for (const changed of [
        { ...decision, caseRef: ref(20) },
        { ...decision, scopeRef: ref(20) },
        { ...decision, authorityRef: ref(20) },
        { ...decision, handoffRef: ref(20) },
        { ...decision, withdrawal: { status: "Recorded" as const, reference: ref(20) } },
      ]) {
        expect(
          (yield* Effect.result(prepareErasureReview({ case: registered, decision: changed })))._tag
        ).toBe("Failure");
      }
      expect(
        (yield* Effect.result(
          prepareErasureReview({
            case: { ...registered, verificationRef: Option.none() },
            decision,
          })
        ))._tag
      ).toBe("Failure");
      expect(
        (yield* Effect.result(
          prepareErasureReview({ case: { ...registered, requester: "Representative" }, decision })
        ))._tag
      ).toBe("Failure");
      expect(
        (yield* Effect.result(
          prepareErasureReview({ case: { ...registered, erasureHandoff: Option.none() }, decision })
        ))._tag
      ).toBe("Failure");
    })
  ));
