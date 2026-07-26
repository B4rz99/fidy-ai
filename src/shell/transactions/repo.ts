import { BigDecimal, DateTime, Effect, Schema, SchemaTransformation, Struct } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { encodeMoneyAmount, Money } from "~/core/_shared/money";
import { UserId } from "~/core/_shared/user";
import { CreateTransactionInput, Transaction, TransactionId } from "~/core/transactions/model";

const TransactionWithoutMoney = Transaction.mapFields(Struct.omit(["money"]));

/**
 * The canonical Transaction flattened only for a relational row. Numeric
 * columns arrive as decimal strings and timestamptz columns as Date objects;
 * decoding reconstructs nested Money before validating the domain model.
 */
const TransactionFlatRow = Schema.Struct({
  ...TransactionWithoutMoney.fields,
  id: Schema.toEncoded(Transaction.fields.id),
  ...Money.fields,
  occurredAt: Schema.DateTimeUtcFromDate,
  createdAt: Schema.DateTimeUtcFromDate,
});

const TransactionFromRow = TransactionFlatRow.pipe(
  Schema.decodeTo(
    Transaction,
    SchemaTransformation.transform({
      decode: ({ amount, currency, ...transaction }) => ({
        ...transaction,
        occurredAt: DateTime.formatIso(transaction.occurredAt),
        createdAt: DateTime.formatIso(transaction.createdAt),
        money: { amount: encodeMoneyAmount(amount), currency },
      }),
      encode: ({ money, ...transaction }) => ({
        ...transaction,
        occurredAt: DateTime.makeUnsafe(transaction.occurredAt),
        createdAt: DateTime.makeUnsafe(transaction.createdAt),
        amount: BigDecimal.fromStringUnsafe(money.amount),
        currency: money.currency,
      }),
    })
  )
);

const CreateTransactionWithoutMoney = CreateTransactionInput.mapFields(Struct.omit(["money"]));

/**
 * The row an insert writes: the canonical create input flattened to adjacent
 * Money columns, plus the owner resolved from operation context. Neither the
 * flattening nor ownership leaks back into the Transaction returned to callers.
 */
const TransactionToRow = Schema.Struct({
  ...CreateTransactionWithoutMoney.fields,
  ...Money.fields,
  userId: UserId,
});

/** What identifies one row: the id asked for, and whose history to look in. */
const TransactionLookup = Schema.Struct({
  id: TransactionId,
  userId: UserId,
});

/** The one projection every query returns rows through. */
const transactionColumns = `id, amount, currency, merchant, direction,
  occurred_at AS "occurredAt", created_at AS "createdAt"`;

// Every query here ends in `orDie`, and each one covers the same three
// failures: a `SqlError` (the connection is gone, or the statement is wrong), a
// `SchemaError` (a stored row the model rejects) and — for the insert — the
// `NoSuchElementError` `findOne` raises on no rows. All three are defects: two
// are our bug and one is the database being unreachable, and no caller can do
// anything about any of them (ARCHITECTURE.md §6). Domain failures are raised
// by handlers from what these queries return, never here.
//
// Adds the input to `userId`'s history and returns the stored Transaction,
// carrying the `id` and `createdAt` the database assigns — neither is the
// caller's to send. The owner travels beside the input rather than inside it:
// ownership is the context an operation runs in, never a field on the model
// (ARCHITECTURE.md §5).
export const insertTransaction = ({
  userId,
  input,
}: {
  readonly userId: UserId;
  readonly input: CreateTransactionInput;
}) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    // `findOne`, not `findOneOption`: an INSERT … RETURNING that matched no row
    // cannot happen, so absence here is a defect rather than an answer.
    SqlSchema.findOne({
      Request: TransactionToRow,
      Result: TransactionFromRow,
      execute: (row) =>
        sql`
          INSERT INTO transactions (user_id, amount, currency, merchant, direction, occurred_at)
          VALUES (${row.userId}, ${row.amount}, ${row.currency}, ${row.merchant}, ${row.direction}, ${row.occurredAt})
          RETURNING ${sql.literal(transactionColumns)}
        `,
    })({ ...input, ...input.money, userId })
  ).pipe(Effect.orDie);

// Absence is data, not a failure: the repo cannot know whether nothing found
// means a 404 or something else, so it hands back an `Option` and the handler
// decides (ARCHITECTURE.md §6). Filtering by owner in the same predicate is why
// the answer for a stranger is indistinguishable from the answer for an id that
// never existed.
export const findTransaction = (lookup: typeof TransactionLookup.Type) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOneOption({
      Request: TransactionLookup,
      Result: TransactionFromRow,
      execute: (request) =>
        sql`
          SELECT ${sql.literal(transactionColumns)}
          FROM transactions
          WHERE id = ${request.id} AND user_id = ${request.userId}
        `,
    })(lookup)
  ).pipe(Effect.orDie);

/** Lists one user's Transactions, newest occurrence and capture first. */
export const listTransactions = (userId: UserId) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findAll({
      Request: UserId,
      Result: TransactionFromRow,
      execute: (owner) =>
        sql`
          SELECT ${sql.literal(transactionColumns)}
          FROM transactions
          WHERE user_id = ${owner}
          ORDER BY occurred_at DESC, created_at DESC
        `,
    })(userId)
  ).pipe(Effect.orDie);
