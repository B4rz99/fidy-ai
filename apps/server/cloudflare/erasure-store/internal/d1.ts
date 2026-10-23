import { prepareChangedRowAssertion } from "../../../src/shell/sql-assertions/operations";
import { Effect, Schema } from "effect";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { type ErasureProjection, type ErasureScope, ErasureUnavailable } from "../contract";

const maximumRows = 64;
const Finished = Schema.Struct({ done: Schema.Literals([0, 1]) });
const prepare = (db: D1Database, statement: OwnedStatement): D1PreparedStatement =>
  db.prepare(statement.sql).bind(...statement.params);
const settle = (
  db: D1Database,
  statements: ReadonlyArray<D1PreparedStatement>
): Effect.Effect<boolean, ErasureUnavailable> =>
  Effect.uninterruptible(
    Effect.tryPromise({
      try: () => db.batch([...statements]),
      catch: () => new ErasureUnavailable(),
    })
  ).pipe(
    Effect.flatMap((results) => Schema.decodeUnknownEffect(Finished)(results.at(-1)?.results[0])),
    Effect.map((result) => result.done === 1),
    Effect.mapError(() => new ErasureUnavailable())
  );
export const remove = ({
  db,
  projection,
  scope,
}: Readonly<{ db: D1Database; projection: ErasureProjection; scope: ErasureScope }>): Effect.Effect<
  boolean,
  ErasureUnavailable
> =>
  Effect.gen(function* () {
    const selected = projection.candidates(scope.userId);
    const remaining = projection.remaining(scope.userId);
    const raw = yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(`SELECT rowRef FROM (${selected.sql}) LIMIT ?`)
          .bind(...selected.params, maximumRows)
          .all(),
      catch: () => new ErasureUnavailable(),
    });
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ rowRef: Schema.String }))
    )(raw.results).pipe(Effect.mapError(() => new ErasureUnavailable()));
    const rowRefsJson = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Array(Schema.String))
    )(rows.map((row) => row.rowRef)).pipe(Effect.mapError(() => new ErasureUnavailable()));
    return yield* settle(db, [
      db.prepare("PRAGMA defer_foreign_keys=ON"),
      db
        .prepare(`INSERT INTO erasure_permits(request_id,user_id,store_id) SELECT id,user_id,? FROM erasure_requests
      WHERE id=? AND user_id=? AND state='Erasing' AND EXISTS(SELECT 1 FROM erasure_steps WHERE request_id=? AND store_id=? )`)
        .bind(projection.id, scope.reference, scope.userId, scope.reference, projection.id),
      prepareChangedRowAssertion({ db, scope: "erasure_owner_batch" }),
      ...projection.remove({ ...scope, rowRefsJson }).map((statement) => prepare(db, statement)),
      db
        .prepare(`UPDATE erasure_steps SET delete_done=1 WHERE request_id=? AND store_id=?
      AND EXISTS(SELECT 1 FROM erasure_permits WHERE request_id=? AND user_id=? AND store_id=?)
      AND NOT EXISTS(${remaining.sql})`)
        .bind(
          scope.reference,
          projection.id,
          scope.reference,
          scope.userId,
          projection.id,
          ...remaining.params
        ),
      db.prepare("DELETE FROM erasure_permits WHERE request_id=?").bind(scope.reference),
      db
        .prepare(
          "SELECT s.delete_done AS done FROM erasure_steps s JOIN erasure_requests q ON q.id=s.request_id WHERE q.id=? AND s.store_id=? AND q.user_id=?"
        )
        .bind(scope.reference, projection.id, scope.userId),
    ]);
  });
