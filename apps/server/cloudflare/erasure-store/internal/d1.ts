import { Clock, Effect, Schema } from "effect";
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
export const archive = ({
  db,
  projection,
  scope,
}: Readonly<{ db: D1Database; projection: ErasureProjection; scope: ErasureScope }>): Effect.Effect<
  boolean,
  ErasureUnavailable
> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const selected = projection.select(scope.userId);
    return yield* settle(db, [
      db
        .prepare(`INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
      SELECT q.id,?,q.archive_generation||':'||r.rowRef,r.body FROM erasure_requests q,(${selected.sql}) r
      WHERE q.id=? AND q.user_id=? AND q.state='Archiving'
      AND json_extract(q.decision_json,?)='Retain' AND json_extract(q.decision_json,?)>?
      AND NOT EXISTS(SELECT 1 FROM erasure_archives a WHERE a.request_id=q.id AND a.store_id=? AND a.row_ref=q.archive_generation||':'||r.rowRef)
      LIMIT ?`)
        .bind(
          projection.id,
          ...selected.params,
          scope.reference,
          scope.userId,
          `$.dispositions.${projection.dataClass}.action`,
          `$.dispositions.${projection.dataClass}.retention.untilMs`,
          current,
          projection.id,
          maximumRows
        ),
      db
        .prepare(`UPDATE erasure_steps SET archive_done=1 WHERE request_id=? AND store_id=?
      AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.id=? AND q.user_id=? AND q.state='Archiving'
      AND (json_extract(q.decision_json,?)='Delete' OR json_extract(q.decision_json,?)<=? OR NOT EXISTS(SELECT 1 FROM (${selected.sql}) r
        WHERE NOT EXISTS(SELECT 1 FROM erasure_archives a WHERE a.request_id=q.id AND a.store_id=? AND a.row_ref=q.archive_generation||':'||r.rowRef))))`)
        .bind(
          scope.reference,
          projection.id,
          scope.reference,
          scope.userId,
          `$.dispositions.${projection.dataClass}.action`,
          `$.dispositions.${projection.dataClass}.retention.untilMs`,
          current,
          ...selected.params,
          projection.id
        ),
      db
        .prepare(
          "SELECT s.archive_done AS done FROM erasure_steps s JOIN erasure_requests q ON q.id=s.request_id WHERE q.id=? AND s.store_id=? AND q.user_id=?"
        )
        .bind(scope.reference, projection.id, scope.userId),
    ]);
  });
export const remove = ({
  db,
  projection,
  scope,
}: Readonly<{ db: D1Database; projection: ErasureProjection; scope: ErasureScope }>): Effect.Effect<
  boolean,
  ErasureUnavailable
> => {
  const selected = projection.candidates(scope.userId);
  const remaining = projection.remaining(scope.userId);
  return settle(db, [
    db.prepare("PRAGMA defer_foreign_keys=ON"),
    db.prepare("DELETE FROM erasure_chunk WHERE request_id=?").bind(scope.reference),
    db
      .prepare(`INSERT INTO erasure_permits(request_id,user_id,store_id) SELECT id,user_id,? FROM erasure_requests
      WHERE id=? AND user_id=? AND state='Erasing' AND NOT EXISTS(SELECT 1 FROM erasure_steps WHERE request_id=? AND archive_done=0)`)
      .bind(projection.id, scope.reference, scope.userId, scope.reference),
    db
      .prepare(`INSERT INTO erasure_chunk(request_id,row_ref) SELECT ?,r.rowRef FROM (${selected.sql}) r
      WHERE EXISTS(SELECT 1 FROM erasure_permits WHERE request_id=? AND user_id=? AND store_id=?) LIMIT ?`)
      .bind(
        scope.reference,
        ...selected.params,
        scope.reference,
        scope.userId,
        projection.id,
        maximumRows
      ),
    ...projection.remove(scope).map((statement) => prepare(db, statement)),
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
    db.prepare("DELETE FROM erasure_chunk WHERE request_id=?").bind(scope.reference),
    db
      .prepare(
        "SELECT s.delete_done AS done FROM erasure_steps s JOIN erasure_requests q ON q.id=s.request_id WHERE q.id=? AND s.store_id=? AND q.user_id=?"
      )
      .bind(scope.reference, projection.id, scope.userId),
  ]);
};
