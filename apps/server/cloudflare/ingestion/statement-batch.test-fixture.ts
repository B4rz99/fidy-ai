import { Function, Schema } from "effect";

export const BatchEnvelope = Schema.Struct({
  data: Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        callId: Schema.String,
        operation: Schema.String,
        output: Schema.Unknown,
      })
    ),
  }),
  next: Schema.Array(Schema.Unknown),
});

const batchCallIdDigits = 12;

export const batchCallId = (suffix: number): string =>
  `20000000-0000-4000-8000-${String(suffix).padStart(batchCallIdDigits, "0")}`;

export const correctionCall: {
  (id: string, payload: object): (suffix: number) => object;
  (suffix: number, id: string, payload: object): object;
} = Function.dual(3, (suffix: number, id: string, payload: object): object => ({
  callId: batchCallId(suffix),
  operation: "transactions.updateTransaction",
  input: { params: { id }, payload },
}));

export const seedTransaction = ({
  categoryId,
  db,
  id,
  occurredAt,
  userId,
}: Readonly<{
  categoryId: string;
  db: D1Database;
  id: string;
  occurredAt: string;
  userId: string;
}>): Promise<unknown> =>
  db
    .prepare(
      `INSERT INTO transactions (id, user_id, amount, currency, direction, category_id, notes,
         occurred_at_ms, created_at_ms)
       VALUES (?, ?, '10.00', 'COP', 'outflow', ?, 'seed',CAST(round(unixepoch(?,'subsec')*1000) AS INTEGER),CAST(round(unixepoch(?,'subsec')*1000) AS INTEGER))`
    )
    .bind(id, userId, categoryId, occurredAt, occurredAt)
    .run();

export const concurrentCorrection = ({
  correctedAt,
  db,
  evidenceId,
  transactionId,
  userId,
}: Readonly<{
  correctedAt: string;
  db: D1Database;
  evidenceId: string;
  transactionId: string;
  userId: string;
}>): Promise<unknown> =>
  db
    .prepare(
      `INSERT INTO transaction_corrections (id, user_id, transaction_id, previous_revision,
         changed_fields, before_facts, after_facts, corrected_at_ms)
       VALUES (?, ?, ?, 0, '["notes"]', '{"notes":"seed"}', '{"notes":"concurrent"}',CAST(round(unixepoch(?,'subsec')*1000) AS INTEGER))`
    )
    .bind(evidenceId, userId, transactionId, correctedAt)
    .run()
    .then(() =>
      db
        .prepare(
          "UPDATE transactions SET notes = 'concurrent', revision = 1 WHERE user_id = ? AND id = ? AND revision = 0"
        )
        .bind(userId, transactionId)
        .run()
    );

export const competingWriteDb: {
  (before: () => Promise<unknown>): (db: D1Database) => D1Database;
  (db: D1Database, before: () => Promise<unknown>): D1Database;
} = Function.dual(2, (db: D1Database, before: () => Promise<unknown>): D1Database => {
  let fired = false;
  return new Proxy(db, {
    get: (target, property): unknown =>
      property === "batch"
        ? (...args: Parameters<D1Database["batch"]>): ReturnType<D1Database["batch"]> => {
            if (fired) return target.batch(...args);
            fired = true;
            return before().then(() => target.batch(...args));
          }
        : Reflect.get(target, property, target),
  });
});

export const defectiveBatchDb = (db: D1Database): D1Database =>
  new Proxy(db, {
    get: (target, property): unknown =>
      property === "batch"
        ? (): Promise<never> => Promise.reject(new Error("D1 unit defect"))
        : Reflect.get(target, property, target),
  });
