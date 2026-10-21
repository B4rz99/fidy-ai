import { projections as erasureProjections } from "./internal/erasure";
import { makeErasureStore } from "../erasure-store/runtime";
import type { ErasureStore } from "../erasure-store/contract";
import { DateTime, Effect, Schema } from "effect";
import { RecoveryRetentionUnavailable } from "./contract";

const maximumSweepRows = 32;
const retentionMonths = 24;
const admissionLifetimeMs = 3_600_000;
const RetainedCase = Schema.Struct({
  id: Schema.String,
  closed_at_ms: Schema.DateTimeUtcFromMillis,
});

/** Retain terminal evidence for 24 calendar months; cleanup never restores consumed credentials. */
export const sweepRecoveryEvidence = ({
  db,
  nowEpochMs,
}: Readonly<{ db: D1Database; nowEpochMs: number }>): Effect.Effect<
  void,
  RecoveryRetentionUnavailable
> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise(() =>
      db
        .prepare(
          "SELECT id,closed_at_ms FROM support_recovery_cases ORDER BY closed_at_ms,id LIMIT ?"
        )
        .bind(maximumSweepRows)
        .all()
    );
    const cases = yield* Schema.decodeUnknownEffect(Schema.Array(RetainedCase))(result.results);
    const expired = cases.filter(
      (entry) =>
        DateTime.toEpochMillis(DateTime.add(entry.closed_at_ms, { months: retentionMonths })) <=
        nowEpochMs
    );
    const admissions = db
      .prepare(
        "DELETE FROM support_recovery_admissions WHERE id IN (SELECT id FROM support_recovery_admissions WHERE admitted_at_ms<=? ORDER BY admitted_at_ms LIMIT ?)"
      )
      .bind(nowEpochMs - admissionLifetimeMs, maximumSweepRows);
    if (expired.length === 0) {
      yield* Effect.tryPromise(() => db.batch([admissions]));
      return;
    }
    const ids = expired.map((entry) => entry.id);
    const placeholders = ids.map(() => "?").join(",");
    yield* Effect.tryPromise(() =>
      db.batch([
        db.prepare(`DELETE FROM support_recovery_cases WHERE id IN (${placeholders})`).bind(...ids),
        admissions,
      ])
    );
  }).pipe(Effect.mapError(() => new RecoveryRetentionUnavailable()));

export const makeRecoveryErasureStores = (db: D1Database): ReadonlyArray<ErasureStore> =>
  erasureProjections.map((projection) => makeErasureStore({ db, projection }));
