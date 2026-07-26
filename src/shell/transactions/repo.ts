import { Effect, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { UserId } from "~/core/_shared/user";
import {
  Amount,
  CreateTransactionInput,
  Transaction,
  TransactionId,
} from "~/core/transactions/model";

/**
 * The Transaction model, adjusted for how the driver materializes rows:
 * the bigint amount column arrives as a string (which Amount's JSON-safe
 * bound keeps exactly representable); timestamptz columns arrive as Date
 * objects, which decode into the model's DateTime.Utc.
 */
const TransactionFromRow = Schema.Struct({
  ...Transaction.fields,
  amount: Schema.FiniteFromString.pipe(Schema.decodeTo(Amount)),
  occurredAt: Schema.DateTimeUtcFromDate,
  createdAt: Schema.DateTimeUtcFromDate,
});

/**
 * The row an insert writes: the canonical create input, plus the owner the
 * caller was resolved to. Ownership joins the data here, at the storage edge,
 * and stops here — the projection below never reads it back out.
 */
const TransactionToRow = Schema.Struct({
  ...CreateTransactionInput.fields,
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
    })({ ...input, userId })
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
