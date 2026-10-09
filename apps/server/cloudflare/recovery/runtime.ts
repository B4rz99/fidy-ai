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
    const cleanup = db
      .prepare(`DELETE FROM support_recovery_operator_limits WHERE (operator_issuer,operator_subject) IN
      (SELECT operator_issuer,operator_subject FROM support_recovery_operator_limits WHERE window_started_at_ms<=? ORDER BY window_started_at_ms LIMIT ?)`)
      .bind(nowEpochMs - admissionLifetimeMs, maximumSweepRows);
    const admissions = db
      .prepare(
        "DELETE FROM support_recovery_admissions WHERE id IN (SELECT id FROM support_recovery_admissions WHERE admitted_at_ms<=? ORDER BY admitted_at_ms LIMIT ?)"
      )
      .bind(nowEpochMs - admissionLifetimeMs, maximumSweepRows);
    if (expired.length === 0) {
      yield* Effect.tryPromise(() => db.batch([cleanup, admissions]));
      return;
    }
    const ids = expired.map((entry) => entry.id);
    const placeholders = ids.map(() => "?").join(",");
    yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(`DELETE FROM support_recovery_events WHERE case_id IN (${placeholders})`)
          .bind(...ids),
        db.prepare(`DELETE FROM support_recovery_cases WHERE id IN (${placeholders})`).bind(...ids),
        cleanup,
        admissions,
      ])
    );
  }).pipe(Effect.mapError(() => new RecoveryRetentionUnavailable()));
