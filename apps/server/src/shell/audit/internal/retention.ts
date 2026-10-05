import { Effect, Schema } from "effect";
import { UserId } from "~/core/identity/contract";
import { AuditUnavailable, utcDayMilliseconds } from "~/shell/audit/contract";

const retentionDays = 365;
const retentionMilliseconds = retentionDays * utcDayMilliseconds;
const maximumRowsPerProjection = 64;
const maximumSubjectsPerSweep = 8;
const tables = [
  "transaction_audit",
  "pat_audit",
  "category_audit",
  "memory_audit",
  "budget_audit",
  "dashboard_audit",
  "insight_audit",
  "statement_submission_audit",
  "statement_clarification_audit",
  "statement_review_audit",
  "email_replacement_audit",
] as const;
const Time = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Retention = Schema.Struct({ userId: UserId, now: Time });
const Subjects = Schema.Array(Schema.Struct({ user_id: UserId }));

/** Runs a bounded, subject-scoped retention batch, atomically removing its temporary permission. */
export const retainEvidence = ({
  database,
  input,
}: Readonly<{
  database: D1Database;
  input: Readonly<{ userId: string; now: number }>;
}>): Effect.Effect<number, AuditUnavailable> =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeEffect(Retention)(input);
    const cutoff = request.now - retentionMilliseconds;
    const result = yield* Effect.tryPromise({
      try: () =>
        database.batch([
          database
            .prepare("INSERT INTO audit_retention_permits (user_id, cutoff_ms) VALUES (?, ?)")
            .bind(request.userId, cutoff),
          ...tables.map((table) =>
            database
              .prepare(
                `DELETE FROM ${table} WHERE user_id = ? AND id IN (SELECT id FROM ${table} WHERE user_id = ? AND occurred_at_ms < ? ORDER BY occurred_at_ms, id LIMIT ?)`
              )
              .bind(request.userId, request.userId, cutoff, maximumRowsPerProjection)
          ),
          database
            .prepare("DELETE FROM audit_retention_permits WHERE user_id = ?")
            .bind(request.userId),
        ]),
      catch: () => new AuditUnavailable(),
    });
    return result.slice(1, -1).reduce((count, row) => count + row.meta.changes, 0);
  }).pipe(Effect.mapError(() => new AuditUnavailable()));

/** Finds only bounded subject metadata; no financial or credential material enters maintenance. */
export const sweepEvidence = ({
  database,
  now,
}: Readonly<{ database: D1Database; now: number }>): Effect.Effect<number, AuditUnavailable> =>
  Effect.gen(function* () {
    const current = yield* Schema.decodeEffect(Time)(now);
    const rows = yield* Effect.tryPromise({
      try: () =>
        database.batch(
          tables.map((table) =>
            database
              .prepare(
                `SELECT user_id FROM ${table} WHERE occurred_at_ms < ? ORDER BY occurred_at_ms, id LIMIT ?`
              )
              .bind(current - retentionMilliseconds, maximumSubjectsPerSweep)
          )
        ),
      catch: () => new AuditUnavailable(),
    });
    const subjects = yield* Schema.decodeUnknownEffect(Subjects)(
      rows.flatMap((row) => row.results)
    );
    const userIds = [...new Set(subjects.map((row) => row.user_id))].slice(
      0,
      maximumSubjectsPerSweep
    );
    const totals = yield* Effect.forEach(userIds, (userId) =>
      retainEvidence({ database, input: { userId, now: current } })
    );
    return totals.reduce((sum, count) => sum + count, 0);
  }).pipe(Effect.mapError(() => new AuditUnavailable()));
