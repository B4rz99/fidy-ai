import { Schema } from "effect";

/**
 * The atomic-batch fixtures the Transactions and statement-ingestion suites share: one committed
 * batch envelope, the child identities and builders, the direct seeds a premise race needs, and the
 * D1 defect seam. Each suite keeps its own runtime, credentials, and call vocabulary.
 */

/** One committed batch envelope before any child output is decoded against its own schema. */
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

/** The zero-padded tail a stable batch child identity ends with. */
const batchCallIdDigits = 12;

/** The callId one batch child carries; every child in a request needs its own. */
export const batchCallId = (suffix: number): string =>
  `20000000-0000-4000-8000-${String(suffix).padStart(batchCallIdDigits, "0")}`;

/** One canonical correction child addressing a Transaction at the revision the caller observed. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const correctionCall = (suffix: number, id: string, payload: object): object => ({
  callId: batchCallId(suffix),
  operation: "transactions.updateTransaction",
  input: { params: { id }, payload },
});

/** Seeds one retained Transaction directly, so a correction has a premise the unit re-checks. */
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
         occurred_at, created_at)
       VALUES (?, ?, '10.00', 'COP', 'outflow', ?, 'seed', ?, ?)`
    )
    .bind(id, userId, categoryId, occurredAt, occurredAt)
    .run();

/**
 * Advances one seeded Transaction to revision 1 through the same evidence a real correction keeps,
 * so a child's observed revision is provably stale by the time its own unit runs.
 */
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
         changed_fields, before_facts, after_facts, corrected_at)
       VALUES (?, ?, ?, 0, '["notes"]', '{"notes":"seed"}', '{"notes":"concurrent"}', ?)`
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

/**
 * A D1 binding that runs one competing write immediately before the first unit batch, so a premise
 * the caller observed can move after preparation and only the unit's own guard or the post-rollback
 * re-check can see it. Later batches pass through untouched.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const competingWriteDb = (db: D1Database, before: () => Promise<unknown>): D1Database => {
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
};

/** A D1 binding whose unit batch always fails, so a defect can never leave partial state. */
export const defectiveBatchDb = (db: D1Database): D1Database =>
  new Proxy(db, {
    get: (target, property): unknown =>
      property === "batch"
        ? (): Promise<never> => Promise.reject(new Error("D1 unit defect"))
        : Reflect.get(target, property, target),
  });
