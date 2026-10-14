import { Schema } from "effect";
import { UtcTimestamp } from "~/core/_shared/time";
import {
  CapturedInterpretationContext,
  InterpretationRevision,
} from "~/core/interpretation-evidence/contract";
import { ProviderMessageEvidence } from "~/core/provider-evidence/contract";
import {
  EmailSourceFormat,
  ReceivedEmailId,
  StatementSourceFormat,
  StatementSubmissionId,
} from "~/core/ingestion/contract";
import { NotificationInterpretationEvidence, TransactionId } from "~/core/transactions/contract";

const maximumAttestationNameLength = 80;

export const SourceAttestationId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("SourceAttestationId"))
  .annotate({ identifier: "SourceAttestationId" });
export type SourceAttestationId = typeof SourceAttestationId.Type;

const SourceName = Schema.NonEmptyString.check(Schema.isTrimmed()).check(
  Schema.isMaxLength(maximumAttestationNameLength)
);

export const SourceAttestationCommon = Schema.Struct({
  id: SourceAttestationId,
  transactionId: TransactionId,
  ...CapturedInterpretationContext.fields,
  sourceChannel: Schema.OptionFromOptionalKey(SourceName),
  sourceProvider: Schema.OptionFromOptionalKey(SourceName),
  interpretationRevision: InterpretationRevision,
  createdAt: UtcTimestamp,
});

const ManualSourceAttestation = Schema.Struct({
  ...SourceAttestationCommon.fields,
  kind: Schema.Literal("manual"),
});

export const StatementLineSourceAttestation = Schema.Struct({
  ...SourceAttestationCommon.fields,
  kind: Schema.Literal("statement-line"),
  statementSubmissionId: StatementSubmissionId,
  statementRecordNumber: Schema.Int.check(Schema.isGreaterThan(0)),
  statementContentHash: Schema.NonEmptyString,
  sourceFormat: StatementSourceFormat,
  extractorRevision: InterpretationRevision,
});
export type StatementLineSourceAttestation = typeof StatementLineSourceAttestation.Type;

export const NotificationEmailSourceAttestation = Schema.Struct({
  ...SourceAttestationCommon.fields,
  kind: Schema.Literal("notification-email"),
  receivedEmailId: ReceivedEmailId,
  messageEvidence: ProviderMessageEvidence,
  messageContentSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  sourceFormat: EmailSourceFormat,
  extractorRevision: InterpretationRevision,
  deterministicInterpretation: Schema.OptionFromOptionalKey(NotificationInterpretationEvidence),
});
export type NotificationEmailSourceAttestation = typeof NotificationEmailSourceAttestation.Type;

/** Immutable evidence of the context and mechanism that interpreted one Transaction. */
export const SourceAttestation = Schema.Union([
  ManualSourceAttestation,
  StatementLineSourceAttestation,
  NotificationEmailSourceAttestation,
]).annotate({ identifier: "SourceAttestation" });
export type SourceAttestation = typeof SourceAttestation.Type;
