import { DateTime, Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { CategoryId } from "~/core/categories/reference";
import { Money, encodeMoneyAmount } from "~/core/_shared/money";
import { UserId } from "~/core/identity/reference";
import { normalizeCategoryKeyword } from "~/core/categories/rules";
import { withUserTransaction } from "~/shell/db/user-transaction";
import {
  type CapturedInterpretationContext,
  Counterparty,
  InterpretationRevision,
  SourceAttestation,
  SourceAttestationCommon,
  StatementLineSourceAttestation,
  Transaction,
  TransactionId,
  type TransactionQuery,
  type UpdateTransactionInput,
} from "~/core/transactions/model";

const TransactionFlatRow = Schema.Struct({
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
const transactionFromRow = ({
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

const TransactionWriteRow = Schema.Struct({
  userId: UserId,
  ...Money.fields,
  counterparty: Schema.OptionFromNullOr(Counterparty),
  direction: Transaction.fields.direction,
  categoryId: CategoryId,
  notes: Schema.OptionFromNullOr(Schema.String),
  occurredAt: Schema.DateTimeUtc,
});

const TransactionLookup = Schema.Struct({ id: TransactionId, userId: UserId });
const containsCounterparty = (counterparty: Option.Option<string>, normalized: string): boolean =>
  Option.exists(counterparty, (candidate) =>
    normalizeCategoryKeyword(candidate).includes(normalized)
  );
const transactionColumns = `id, amount, currency, counterparty, direction,
  category_id AS "categoryId", notes, occurred_at AS "occurredAt", created_at AS "createdAt"`;

const writeRow = (
  userId: UserId,
  input: UpdateTransactionInput
): typeof TransactionWriteRow.Type => ({
  userId,
  ...input.money,
  counterparty: input.counterparty,
  direction: input.direction,
  categoryId: input.categoryId,
  notes: input.notes,
  occurredAt: input.occurredAt,
});

/** Inserts one valid normalized Transaction inside the caller's User-scoped transaction. */
export const insertTransactionInScope = Effect.fn("insertTransactionInScope")(function* (
  userId: UserId,
  input: UpdateTransactionInput
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: TransactionWriteRow,
    Result: TransactionFlatRow,
    execute: (row) => sql`
      INSERT INTO transactions
        (user_id, amount, currency, counterparty, direction, category_id, notes, occurred_at)
      VALUES
        (${row.userId}, ${row.amount}, ${row.currency}, ${row.counterparty}, ${row.direction},
         ${row.categoryId}, ${row.notes}, ${row.occurredAt})
      RETURNING ${sql.literal(transactionColumns)}
    `,
  })(writeRow(userId, input)).pipe(Effect.flatMap(transactionFromRow), Effect.orDie);
});

/** Loads one active User-owned Transaction; foreign, deleted, and absent identities return None. */
export const findTransaction = Effect.fn("findTransaction")(function* (
  userId: UserId,
  id: TransactionId
) {
  return yield* withUserTransaction(
    userId,
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      SqlSchema.findOneOption({
        Request: TransactionLookup,
        Result: TransactionFlatRow,
        execute: (request) => sql`
        SELECT ${sql.literal(transactionColumns)}
        FROM transactions
        WHERE id = ${request.id} AND user_id = ${request.userId} AND deleted_at IS NULL
      `,
      })({ id, userId })
    ).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) => transactionFromRow(row).pipe(Effect.map(Option.some)),
        })
      ),
      Effect.orDie
    )
  );
});

/** Loads active Transactions for one User matching every supplied half-open history filter. */
export const selectTransactions = Effect.fn("selectTransactions")(function* (
  userId: UserId,
  query: TransactionQuery
) {
  return yield* withUserTransaction(
    userId,
    Effect.flatMap(SqlClient.SqlClient, (sql) => {
      const conditions = [sql`user_id = ${userId}`, sql`deleted_at IS NULL`];
      if (Option.isSome(query.from)) conditions.push(sql`occurred_at >= ${query.from.value}`);
      if (Option.isSome(query.to)) conditions.push(sql`occurred_at < ${query.to.value}`);
      if (Option.isSome(query.categoryId)) {
        conditions.push(sql`category_id = ${query.categoryId.value}`);
      }
      if (Option.isSome(query.direction)) {
        conditions.push(sql`direction = ${query.direction.value}`);
      }
      if (Option.isSome(query.currency)) conditions.push(sql`currency = ${query.currency.value}`);

      return SqlSchema.findAll({
        Request: Schema.Void,
        Result: TransactionFlatRow,
        execute: () => sql`
        SELECT ${sql.literal(transactionColumns)}
        FROM transactions
        WHERE ${sql.and(conditions)}
        ORDER BY occurred_at DESC, created_at DESC, id DESC
      `,
      })(undefined);
    }).pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, transactionFromRow)),
      Effect.map((transactions) =>
        Option.match(query.counterparty, {
          onNone: () => transactions,
          onSome: (counterparty) => {
            const normalized = normalizeCategoryKeyword(counterparty);
            return transactions.filter((transaction) =>
              containsCounterparty(transaction.counterparty, normalized)
            );
          },
        })
      ),
      Effect.orDie
    )
  );
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
  input: UpdateTransactionInput
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Struct({ ...TransactionWriteRow.fields, transactionId: TransactionId }),
    Result: TransactionFlatRow,
    execute: (row) => sql`
      UPDATE transactions SET
        amount = ${row.amount}, currency = ${row.currency}, counterparty = ${row.counterparty},
        direction = ${row.direction}, category_id = ${row.categoryId}, notes = ${row.notes},
        occurred_at = ${row.occurredAt}
      WHERE id = ${row.transactionId} AND user_id = ${row.userId} AND deleted_at IS NULL
      RETURNING ${sql.literal(transactionColumns)}
    `,
  })({ ...writeRow(userId, input), transactionId }).pipe(
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

const SourceAttestationRow = Schema.Struct({
  id: Schema.toEncoded(SourceAttestationCommon.fields.id),
  transactionId: Schema.toEncoded(TransactionId),
  kind: Schema.Literals(["manual", "statement-line"]),
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
  sourceFormat: Schema.OptionFromNullOr(StatementLineSourceAttestation.fields.sourceFormat),
  extractorRevision: Schema.OptionFromNullOr(InterpretationRevision),
  createdAt: Schema.DateTimeUtcFromDate,
});

const decodeSourceAttestation = Schema.decodeUnknownEffect(SourceAttestation);
const sourceAttestationFromRow = (
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
    ...row
  } = source;
  return decodeSourceAttestation({
    ...row,
    ...(Option.isNone(sourceChannel) ? {} : { sourceChannel: sourceChannel.value }),
    ...(Option.isNone(sourceProvider) ? {} : { sourceProvider: sourceProvider.value }),
    ...(Option.isNone(statementSubmissionId)
      ? {}
      : { statementSubmissionId: statementSubmissionId.value }),
    ...(Option.isNone(statementRecordNumber)
      ? {}
      : { statementRecordNumber: statementRecordNumber.value }),
    ...(Option.isNone(statementContentHash)
      ? {}
      : { statementContentHash: statementContentHash.value }),
    ...(Option.isNone(sourceFormat) ? {} : { sourceFormat: sourceFormat.value }),
    ...(Option.isNone(extractorRevision) ? {} : { extractorRevision: extractorRevision.value }),
    createdAt: DateTime.formatIso(row.createdAt),
  });
};

const sourceAttestationColumns = `id, transaction_id AS "transactionId", kind,
  service_market AS "serviceMarket", locale, time_zone AS "timeZone",
  source_channel AS "sourceChannel", source_provider AS "sourceProvider",
  interpretation_revision AS "interpretationRevision",
  statement_submission_id AS "statementSubmissionId",
  statement_record_number AS "statementRecordNumber",
  statement_content_hash AS "statementContentHash", source_format AS "sourceFormat",
  extractor_revision AS "extractorRevision", created_at AS "createdAt"`;

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

/** Lists retained immutable provenance for one User-owned Transaction, including after deletion. */
export const selectSourceAttestations = Effect.fn("selectSourceAttestations")(function* (
  userId: UserId,
  id: TransactionId
) {
  return yield* withUserTransaction(
    userId,
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      SqlSchema.findAll({
        Request: TransactionLookup,
        Result: SourceAttestationRow,
        execute: (request) => sql`
        SELECT ${sql.literal(sourceAttestationColumns)}
        FROM source_attestations source
        WHERE source.transaction_id = ${request.id}
          AND EXISTS (
            SELECT 1 FROM transactions transaction
            WHERE transaction.id = source.transaction_id
              AND transaction.user_id = ${request.userId}
          )
        ORDER BY source.created_at, source.id
      `,
      })({ id, userId })
    ).pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, sourceAttestationFromRow)),
      Effect.orDie
    )
  );
});
