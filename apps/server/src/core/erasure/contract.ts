import { Schema } from "effect";

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
export const ErasureProvider = Schema.Literals(["Cloudflare", "Kapso", "Meta", "Resend", "Wompi"]);
export type ErasureProvider = typeof ErasureProvider.Type;
export const ErasureCustodian = ErasureProvider;
const instant = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 253402300799999 }));
export const ErasureCustodyEvidence = Schema.Struct({
  reference: ErasureReference,
  custodian: ErasureCustodian,
  evidenceRef: ErasureReference,
  outcome: Schema.Union([
    Schema.Struct({ status: Schema.Literals(["Accepted", "Verified", "NotApplicable"]) }),
    Schema.Struct({
      status: Schema.Literal("Unresolved"),
      reason: Schema.Literals(["capability-unverified", "retention-conflict", "request-declined"]),
    }),
  ]),
});
export type ErasureCustodyEvidence = typeof ErasureCustodyEvidence.Type;
export const ErasureReceipt = Schema.Struct({
  reference: ErasureReference,
  state: Schema.Literals(["Draining", "Sealing", "Erasing", "ExternalPending", "Complete"]),
  next: Schema.Literals([
    "admitted-work",
    "connection-suppression",
    "continue",
    "provider-evidence",
    "none",
  ]),
});
export const ErasureOperatorReceipt = Schema.Struct({
  ...ErasureReceipt.fields,
  completed: Schema.Array(ErasureClass),
  custodians: Schema.Array(
    Schema.Union([
      Schema.Struct({
        custodian: ErasureCustodian,
        status: Schema.Literals(["Pending", "Accepted", "Verified", "NotApplicable"]),
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
});
