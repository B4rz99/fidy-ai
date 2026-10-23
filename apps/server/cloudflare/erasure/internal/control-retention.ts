import { Clock, Effect, Option, Schema } from "effect";
import { ErasureUnavailable } from "../../erasure-store/contract";
import type { ErasureRecoveryConfiguration } from "../contract";
import { expectedGeneration } from "./generation";
import { recoveryWindowMs } from "./retention-policy";

const maximumCases = 4;
const maximumRows = 64;
const Case = Schema.Struct({ reference: Schema.String, userId: Schema.String });
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
const deleteControls = (
  input: ErasureRecoveryConfiguration & Readonly<{ scope: typeof Case.Type }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const { db, bucket, scope } = input;
    if (Option.isNone(bucket)) return yield* new ErasureUnavailable();
    yield* io(() => bucket.value.delete(`recovery/cases/${scope.reference}`));
    const children = [
      "erasure_steps",
      "erasure_permits",
      "erasure_custody_records",
      "erasure_restore_members",
    ];
    yield* io(() =>
      db.batch([
        ...children.map((table) =>
          db
            .prepare(
              `DELETE FROM ${table} WHERE rowid IN(SELECT rowid FROM ${table} WHERE request_id=? ${table === "erasure_custody_records" ? "ORDER BY record_type" : ""} LIMIT ?)`
            )
            .bind(scope.reference, maximumRows)
        ),
        db
          .prepare(`DELETE FROM erasure_requests WHERE id=? AND user_id=? AND state='Complete'
        AND ${children.map((table) => `NOT EXISTS(SELECT 1 FROM ${table} WHERE request_id=erasure_requests.id)`).join(" AND ")}`)
          .bind(scope.reference, scope.userId),
      ])
    );
  });

/** Remove only externally completed deletion metadata beyond the supported backup horizon. A restored or unpublished database never purges its independent markers. */
export const purgeCompletedCases = (
  input: ErasureRecoveryConfiguration
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const count = yield* io(() =>
      input.db
        .prepare("SELECT count(*) AS count FROM erasure_requests WHERE state='Complete'")
        .first<number>("count")
    );
    if (count === 0) return;
    const expected = yield* expectedGeneration(input);
    const matched = yield* io(() =>
      input.db
        .prepare(
          "SELECT count(*) AS matched FROM erasure_control WHERE kind='published' AND generation=?"
        )
        .bind(expected.generation)
        .first<number>("matched")
    );
    if (matched !== 1) return;
    const rows = yield* io(() =>
      input.db
        .prepare(`SELECT id AS reference,user_id AS userId FROM erasure_requests
      WHERE state='Complete' AND last_erased_at_ms+?<=?
      AND NOT EXISTS(SELECT 1 FROM erasure_writers WHERE user_id=erasure_requests.user_id)
      ORDER BY last_continued_at_ms,requested_at_ms LIMIT ?`)
        .bind(recoveryWindowMs, current, maximumCases)
        .all()
    );
    const cases = yield* Schema.decodeUnknownEffect(Schema.Array(Case))(rows.results);
    for (const scope of cases) {
      yield* io(() =>
        input.db
          .prepare(
            "UPDATE erasure_requests SET last_continued_at_ms=? WHERE id=? AND user_id=? AND state='Complete'"
          )
          .bind(current, scope.reference, scope.userId)
          .run()
      );
      yield* deleteControls({ ...input, scope });
    }
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
