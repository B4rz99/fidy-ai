import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { preserveStoreAlarm, withStoreCapacity } from "../runtime/sqlite/operations";
import type { StoreHistory } from "../runtime/sqlite/contract";
import { prepareChangedRowAssertion } from "../../src/shell/sql-assertions/operations";
import { Clock, Effect, Schema } from "effect";
import { ErasureHandoff, ErasureUnavailable, confirmHandoffUrl } from "./contract";

type OriginalWrite = Readonly<{
  db: D1Database;
  userId: string;
  reference: string;
  bucket: "email" | "statement";
  objectKey: string;
}>;

/** Commit with the owner's original reservation in one native batch. A refused writer aborts that complete reservation. */
export const prepareOriginalWrite = (
  input: OriginalWrite & Readonly<{ current: number }>
): ReadonlyArray<D1PreparedStatement> => [
  input.db
    .prepare(`INSERT INTO erasure_writers(id,user_id,bucket,object_key,started_at_ms)
    SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=?)`)
    .bind(
      input.reference,
      input.userId,
      input.bucket,
      input.objectKey,
      input.current,
      input.userId
    ),
  prepareChangedRowAssertion({ db: input.db, scope: "erasure_writer" }),
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
              AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=? AND state <>'Draining')`)
          .bind(input.reference, input.userId, input.bucket, input.objectKey, input.userId)
          .first<number>("active"),
      catch: () => new ErasureUnavailable(),
    })
  ).pipe(Effect.map((active) => active === 1));

/** Reserve this owner's lifetime identity before its first domain schema. */
export const erasureStoreHistory: StoreHistory = {
  owner: "erasure",
  steps: [
    { version: 1, id: "initial-erasure-store", statements: [] },
    {
      version: 2,
      id: "independent-erasure-cases",
      statements: [
        "CREATE TABLE erasure_cases(user_id TEXT PRIMARY KEY,reference TEXT NOT NULL UNIQUE,requested_at_ms INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN('Draining','Sealing','Erasing','ExternalPending','Complete')),next_check_ms INTEGER NOT NULL,directory_fenced INTEGER NOT NULL DEFAULT 0 CHECK(directory_fenced IN(0,1)),pricing_fenced INTEGER NOT NULL DEFAULT 0 CHECK(pricing_fenced IN(0,1)),maintenance_fenced INTEGER NOT NULL DEFAULT 0 CHECK(maintenance_fenced IN(0,1))) STRICT",
        "CREATE INDEX erasure_case_wake ON erasure_cases(next_check_ms)",
      ],
    },
  ],
};

export const erasureBarrierSchema =
  "CREATE TABLE erasure_barriers(user_id TEXT PRIMARY KEY,reference TEXT NOT NULL UNIQUE,requested_at_ms INTEGER NOT NULL) STRICT";

const acknowledged = 204;
const conflictStatus = 409;
/** Refuse a confused first handoff. Once recorded, the exact fence survives User-local purge. */
export const fenceErasureParticipant = Effect.fn(function* (
  request: Request,
  users: Pick<DurableObjectNamespace, "getByName">,
  storage: DurableObjectStorage
) {
  const handoff = yield* Schema.decodeUnknownEffect(ErasureHandoff, { onExcessProperty: "error" })(
    yield* Effect.tryPromise(() => request.json())
  );
  const sql = yield* SqliteClient;
  const exact = sql`SELECT 1 FROM erasure_barriers WHERE user_id=${handoff.userId} AND reference=${handoff.reference} AND requested_at_ms=${handoff.requestedAtMs}`;
  if ((yield* exact).length === 1) return new Response(null, { status: acknowledged });
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(ErasureHandoff))(handoff);
  const confirmed = yield* Effect.tryPromise((signal) =>
    users.getByName(handoff.userId).fetch(confirmHandoffUrl, { method: "POST", body, signal })
  ).pipe(Effect.timeout("5 seconds"));
  if (confirmed.status !== acknowledged) return new Response(null, { status: conflictStatus });
  return yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      yield* sql`INSERT INTO erasure_barriers(user_id,reference,requested_at_ms) VALUES(${handoff.userId},${handoff.reference},${handoff.requestedAtMs}) ON CONFLICT DO NOTHING`;
      yield* preserveStoreAlarm(storage, yield* Clock.currentTimeMillis);
      return new Response(null, {
        status: (yield* exact).length === 1 ? acknowledged : conflictStatus,
      });
    })
  );
});
