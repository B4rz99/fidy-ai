import { DateTime, type Effect, Option, Schema } from "effect";
import { CategoryId } from "~/core/categories/reference";
import { UserId } from "~/core/identity/reference";
import { InterpretationRevision } from "~/core/_shared/interpretation-revision";
import { ProviderMessageEvidence } from "~/core/_shared/provider-message-evidence";
import { Money, encodeMoneyAmount } from "~/core/_shared/money";
import {
  Counterparty,
  NotificationEmailSourceAttestation,
  SourceAttestation,
  SourceAttestationCommon,
  StatementLineSourceAttestation,
  Transaction,
  TransactionId,
} from "~/core/transactions/model";

/** Relational Transaction projection decoded before reconstruction into the canonical model. */
export const TransactionFlatRow = Schema.Struct({
  id: Schema.toEncoded(Transaction.fields.id),
  ...Money.fields,
  counterparty: Schema.OptionFromNullOr(Counterparty),
  direction: Transaction.fields.direction,
  categoryId: Schema.toEncoded(CategoryId),
  notes: Schema.OptionFromNullOr(Schema.String),
  occurredAt: Schema.DateTimeUtcFromDate,
  createdAt: Schema.DateTimeUtcFromDate,
});

const decodeTransaction = Schema.decodeUnknownEffect(Transaction);
const counterpartyFact = (
  counterparty: Option.Option<Counterparty>
): {} | { counterparty: string } =>
  Option.match(counterparty, {
    onNone: () => ({}),
    onSome: (value) => ({ counterparty: value }),
  });
const notesFact = (notes: Option.Option<string>): {} | { notes: string } =>
  Option.match(notes, {
    onNone: () => ({}),
    onSome: (value) => ({ notes: value }),
  });
/** Reconstructs canonical nested Money and optional facts from one decoded relational row. */
export const transactionFromRow = ({
  amount,
  counterparty,
  currency,
  notes,
  ...transaction
}: typeof TransactionFlatRow.Type): Effect.Effect<Transaction, Schema.SchemaError> =>
  decodeTransaction({
    ...transaction,
    ...counterpartyFact(counterparty),
    ...notesFact(notes),
    occurredAt: DateTime.formatIso(transaction.occurredAt),
    createdAt: DateTime.formatIso(transaction.createdAt),
    money: { amount: encodeMoneyAmount(amount), currency },
  });

/** User-owned lookup decoded before Transaction persistence access. */
export const TransactionLookup = Schema.Struct({ id: TransactionId, userId: UserId });

/** Stable relational projection shared by Transaction reads and writes. */
export const transactionColumns = `id, amount, currency, counterparty, direction,
  category_id AS "categoryId", notes, occurred_at AS "occurredAt", created_at AS "createdAt"`;

/** Closed relational projection shared by SourceAttestation reads and immutable inserts. */
export const SourceAttestationRow = Schema.Struct({
  id: Schema.toEncoded(SourceAttestationCommon.fields.id),
  transactionId: Schema.toEncoded(TransactionId),
  kind: Schema.Literals(["manual", "statement-line", "notification-email"]),
  serviceMarket: SourceAttestationCommon.fields.serviceMarket,
  locale: SourceAttestationCommon.fields.locale,
  timeZone: Schema.toEncoded(SourceAttestationCommon.fields.timeZone),
  sourceChannel: Schema.OptionFromNullOr(Schema.String),
  sourceProvider: Schema.OptionFromNullOr(Schema.String),
  interpretationRevision: Schema.toEncoded(InterpretationRevision),
  statementSubmissionId: Schema.OptionFromNullOr(
    StatementLineSourceAttestation.fields.statementSubmissionId
  ),
  statementRecordNumber: Schema.OptionFromNullOr(Schema.Int),
  statementContentHash: Schema.OptionFromNullOr(Schema.String),
  sourceFormat: Schema.OptionFromNullOr(
    Schema.Union([
      StatementLineSourceAttestation.fields.sourceFormat,
      NotificationEmailSourceAttestation.fields.sourceFormat,
    ])
  ),
  extractorRevision: Schema.OptionFromNullOr(InterpretationRevision),
  receivedEmailId: Schema.OptionFromNullOr(
    NotificationEmailSourceAttestation.fields.receivedEmailId
  ),
  messageChannel: Schema.OptionFromNullOr(ProviderMessageEvidence.fields.channel),
  messageProvider: Schema.OptionFromNullOr(ProviderMessageEvidence.fields.provider),
  providerMessageId: Schema.OptionFromNullOr(ProviderMessageEvidence.fields.providerMessageId),
  messageContentSha256: Schema.OptionFromNullOr(
    NotificationEmailSourceAttestation.fields.messageContentSha256
  ),
  createdAt: Schema.DateTimeUtcFromDate,
});

const decodeSourceAttestation = Schema.decodeUnknownEffect(SourceAttestation);

/** Reconstructs the canonical SourceAttestation variant from one decoded relational row. */
export const sourceAttestationFromRow = (
  source: typeof SourceAttestationRow.Type
): Effect.Effect<SourceAttestation, Schema.SchemaError> => {
  const {
    sourceChannel,
    sourceProvider,
    statementSubmissionId,
    statementRecordNumber,
    statementContentHash,
    sourceFormat,
    extractorRevision,
    receivedEmailId,
    messageChannel,
    messageProvider,
    providerMessageId,
    messageContentSha256,
    ...row
  } = source;
  const attestationBase = {
    ...row,
    ...(Option.isSome(sourceChannel) ? { sourceChannel: sourceChannel.value } : {}),
    ...(Option.isSome(sourceProvider) ? { sourceProvider: sourceProvider.value } : {}),
    createdAt: DateTime.formatIso(row.createdAt),
  };
  switch (source.kind) {
    case "manual":
      return decodeSourceAttestation(attestationBase);
    case "statement-line":
      return decodeSourceAttestation({
        ...attestationBase,
        statementSubmissionId: Option.getOrThrow(statementSubmissionId),
        statementRecordNumber: Option.getOrThrow(statementRecordNumber),
        statementContentHash: Option.getOrThrow(statementContentHash),
        sourceFormat: Option.getOrThrow(sourceFormat),
        extractorRevision: Option.getOrThrow(extractorRevision),
      });
    case "notification-email":
      return decodeSourceAttestation({
        ...attestationBase,
        receivedEmailId: Option.getOrThrow(receivedEmailId),
        messageEvidence: Option.getOrThrow(
          Option.all({
            channel: messageChannel,
            provider: messageProvider,
            providerMessageId,
          })
        ),
        messageContentSha256: Option.getOrThrow(messageContentSha256),
        sourceFormat: Option.getOrThrow(sourceFormat),
        extractorRevision: Option.getOrThrow(extractorRevision),
      });
  }
};

/** Stable SourceAttestation columns and aliases consumed by every relational projection. */
export const sourceAttestationColumns = `id, transaction_id AS "transactionId", kind,
  service_market AS "serviceMarket", locale, time_zone AS "timeZone",
  source_channel AS "sourceChannel", source_provider AS "sourceProvider",
  interpretation_revision AS "interpretationRevision",
  statement_submission_id AS "statementSubmissionId",
  statement_record_number AS "statementRecordNumber",
  statement_content_hash AS "statementContentHash", source_format AS "sourceFormat",
  extractor_revision AS "extractorRevision", received_email_id AS "receivedEmailId",
  message_channel AS "messageChannel", message_provider AS "messageProvider",
  provider_message_id AS "providerMessageId",
  message_content_sha256 AS "messageContentSha256", created_at AS "createdAt"`;
