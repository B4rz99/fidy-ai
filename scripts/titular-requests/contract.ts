import { Data, Schema } from "effect";

/** Opaque references address restricted evidence; they never confer User authority. */
export const EvidenceReference = Schema.String.check(Schema.isUUID());
export const LocalDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u));
export const RequestKind = Schema.Literals([
  "Access",
  "AuthorizationProof",
  "UseExplanation",
  "Correction",
  "Complaint",
  "Withdrawal",
  "Erasure",
]);
export const RequesterKind = Schema.Literals(["User", "NonUser", "Representative"]);
const responsePrepared = { responseRef: EvidenceReference };
const deliveryEvidence = { ...responsePrepared, evidenceRef: EvidenceReference };
export const ResponseDelivery = Schema.Union([
  Schema.Struct({ status: Schema.Literal("NotPrepared") }),
  Schema.Struct({ status: Schema.Literal("Pending"), ...responsePrepared }),
  Schema.Struct({ status: Schema.Literal("Failed"), ...deliveryEvidence }),
  Schema.Struct({ status: Schema.Literal("Uncertain"), ...deliveryEvidence }),
  Schema.Struct({ status: Schema.Literal("Confirmed"), ...deliveryEvidence }),
]);

const addressed = { commandId: EvidenceReference, caseId: EvidenceReference };
const transition = { ...addressed, revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) };
export const CaseCommand = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("Receive"),
    ...addressed,
    ownerRef: EvidenceReference,
    requestRef: EvidenceReference,
    scopeRef: EvidenceReference,
    requester: RequesterKind,
    kind: RequestKind,
    receivedAtMs: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  Schema.Struct({ action: Schema.Literal("Assign"), ...transition, ownerRef: EvidenceReference }),
  Schema.Struct({
    action: Schema.Literal("RequestCompletion"),
    ...transition,
    evidenceRef: EvidenceReference,
  }),
  Schema.Struct({
    action: Schema.Literal("RecordCompletion"),
    ...transition,
    evidenceRef: EvidenceReference,
  }),
  Schema.Struct({
    action: Schema.Literal("RecordVerification"),
    ...transition,
    evidenceRef: EvidenceReference,
  }),
  Schema.Struct({
    action: Schema.Literal("RecordOwnerResult"),
    ...transition,
    evidenceRef: EvidenceReference,
  }),
  Schema.Struct({
    action: Schema.Literal("RecordWithdrawal"),
    ...transition,
    evidenceRef: EvidenceReference,
  }),
  Schema.Struct({
    action: Schema.Literal("ReferErasure"),
    ...transition,
    evidenceRef: EvidenceReference,
  }),
  Schema.Struct({
    action: Schema.Literal("PrepareResponse"),
    ...transition,
    evidenceRef: EvidenceReference,
  }),
  Schema.Struct({
    action: Schema.Literal("DeliveryFailed"),
    ...transition,
    evidenceRef: EvidenceReference,
  }),
  Schema.Struct({
    action: Schema.Literal("DeliveryUncertain"),
    ...transition,
    evidenceRef: EvidenceReference,
  }),
  Schema.Struct({
    action: Schema.Literal("RecordResponse"),
    ...transition,
    evidenceRef: EvidenceReference,
  }),
  Schema.Struct({
    action: Schema.Literal("Extend"),
    ...transition,
    notificationRef: EvidenceReference,
    reasonRef: EvidenceReference,
    responseDate: LocalDate,
  }),
]);
export type CaseCommand = typeof CaseCommand.Type;

/** Manual case metadata, never an authentication decision or proof of completed data deletion. */
export const TitularCase = Schema.Struct({
  caseId: EvidenceReference,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ownerRef: EvidenceReference,
  requestRef: EvidenceReference,
  scopeRef: EvidenceReference,
  requester: RequesterKind,
  kind: RequestKind,
  receivedDate: LocalDate,
  receivedAtMs: Schema.Int,
  updatedAtMs: Schema.Int,
  completion: Schema.OptionFromNullOr(
    Schema.Struct({ evidenceRef: EvidenceReference, requestedAtMs: Schema.Int })
  ),
  completed: Schema.OptionFromNullOr(
    Schema.Struct({ evidenceRef: EvidenceReference, completedAtMs: Schema.Int })
  ),
  verificationRef: Schema.OptionFromNullOr(EvidenceReference),
  ownerResultRef: Schema.OptionFromNullOr(EvidenceReference),
  withdrawalRef: Schema.OptionFromNullOr(EvidenceReference),
  erasureHandoffRef: Schema.OptionFromNullOr(EvidenceReference),
  delivery: ResponseDelivery,
  extension: Schema.OptionFromNullOr(
    Schema.Struct({
      notificationRef: EvidenceReference,
      reasonRef: EvidenceReference,
      responseDate: LocalDate,
    })
  ),
});
export type TitularCase = typeof TitularCase.Type;
export const RegisterRequest = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("Apply"), command: CaseCommand }),
  Schema.Struct({ operation: Schema.Literal("Read"), caseId: TitularCase.fields.caseId }),
]);
export const CaseReceipt = Schema.Struct({
  case: TitularCase,
  authority: Schema.Literal("manual-record-only"),
  deletion: Schema.Literal("not-performed"),
  targets: Schema.Struct({
    provisional: Schema.Literal(true),
    calendar: Schema.Literal("CO-2026-2027-saturdays-counted"),
    response: Schema.OptionFromNullOr(LocalDate),
    maximumExtension: Schema.OptionFromNullOr(LocalDate),
    completion: Schema.OptionFromNullOr(LocalDate),
    transfer: Schema.OptionFromNullOr(LocalDate),
    calendarReviewRequired: Schema.Boolean,
  }),
});
export type CaseReceipt = typeof CaseReceipt.Type;

/** Closed local failures contain no request body, personal evidence, path, or storage diagnostics. */
export class RegisterFailure extends Data.TaggedError("RegisterFailure")<{
  reason: "InvalidInput" | "Conflict" | "InvalidTransition" | "UnsafeStorage" | "Unavailable";
}> {}
