import { Schema } from "effect";
import { UserId } from "~/core/identity/contract";

export const ErasureReference = Schema.String.check(Schema.isUUID());
export const ErasureRequest = Schema.Struct({
  confirm: Schema.Literal(true),
});
export type ErasureRequest = typeof ErasureRequest.Type;

export const ErasureClass = Schema.Literals([
  "identity",
  "credentials",
  "transactions",
  "ingestion",
  "conversation",
  "memory",
  "projections",
  "schedules",
  "billing",
  "consent",
  "audit",
]);
export type ErasureClass = typeof ErasureClass.Type;
const instant = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 253402300799999 }));
export const ErasureRetention = Schema.Struct({
  sourceRef: ErasureReference,
  reviewRef: ErasureReference,
  purpose: Schema.Literals([
    "legal-hold",
    "statutory-records",
    "contractual-records",
    "rights-response",
    "restore-enforcement",
  ]),
  untilMs: instant,
  reviewAtMs: instant,
  terminal: Schema.Literal("delete"),
});
export const ErasureDisposition = Schema.Union([
  Schema.Struct({ action: Schema.Literal("Delete") }),
  Schema.Struct({ action: Schema.Literal("Retain"), retention: ErasureRetention }),
]);
export const ErasureProvider = Schema.Literals(["Cloudflare", "Kapso", "Meta", "Resend", "Wompi"]);
export type ErasureProvider = typeof ErasureProvider.Type;
export const ErasureCustodian = Schema.Union([
  ErasureProvider,
  Schema.Literals(["SupportInbox", "CaseRegister", "CaseEvidence"]),
]);
const freeRecoveryWindowMs = 604800000;
const paidRecoveryWindowMs = 2592000000;
export const ErasureDecision = Schema.Struct({
  reference: ErasureReference,
  userId: UserId,
  caseRef: ErasureReference,
  scopeRef: ErasureReference,
  authorityRef: ErasureReference,
  handoffRef: ErasureReference,
  reviewRef: ErasureReference,
  responseRouteRef: ErasureReference,
  scope: Schema.Literal("current-mvp"),
  withdrawal: Schema.Union([
    Schema.Struct({ status: Schema.Literal("Recorded"), reference: ErasureReference }),
    Schema.Struct({ status: Schema.Literals(["NotRequested", "Pending", "Unavailable"]) }),
  ]),
  dispositions: Schema.Record(ErasureClass, ErasureDisposition),
  receiptRetention: ErasureRetention,
  recovery: Schema.Struct({
    sourceRef: ErasureReference,
    reviewRef: ErasureReference,
    windowMs: Schema.Literals([freeRecoveryWindowMs, paidRecoveryWindowMs]),
    retention: ErasureRetention,
  }),
});
export type ErasureDecision = typeof ErasureDecision.Type;
export const ErasureCustodyEvidence = Schema.Struct({
  reference: ErasureReference,
  custodian: ErasureCustodian,
  evidenceRef: ErasureReference,
  outcome: Schema.Union([
    Schema.Struct({ status: Schema.Literals(["Accepted", "Verified", "NotApplicable"]) }),
    Schema.Struct({ status: Schema.Literal("Retained"), retention: ErasureRetention }),
    Schema.Struct({
      status: Schema.Literal("Unresolved"),
      reason: Schema.Literals(["capability-unverified", "retention-conflict", "request-declined"]),
    }),
  ]),
});
export type ErasureCustodyEvidence = typeof ErasureCustodyEvidence.Type;

export const ErasureReceipt = Schema.Struct({
  reference: ErasureReference,
  state: Schema.Literals([
    "AwaitingReview",
    "Draining",
    "Sealing",
    "Erasing",
    "ExternalPending",
    "Complete",
  ]),
  next: Schema.Literals([
    "operator-review",
    "admitted-work",
    "connection-suppression",
    "continue",
    "provider-evidence",
    "retention-review",
    "none",
  ]),
});

export const ErasureOperatorReceipt = Schema.Struct({
  reference: ErasureReference,
  responseRouteRef: ErasureReference,
  state: ErasureReceipt.fields.state,
  completed: Schema.Array(ErasureClass),
  retained: Schema.Array(Schema.Struct({ dataClass: ErasureClass, retention: ErasureRetention })),
  custodians: Schema.Array(
    Schema.Union([
      Schema.Struct({
        custodian: ErasureCustodian,
        status: Schema.Literals(["Pending", "Accepted", "Verified", "NotApplicable"]),
      }),
      Schema.Struct({
        custodian: ErasureCustodian,
        status: Schema.Literal("Retained"),
        retention: ErasureRetention,
      }),
      Schema.Struct({
        custodian: ErasureCustodian,
        status: Schema.Literal("Unresolved"),
        reason: Schema.Literals([
          "capability-unverified",
          "retention-conflict",
          "request-declined",
        ]),
      }),
    ])
  ),
  recoveryUntilMs: Schema.NullOr(instant),
  controlRetention: Schema.Struct({ receipt: ErasureRetention, recovery: ErasureRetention }),
  next: ErasureReceipt.fields.next,
});
