import { Config, DateTime, Duration, Effect, Layer, Schedule, Schema } from "effect";
import { removeAuditLogEntriesBefore } from "./repo";

const minimumRetention = Duration.days(300);
const maximumRetention = Duration.days(400);

const PolicyRetentionDuration = Schema.DurationFromString.check(
  Schema.makeFilter((duration) => {
    const milliseconds = Duration.toMillis(duration);
    return Duration.isFinite(duration) &&
      milliseconds >= Duration.toMillis(minimumRetention) &&
      milliseconds <= Duration.toMillis(maximumRetention)
      ? undefined
      : { path: [], issue: "Expected audit retention between 300 and 400 days" };
  })
);

/**
 * How long attributable AuditLogEntry evidence remains available. Deployment
 * may override the 365-day default with an Effect Duration string between 300
 * and 400 days in `FIDY_AUDIT_RETENTION`.
 */
export const auditRetentionDuration = Config.schema(
  PolicyRetentionDuration,
  "FIDY_AUDIT_RETENTION"
).pipe(Config.withDefault(Duration.days(365)));

/**
 * Applies configured retention at one caller-supplied UTC instant. The stable
 * instant makes the cutoff deterministic; entries exactly at it remain, while
 * only strictly older evidence is removed through the cutoff-only repo seam.
 */
const removeExpiredAuditLogEntries = (now: DateTime.Utc, retention: Duration.Duration) =>
  removeAuditLogEntriesBefore(DateTime.subtractDuration(now, retention));

/**
 * Applies the configured retention window at a caller-supplied UTC instant.
 * Invalid configuration fails before the repository can delete evidence.
 */
export const runConfiguredAuditRetention = (now: DateTime.Utc) =>
  Effect.flatMap(auditRetentionDuration, (retention) =>
    removeExpiredAuditLogEntries(now, retention)
  );

const runAuditRetention = (retention: Duration.Duration) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    yield* removeExpiredAuditLogEntries(now, retention);
    yield* Effect.logInfo("Applied AuditLogEntry retention");
  }).pipe(
    Effect.catchCause(() =>
      Effect.logError("AuditLogEntry retention failed; the next daily run will retry")
    )
  );

/**
 * Production retention worker. Configuration is resolved at layer launch so an
 * invalid duration fails boot; cleanup then runs immediately and once per day.
 * Database failures are reported and retried on the next run rather than
 * terminating the long-lived worker.
 */
export const AuditRetentionLive = Layer.unwrap(
  Effect.map(auditRetentionDuration, (retention) =>
    Layer.effectDiscard(
      runAuditRetention(retention).pipe(Effect.repeat(Schedule.spaced("1 day")), Effect.forkScoped)
    )
  )
);
