import { Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import type { CapturedInterpretationContext } from "~/core/_shared/captured-interpretation-context";
import { InterpretationRevision } from "~/core/_shared/interpretation-revision";
import { TransactionUserDecisions } from "~/core/transactions/user-decisions";
import { Money } from "~/core/_shared/money";
import { CategoryId } from "~/core/categories/reference";
import { UserId } from "~/core/identity/reference";
import {
  SourceAttestationRow,
  TransactionFlatRow,
  TransactionLookup,
  sourceAttestationColumns,
  sourceAttestationFromRow,
  transactionColumns,
  transactionFromRow,
} from "./rows";
import {
  Counterparty,
  NotificationEmailSourceAttestation,
  SourceAttestationCommon,
  StatementLineSourceAttestation,
  Transaction,
  TransactionId,
  type UpdateTransactionInput,
} from "~/core/transactions/model";

const TransactionWriteRow = Schema.Struct({
  userId: UserId,
  ...Money.fields,
  counterparty: Schema.OptionFromNullOr(Counterparty),
  direction: Transaction.fields.direction,
  categoryId: CategoryId,
  notes: Schema.OptionFromNullOr(Schema.String),
  occurredAt: Schema.DateTimeUtc,
  categoryUserDecided: TransactionUserDecisions.fields.category,
  counterpartyUserDecided: TransactionUserDecisions.fields.counterparty,
  notesUserDecided: TransactionUserDecisions.fields.notes,
});

/** Normalized Transaction facts paired with private User-decision bookkeeping. */
export type TransactionWrite = Readonly<{
  facts: UpdateTransactionInput;
  userDecisions: TransactionUserDecisions;
}>;

const writeRow = (userId: UserId, write: TransactionWrite): typeof TransactionWriteRow.Type => ({
  userId,
  ...write.facts.money,
  counterparty: write.facts.counterparty,
  direction: write.facts.direction,
  categoryId: write.facts.categoryId,
  notes: write.facts.notes,
  occurredAt: write.facts.occurredAt,
  categoryUserDecided: write.userDecisions.category,
  counterpartyUserDecided: write.userDecisions.counterparty,
  notesUserDecided: write.userDecisions.notes,
});

/** Inserts one valid normalized Transaction inside the caller's User-scoped transaction. */
export const insertTransactionInScope = Effect.fn("insertTransactionInScope")(function* (
  userId: UserId,
  write: TransactionWrite
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: TransactionWriteRow,
    Result: TransactionFlatRow,
    execute: (row) => sql`
      INSERT INTO transactions (
        user_id, amount, currency, counterparty, direction, category_id, notes, occurred_at,
        category_user_decided, counterparty_user_decided, notes_user_decided
      ) VALUES (
        ${row.userId}, ${row.amount}, ${row.currency}, ${row.counterparty}, ${row.direction},
        ${row.categoryId}, ${row.notes}, ${row.occurredAt}, ${row.categoryUserDecided},
        ${row.counterpartyUserDecided}, ${row.notesUserDecided}
      )
      RETURNING ${sql.literal(transactionColumns)}
    `,
  })(writeRow(userId, write)).pipe(Effect.flatMap(transactionFromRow), Effect.orDie);
});

/**
 * Replaces editable facts for one active Transaction owned by `userId` inside the caller's active
 * User-scoped transaction. Returns `None` when `transactionId` is absent, foreign, or deleted. The
 * caller establishes the matching User context and owns commit or rollback; database failures are
 * defects.
 */
export const updateTransactionInScope = Effect.fn("updateTransactionInScope")(function* (
  userId: UserId,
  transactionId: TransactionId,
  write: TransactionWrite
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Struct({ ...TransactionWriteRow.fields, transactionId: TransactionId }),
    Result: TransactionFlatRow,
    execute: (row) => sql`
      UPDATE transactions SET
        amount = ${row.amount}, currency = ${row.currency}, counterparty = ${row.counterparty},
        direction = ${row.direction}, category_id = ${row.categoryId}, notes = ${row.notes},
        occurred_at = ${row.occurredAt},
        category_user_decided = ${row.categoryUserDecided},
        counterparty_user_decided = ${row.counterpartyUserDecided},
        notes_user_decided = ${row.notesUserDecided}
      WHERE id = ${row.transactionId} AND user_id = ${row.userId} AND deleted_at IS NULL
      RETURNING ${sql.literal(transactionColumns)}
    `,
  })({ ...writeRow(userId, write), transactionId }).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none()),
        onSome: (row) => transactionFromRow(row).pipe(Effect.map(Option.some)),
      })
    ),
    Effect.orDie
  );
});

/**
 * Hides one active Transaction owned by `userId` inside the caller's active User-scoped
 * transaction. Returns `None` when `id` is absent, foreign, or already deleted. The caller
 * establishes the matching User context and owns commit or rollback; database failures are defects.
 */
export const softDeleteTransactionInScope = Effect.fn("softDeleteTransactionInScope")(function* (
  userId: UserId,
  id: TransactionId
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: TransactionLookup,
    Result: Schema.Struct({ id: TransactionId }),
    execute: (request) => sql`
      UPDATE transactions SET deleted_at = now()
      WHERE id = ${request.id} AND user_id = ${request.userId} AND deleted_at IS NULL
      RETURNING id
    `,
  })({ id, userId }).pipe(Effect.map(Option.map((row) => row.id)), Effect.orDie);
});

/**
 * Records immutable manual provenance for `transactionId`, which must belong to `userId`. The
 * caller supplies the active User-scoped transaction; the attestation commits or rolls back with
 * that transaction. A missing matching Transaction or a database failure is treated as a defect.
 */
export const insertManualSourceAttestationInScope = Effect.fn(
  "insertManualSourceAttestationInScope"
)(function* (userId: UserId, transactionId: TransactionId, context: CapturedInterpretationContext) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: Schema.Struct({
      userId: UserId,
      transactionId: TransactionId,
      serviceMarket: SourceAttestationCommon.fields.serviceMarket,
      locale: SourceAttestationCommon.fields.locale,
      timeZone: SourceAttestationCommon.fields.timeZone,
    }),
    Result: SourceAttestationRow,
    execute: (row) => sql`
      INSERT INTO source_attestations
        (transaction_id, kind, service_market, locale, time_zone, interpretation_revision)
      SELECT transaction.id, 'manual', ${row.serviceMarket}, ${row.locale}, ${row.timeZone}, 'manual-v1'
      FROM transactions transaction
      WHERE transaction.id = ${row.transactionId} AND transaction.user_id = ${row.userId}
      RETURNING ${sql.literal(sourceAttestationColumns)}
    `,
  })({ userId, transactionId, ...context }).pipe(
    Effect.flatMap(sourceAttestationFromRow),
    Effect.orDie
  );
});

/** Facts retained for one accepted or later-resolved statement line. */
export type StatementLineAttestationInput = Readonly<
  Pick<
    StatementLineSourceAttestation,
    | "serviceMarket"
    | "locale"
    | "timeZone"
    | "statementSubmissionId"
    | "statementRecordNumber"
    | "statementContentHash"
    | "sourceFormat"
    | "extractorRevision"
  > & { readonly parserRevision: InterpretationRevision }
>;

/** Inserts immutable statement-line provenance in the caller-owned User transaction. */
export const insertStatementLineSourceAttestationInScope = Effect.fn(
  "insertStatementLineSourceAttestationInScope"
)(function* (userId: UserId, transactionId: TransactionId, input: StatementLineAttestationInput) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: Schema.Struct({
      userId: UserId,
      transactionId: TransactionId,
      serviceMarket: StatementLineSourceAttestation.fields.serviceMarket,
      locale: StatementLineSourceAttestation.fields.locale,
      timeZone: StatementLineSourceAttestation.fields.timeZone,
      statementSubmissionId: StatementLineSourceAttestation.fields.statementSubmissionId,
      statementRecordNumber: Schema.Int.check(Schema.isGreaterThan(0)),
      statementContentHash: Schema.NonEmptyString,
      sourceFormat: StatementLineSourceAttestation.fields.sourceFormat,
      parserRevision: InterpretationRevision,
      extractorRevision: InterpretationRevision,
    }),
    Result: SourceAttestationRow,
    execute: (row) => sql`
      INSERT INTO source_attestations (
        transaction_id, kind, service_market, locale, time_zone, source_channel,
        interpretation_revision, statement_submission_id, statement_record_number,
        statement_content_hash, source_format, extractor_revision
      )
      SELECT transaction.id, 'statement-line', ${row.serviceMarket}, ${row.locale},
        ${row.timeZone}, 'statement-upload', ${row.parserRevision},
        ${row.statementSubmissionId}, ${row.statementRecordNumber}, ${row.statementContentHash},
        ${row.sourceFormat}, ${row.extractorRevision}
      FROM transactions transaction
      WHERE transaction.id = ${row.transactionId} AND transaction.user_id = ${row.userId}
      RETURNING ${sql.literal(sourceAttestationColumns)}
    `,
  })({ userId, transactionId, ...input }).pipe(
    Effect.flatMap(sourceAttestationFromRow),
    Effect.orDie
  );
});

/** Facts retained for one Transaction extracted from an authenticated notification email. */
export type NotificationEmailAttestationInput = Readonly<
  Pick<
    NotificationEmailSourceAttestation,
    | "serviceMarket"
    | "locale"
    | "timeZone"
    | "receivedEmailId"
    | "messageEvidence"
    | "messageContentSha256"
    | "sourceFormat"
    | "extractorRevision"
  > & { readonly parserRevision: InterpretationRevision }
>;

/** Inserts immutable notification-email provenance in the caller-owned User transaction. */
export const insertNotificationEmailSourceAttestationInScope = Effect.fn(
  "insertNotificationEmailSourceAttestationInScope"
)(function* (
  userId: UserId,
  transactionId: TransactionId,
  input: NotificationEmailAttestationInput
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: Schema.Struct({
      userId: UserId,
      transactionId: TransactionId,
      serviceMarket: NotificationEmailSourceAttestation.fields.serviceMarket,
      locale: NotificationEmailSourceAttestation.fields.locale,
      timeZone: NotificationEmailSourceAttestation.fields.timeZone,
      receivedEmailId: NotificationEmailSourceAttestation.fields.receivedEmailId,
      messageChannel: Schema.String,
      messageProvider: Schema.String,
      providerMessageId: Schema.String,
      messageContentSha256: NotificationEmailSourceAttestation.fields.messageContentSha256,
      sourceFormat: NotificationEmailSourceAttestation.fields.sourceFormat,
      parserRevision: InterpretationRevision,
      extractorRevision: InterpretationRevision,
    }),
    Result: SourceAttestationRow,
    execute: (row) => sql`
      INSERT INTO source_attestations (
        transaction_id, kind, service_market, locale, time_zone, source_channel,
        source_provider, interpretation_revision, received_email_id, message_channel,
        message_provider, provider_message_id, message_content_sha256, source_format,
        extractor_revision
      )
      SELECT transaction.id, 'notification-email', ${row.serviceMarket}, ${row.locale},
        ${row.timeZone}, 'forwarded-email', 'resend', ${row.parserRevision},
        ${row.receivedEmailId}, ${row.messageChannel}, ${row.messageProvider},
        ${row.providerMessageId}, ${row.messageContentSha256}, ${row.sourceFormat},
        ${row.extractorRevision}
      FROM transactions transaction
      WHERE transaction.id = ${row.transactionId} AND transaction.user_id = ${row.userId}
      RETURNING ${sql.literal(sourceAttestationColumns)}
    `,
  })({
    userId,
    transactionId,
    ...input,
    messageChannel: input.messageEvidence.channel,
    messageProvider: input.messageEvidence.provider,
    providerMessageId: input.messageEvidence.providerMessageId,
  }).pipe(Effect.flatMap(sourceAttestationFromRow), Effect.orDie);
});
