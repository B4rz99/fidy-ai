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
import {
  type AccountHints,
  InstrumentLabel,
  LastFourDigits,
  NotificationCurrencyBasis,
  NotificationFormatId,
} from "~/core/transactions/account-hints";

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
  notificationFormatId: Schema.OptionFromNullOr(NotificationFormatId),
  currencyBasis: Schema.OptionFromNullOr(NotificationCurrencyBasis),
  cardLastFour: Schema.OptionFromNullOr(LastFourDigits),
  accountLastFour: Schema.OptionFromNullOr(LastFourDigits),
  instrumentLabel: Schema.OptionFromNullOr(InstrumentLabel),
  createdAt: Schema.DateTimeUtcFromDate,
});

const decodeSourceAttestation = Schema.decodeUnknownEffect(SourceAttestation);

type SourceAttestationRowType = typeof SourceAttestationRow.Type;
type AttestationBase = typeof SourceAttestationCommon.Encoded & {
  readonly kind: SourceAttestationRowType["kind"];
};
type DeterministicInterpretationProperty = Pick<
  typeof NotificationEmailSourceAttestation.Encoded,
  "deterministicInterpretation"
>;

const attestationBaseFromRow = (source: SourceAttestationRowType): AttestationBase => ({
  id: source.id,
  transactionId: source.transactionId,
  kind: source.kind,
  serviceMarket: source.serviceMarket,
  locale: source.locale,
  timeZone: source.timeZone,
  interpretationRevision: source.interpretationRevision,
  ...(Option.isSome(source.sourceChannel) ? { sourceChannel: source.sourceChannel.value } : {}),
  ...(Option.isSome(source.sourceProvider) ? { sourceProvider: source.sourceProvider.value } : {}),
  createdAt: DateTime.formatIso(source.createdAt),
});

const accountHintsFromRow = (source: SourceAttestationRowType): typeof AccountHints.Encoded => ({
  ...(Option.isSome(source.cardLastFour) ? { cardLastFour: source.cardLastFour.value } : {}),
  ...(Option.isSome(source.accountLastFour)
    ? { accountLastFour: source.accountLastFour.value }
    : {}),
  ...(Option.isSome(source.instrumentLabel)
    ? { instrumentLabel: source.instrumentLabel.value }
    : {}),
});

const deterministicInterpretationFromRow = (
  source: SourceAttestationRowType
): DeterministicInterpretationProperty =>
  Option.match(
    Option.all({ formatId: source.notificationFormatId, currencyBasis: source.currencyBasis }),
    {
      onNone: () => ({}),
      onSome: ({ formatId, currencyBasis }) => ({
        deterministicInterpretation: {
          formatId,
          currencyBasis,
          accountHints: accountHintsFromRow(source),
        },
      }),
    }
  );

/** Reconstructs the canonical SourceAttestation variant from one decoded relational row. */
export const sourceAttestationFromRow = (
  source: SourceAttestationRowType
): Effect.Effect<SourceAttestation, Schema.SchemaError> => {
  const attestationBase = attestationBaseFromRow(source);
  switch (source.kind) {
    case "manual":
      return decodeSourceAttestation(attestationBase);
    case "statement-line":
      return decodeSourceAttestation({
        ...attestationBase,
        statementSubmissionId: Option.getOrThrow(source.statementSubmissionId),
        statementRecordNumber: Option.getOrThrow(source.statementRecordNumber),
        statementContentHash: Option.getOrThrow(source.statementContentHash),
        sourceFormat: Option.getOrThrow(source.sourceFormat),
        extractorRevision: Option.getOrThrow(source.extractorRevision),
      });
    case "notification-email":
      return decodeSourceAttestation({
        ...attestationBase,
        receivedEmailId: Option.getOrThrow(source.receivedEmailId),
        messageEvidence: Option.getOrThrow(
          Option.all({
            channel: source.messageChannel,
            provider: source.messageProvider,
            providerMessageId: source.providerMessageId,
          })
        ),
        messageContentSha256: Option.getOrThrow(source.messageContentSha256),
        sourceFormat: Option.getOrThrow(source.sourceFormat),
        extractorRevision: Option.getOrThrow(source.extractorRevision),
        ...deterministicInterpretationFromRow(source),
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
  message_content_sha256 AS "messageContentSha256",
  notification_format_id AS "notificationFormatId", currency_basis AS "currencyBasis",
  card_last_four AS "cardLastFour", account_last_four AS "accountLastFour",
  instrument_label AS "instrumentLabel", created_at AS "createdAt"`;
