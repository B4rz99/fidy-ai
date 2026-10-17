import { Effect } from "effect";
import { ErasureUnavailable } from "./contract";

type OriginalWrite = Readonly<{
  db: D1Database;
  userId: string;
  reference: string;
  bucket: "email" | "statement";
  objectKey: string;
}>;

/** Commit with the owner's original reservation in one native batch. A refused writer aborts that complete reservation. */
export const prepareOriginalWrite = (
  input: OriginalWrite & Readonly<{ current: number; expiresAtMs: number }>
): ReadonlyArray<D1PreparedStatement> => [
  input.db
    .prepare(`INSERT INTO erasure_writers(id,user_id,bucket,object_key,started_at_ms,expires_at_ms)
    SELECT ?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=? AND state<>'AwaitingReview')`)
    .bind(
      input.reference,
      input.userId,
      input.bucket,
      input.objectKey,
      input.current,
      input.expiresAtMs,
      input.userId
    ),
  input.db.prepare(
    "INSERT INTO erasure_writer_assertion(id,accepted) VALUES(1,changes()) ON CONFLICT(id) DO UPDATE SET accepted=excluded.accepted"
  ),
];

/** Enclose the entire original-byte write and its publication/cleanup. Only successful publication releases its writer; failure or cancellation leaves the object locator unresolved for reviewed reconciliation. */
export const trackOriginalWrite = <A, E, R>(
  input: OriginalWrite &
    Readonly<{
      work: Effect.Effect<A, E, R>;
    }>
): Effect.Effect<A, E | ErasureUnavailable, R> =>
  Effect.gen(function* () {
    const acquired = yield* originalWriteActive(input);
    if (!acquired) return yield* new ErasureUnavailable();
    return yield* input.work.pipe(
      Effect.tap(() =>
        Effect.tryPromise({
          try: () =>
            input.db
              .prepare("DELETE FROM erasure_writers WHERE id=? AND user_id=?")
              .bind(input.reference, input.userId)
              .run(),
          catch: () => new ErasureUnavailable(),
        }).pipe(Effect.uninterruptible)
      )
    );
  });

export const originalWriteActive = (
  input: OriginalWrite
): Effect.Effect<boolean, ErasureUnavailable> =>
  Effect.uninterruptible(
    Effect.tryPromise({
      try: () =>
        input.db
          .prepare(`SELECT count(*) AS active FROM erasure_writers WHERE id=? AND user_id=? AND bucket=? AND object_key=?
              AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=? AND state NOT IN('AwaitingReview','Draining'))`)
          .bind(input.reference, input.userId, input.bucket, input.objectKey, input.userId)
          .first<number>("active"),
      catch: () => new ErasureUnavailable(),
    })
  ).pipe(Effect.map((active) => active === 1));

export const originalWritesSettled = (
  input: Readonly<{ db: D1Database; userId: string }>
): Effect.Effect<boolean, ErasureUnavailable> =>
  Effect.tryPromise({
    try: () =>
      input.db
        .prepare("SELECT count(*) AS pending FROM erasure_writers WHERE user_id=?")
        .bind(input.userId)
        .first<number>("pending"),
    catch: () => new ErasureUnavailable(),
  }).pipe(Effect.map((pending) => pending === 0));
