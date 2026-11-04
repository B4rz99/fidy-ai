import { Clock, Effect } from "effect";
import { ErasureUnavailable } from "../../erasure-store/contract";
import { makeSqliteDatabase } from "../../sqlite-store/operations";
import { recoveryWindowMs } from "./retention-policy";
import type { ErasureImportedInput as ImportedInput } from "../contract";

const verifiedImportStatement = ({
  db,
  input,
  checkedCases,
  current,
}: Readonly<{
  db: D1Database;
  input: ImportedInput;
  checkedCases: number;
  current: number;
}>): D1PreparedStatement =>
  db
    .prepare(`SELECT json(CASE WHEN
      (SELECT count(*) FROM erasure_control WHERE kind='published' AND generation IN(?,?))=1
      AND (SELECT count(*) FROM erasure_restore_members WHERE generation=?)=?
      AND NOT EXISTS(SELECT 1 FROM erasure_restore_members m LEFT JOIN erasure_requests q ON q.id=m.request_id
        WHERE m.generation=? AND (q.id IS NULL OR q.user_id<>m.user_id
        OR q.state NOT IN('ExternalPending','Complete') OR q.marker_written<>1 OR q.coordinator_cleared<>1
        OR EXISTS(SELECT 1 FROM users WHERE id=q.user_id)
        OR NOT EXISTS(SELECT 1 FROM erasure_steps WHERE request_id=q.id)
        OR EXISTS(SELECT 1 FROM erasure_steps WHERE request_id=q.id AND delete_done=0)
        OR EXISTS(SELECT 1 FROM erasure_writers WHERE user_id=q.user_id)))
      AND NOT EXISTS(SELECT 1 FROM erasure_requests q WHERE NOT EXISTS(SELECT 1 FROM erasure_restore_members m
        WHERE m.generation=? AND m.request_id=q.id AND m.user_id=q.user_id)
        AND NOT(q.state='Complete' AND q.last_erased_at_ms IS NOT NULL AND q.last_erased_at_ms+?<=?
          AND q.marker_written=1 AND q.coordinator_cleared=1 AND NOT EXISTS(SELECT 1 FROM users WHERE id=q.user_id)
          AND NOT EXISTS(SELECT 1 FROM erasure_writers WHERE user_id=q.user_id)))
      AND NOT EXISTS(SELECT 1 FROM erasure_writers)
      THEN 'true' ELSE '' END) AS verified`)
    .bind(
      input.evidence.sourceGeneration,
      input.evidence.finalGeneration,
      input.evidence.finalGeneration,
      checkedCases,
      input.evidence.finalGeneration,
      input.evidence.finalGeneration,
      recoveryWindowMs,
      current
    );

export const advanceImportedMarker = ({
  input,
  checkedCases,
}: Readonly<{ input: ImportedInput; checkedCases: number }>): Effect.Effect<
  void,
  ErasureUnavailable
> =>
  Effect.gen(function* () {
    yield* Effect.try({
      try: () => input.target.assertInactive(),
      catch: () => new ErasureUnavailable(),
    });
    const current = yield* Clock.currentTimeMillis;
    const db = makeSqliteDatabase(input.target.storage);
    yield* Effect.tryPromise({
      try: () =>
        db.batch([
          verifiedImportStatement({ db, input, checkedCases, current }),
          db
            .prepare(
              "UPDATE erasure_requests SET restore_generation=? WHERE EXISTS(SELECT 1 FROM erasure_restore_members m WHERE m.generation=? AND m.request_id=erasure_requests.id AND m.user_id=erasure_requests.user_id)"
            )
            .bind(input.evidence.finalGeneration, input.evidence.finalGeneration),
          db
            .prepare(
              "INSERT INTO erasure_control(kind,generation,cursor,scanned) VALUES('restore',?,'',1) ON CONFLICT(kind) DO UPDATE SET generation=excluded.generation,cursor='',scanned=1"
            )
            .bind(input.evidence.finalGeneration),
          db
            .prepare("UPDATE erasure_control SET generation=? WHERE kind='published'")
            .bind(input.evidence.finalGeneration),
        ]),
      catch: () => new ErasureUnavailable(),
    });
  });
