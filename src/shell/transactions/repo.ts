import { DateTime, Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { CategoryId } from "~/core/categories/reference";
import { encodeMoneyAmount, Money } from "~/core/_shared/money";
import { UserId } from "~/core/identity/reference";
import { normalizeCategoryKeyword } from "~/core/categories/rules";
import {
  type CapturedInterpretationContext,
  InterpretationRevision,
  SourceAttestation,
  Transaction,
  TransactionId,
  type TransactionQuery,
  type UpdateTransactionInput,
} from "~/core/transactions/model";

const TransactionFlatRow = Schema.Struct({
  id: Schema.toEncoded(Transaction.fields.id),
  ...Money.fields,
  merchant: Transaction.fields.merchant,
  direction: Transaction.fields.direction,
  categoryId: Schema.toEncoded(CategoryId),
  notes: Schema.OptionFromNullOr(Schema.String),
  occurredAt: Schema.DateTimeUtcFromDate,
  createdAt: Schema.DateTimeUtcFromDate,
});

const decodeTransaction = Schema.decodeUnknownEffect(Transaction);
const transactionFromRow = ({
  amount,
  currency,
  notes,
  ...transaction
}: typeof TransactionFlatRow.Type) =>
  decodeTransaction({
    ...transaction,
    ...(Option.isNone(notes) ? {} : { notes: notes.value }),
    occurredAt: DateTime.formatIso(transaction.occurredAt),
    createdAt: DateTime.formatIso(transaction.createdAt),
    money: { amount: encodeMoneyAmount(amount), currency },
  });

const TransactionWriteRow = Schema.Struct({
  userId: UserId,
  ...Money.fields,
  merchant: Transaction.fields.merchant,
  direction: Transaction.fields.direction,
  categoryId: CategoryId,
  notes: Schema.OptionFromNullOr(Schema.String),
  occurredAt: Schema.DateTimeUtc,
});

const TransactionLookup = Schema.Struct({ id: TransactionId, userId: UserId });
const transactionColumns = `id, amount, currency, merchant, direction,
  category_id AS "categoryId", notes, occurred_at AS "occurredAt", created_at AS "createdAt"`;

const writeRow = (userId: UserId, input: UpdateTransactionInput) => ({
  userId,
  ...input.money,
  merchant: input.merchant,
  direction: input.direction,
  categoryId: input.categoryId,
  notes: input.notes,
  occurredAt: input.occurredAt,
});

/** Inserts one valid normalized Transaction for the explicit User. Database failures are defects. */
export const insertTransaction = Effect.fn("insertTransaction")(function* (
  userId: UserId,
  input: UpdateTransactionInput
) {
  return yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOne({
      Request: TransactionWriteRow,
      Result: TransactionFlatRow,
      execute: (row) => sql`
          INSERT INTO transactions
            (user_id, amount, currency, merchant, direction, category_id, notes, occurred_at)
          VALUES
            (${row.userId}, ${row.amount}, ${row.currency}, ${row.merchant}, ${row.direction},
             ${row.categoryId}, ${row.notes}, ${row.occurredAt})
          RETURNING ${sql.literal(transactionColumns)}
        `,
    })(writeRow(userId, input))
  ).pipe(Effect.flatMap(transactionFromRow), Effect.orDie);
});

/** Loads one active User-owned Transaction; foreign, deleted, and absent identities return None. */
export const findTransaction = Effect.fn("findTransaction")(function* (
  userId: UserId,
  id: TransactionId
) {
  return yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
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
  );
});

/** Loads active Transactions for one User matching every supplied half-open history filter. */
export const listTransactions = Effect.fn("listTransactions")(function* (
  userId: UserId,
  query: TransactionQuery
) {
  return yield* Effect.flatMap(SqlClient.SqlClient, (sql) => {
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
      Option.match(query.merchant, {
        onNone: () => transactions,
        onSome: (merchant) => {
          const normalized = normalizeCategoryKeyword(merchant);
          return transactions.filter((transaction) =>
            normalizeCategoryKeyword(transaction.merchant).includes(normalized)
          );
        },
      })
    ),
    Effect.orDie
  );
});

/** Replaces editable facts on one active User-owned Transaction; foreign or absent returns None. */
export const updateTransaction = Effect.fn("updateTransaction")(function* (
  userId: UserId,
  transactionId: TransactionId,
  input: UpdateTransactionInput
) {
  return yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOneOption({
      Request: Schema.Struct({ ...TransactionWriteRow.fields, transactionId: TransactionId }),
      Result: TransactionFlatRow,
      execute: (row) => sql`
          UPDATE transactions SET
            amount = ${row.amount}, currency = ${row.currency}, merchant = ${row.merchant},
            direction = ${row.direction}, category_id = ${row.categoryId}, notes = ${row.notes},
            occurred_at = ${row.occurredAt}
          WHERE id = ${row.transactionId} AND user_id = ${row.userId} AND deleted_at IS NULL
          RETURNING ${sql.literal(transactionColumns)}
        `,
    })({ ...writeRow(userId, input), transactionId })
  ).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none()),
        onSome: (row) => transactionFromRow(row).pipe(Effect.map(Option.some)),
      })
    ),
    Effect.orDie
  );
});

/** Hides one active User-owned Transaction permanently while retaining its provenance evidence. */
export const softDeleteTransaction = Effect.fn("softDeleteTransaction")(function* (
  userId: UserId,
  id: TransactionId
) {
  return yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOneOption({
      Request: TransactionLookup,
      Result: Schema.Struct({ id: TransactionId }),
      execute: (request) => sql`
        UPDATE transactions SET deleted_at = now()
        WHERE id = ${request.id} AND user_id = ${request.userId} AND deleted_at IS NULL
        RETURNING id
      `,
    })({ id, userId })
  ).pipe(Effect.map(Option.map((row) => row.id)), Effect.orDie);
});

const SourceAttestationRow = Schema.Struct({
  id: Schema.toEncoded(SourceAttestation.fields.id),
  transactionId: Schema.toEncoded(TransactionId),
  kind: Schema.Literal("manual"),
  serviceMarket: SourceAttestation.fields.serviceMarket,
  locale: SourceAttestation.fields.locale,
  timeZone: Schema.toEncoded(SourceAttestation.fields.timeZone),
  sourceChannel: Schema.OptionFromNullOr(Schema.String),
  sourceProvider: Schema.OptionFromNullOr(Schema.String),
  interpretationRevision: Schema.toEncoded(InterpretationRevision),
  createdAt: Schema.DateTimeUtcFromDate,
});

const decodeSourceAttestation = Schema.decodeUnknownEffect(SourceAttestation);
const sourceAttestationFromRow = (source: typeof SourceAttestationRow.Type) => {
  const { sourceChannel, sourceProvider, ...row } = source;
  return decodeSourceAttestation({
    ...row,
    ...(Option.isNone(sourceChannel) ? {} : { sourceChannel: sourceChannel.value }),
    ...(Option.isNone(sourceProvider) ? {} : { sourceProvider: sourceProvider.value }),
    createdAt: DateTime.formatIso(row.createdAt),
  });
};

const sourceAttestationColumns = `id, transaction_id AS "transactionId", kind,
  service_market AS "serviceMarket", locale, time_zone AS "timeZone",
  source_channel AS "sourceChannel", source_provider AS "sourceProvider",
  interpretation_revision AS "interpretationRevision", created_at AS "createdAt"`;

/**
 * Appends immutable manual provenance only when the Transaction belongs to the explicit User.
 * Call in the same canonical-operation transaction as capture so both records commit together.
 */
export const insertManualSourceAttestation = Effect.fn("insertManualSourceAttestation")(function* (
  userId: UserId,
  transactionId: TransactionId,
  context: CapturedInterpretationContext
) {
  return yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOne({
      Request: Schema.Struct({
        userId: UserId,
        transactionId: TransactionId,
        serviceMarket: SourceAttestation.fields.serviceMarket,
        locale: SourceAttestation.fields.locale,
        timeZone: SourceAttestation.fields.timeZone,
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
    })({ userId, transactionId, ...context })
  ).pipe(Effect.flatMap(sourceAttestationFromRow), Effect.orDie);
});

/** Lists retained immutable provenance for one User-owned Transaction, including after deletion. */
export const listSourceAttestations = Effect.fn("listSourceAttestations")(function* (
  userId: UserId,
  id: TransactionId
) {
  return yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
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
  );
});
