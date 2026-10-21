import { prepareChangedRowAssertion } from "~/shell/sql-assertions/operations";
import { Effect, Schema } from "effect";
import { UserId } from "~/core/identity/contract";
import { AuditUnavailable, auditRetentionDays, utcDayMilliseconds } from "~/shell/audit/contract";

const retentionMilliseconds = auditRetentionDays * utcDayMilliseconds;
const maximumRows = 64;
const maximumSubjects = 8;
const retainedKinds =
  "record_type IN ('session_call','credential_call','insight_call','publication')";
const Time = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Retention = Schema.Struct({ userId: UserId, now: Time });
const Subjects = Schema.Array(Schema.Struct({ user_id: UserId }));

/** One bounded subject batch removes expired call evidence and its temporary permit atomically. */
export const retainEvidence = ({
  database,
  input,
}: Readonly<{
  database: D1Database;
  input: Readonly<{ userId: string; now: number }>;
}>): Effect.Effect<number, AuditUnavailable> =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeEffect(Retention)(input);
    const result = yield* Effect.tryPromise(() =>
      database.batch([
        database
          .prepare(
            "UPDATE users SET audit_retention_cutoff_ms=?2 WHERE id=?1 AND audit_retention_cutoff_ms IS NULL"
          )
          .bind(request.userId, request.now - retentionMilliseconds),
        prepareChangedRowAssertion({ db: database, scope: "audit_retention" }),
        database
          .prepare(
            `DELETE FROM audit_entries WHERE sequence IN (SELECT sequence FROM audit_entries WHERE user_id=? AND ${retainedKinds} AND occurred_at_ms<? ORDER BY occurred_at_ms,id LIMIT ?)`
          )
          .bind(request.userId, request.now - retentionMilliseconds, maximumRows),
        database
          .prepare("UPDATE users SET audit_retention_cutoff_ms=NULL WHERE id=?")
          .bind(request.userId),
      ])
    );
    return result[2]?.meta.changes ?? 0;
  }).pipe(Effect.mapError(() => new AuditUnavailable()));

/** Select only bounded subject metadata, then apply the same subject-owned retention operation. */
export const sweepEvidence = ({
  database,
  now,
}: Readonly<{ database: D1Database; now: number }>): Effect.Effect<number, AuditUnavailable> =>
  Effect.gen(function* () {
    const current = yield* Schema.decodeEffect(Time)(now);
    const rows = yield* Effect.tryPromise(() =>
      database
        .prepare(
          `SELECT user_id FROM audit_entries WHERE ${retainedKinds} AND occurred_at_ms<? ORDER BY occurred_at_ms,id LIMIT ?`
        )
        .bind(current - retentionMilliseconds, maximumSubjects)
        .all()
    );
    const subjects = yield* Schema.decodeUnknownEffect(Subjects)(rows.results);
    const totals = yield* Effect.forEach(
      [...new Set(subjects.map(({ user_id }) => user_id))],
      (userId) => retainEvidence({ database, input: { userId, now: current } })
    );
    return totals.reduce((sum, count) => sum + count, 0);
  }).pipe(Effect.mapError(() => new AuditUnavailable()));
