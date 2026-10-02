import { type Cause, Effect, Schema } from "effect";
import { OperationalAlert, type OperationalAlertDelivery } from "../contract";

const Claimed = Schema.Struct({
  attempts: Schema.Int.check(Schema.isGreaterThan(0)),
  started: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const maximumSafeRetryMs = 82_800_000;
const minuteMs = 60_000;
const warningRepeatMinutes = 240;
const criticalRepeatMinutes = 30;
const warningRepeatMs = warningRepeatMinutes * minuteMs;
const criticalRepeatMs = criticalRepeatMinutes * minuteMs;

const claimOperationalAlert = (
  db: D1Database,
  alert: OperationalAlert,
  now: number
): Effect.Effect<unknown, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      db
        .prepare(`INSERT INTO operational_alerts
      (kind, owner, severity, state, first_seen_ms, last_seen_ms, next_attempt_ms)
      VALUES (?, ?, ?, 'firing', ?, ?, ?)
      ON CONFLICT(kind, owner) DO UPDATE SET
        state = 'firing', severity = excluded.severity, last_seen_ms = excluded.last_seen_ms,
        first_seen_ms = CASE WHEN operational_alerts.state = 'resolved' THEN excluded.first_seen_ms ELSE operational_alerts.first_seen_ms END,
        acknowledged_ms = CASE WHEN operational_alerts.state = 'resolved' OR operational_alerts.severity != excluded.severity THEN NULL ELSE operational_alerts.acknowledged_ms END,
        next_attempt_ms = CASE WHEN operational_alerts.state = 'resolved' OR operational_alerts.severity != excluded.severity THEN excluded.next_attempt_ms ELSE operational_alerts.next_attempt_ms END,
        delivery_confirmed = CASE WHEN operational_alerts.state = 'resolved' OR operational_alerts.severity != excluded.severity THEN 1 ELSE operational_alerts.delivery_confirmed END
      WHERE excluded.last_seen_ms >= operational_alerts.last_seen_ms`)
        .bind(alert.kind, alert.owner, alert.severity, now, now, now)
        .run()
    );
    const repeatMs = alert.severity === "critical" ? criticalRepeatMs : warningRepeatMs;
    return yield* Effect.tryPromise(() =>
      db
        .prepare(`UPDATE operational_alerts
      SET attempts = attempts + CASE WHEN delivery_confirmed = 1 OR attempt_started_ms IS NULL OR attempt_started_ms <= ? THEN 1 ELSE 0 END,
          attempt_started_ms = CASE WHEN delivery_confirmed = 1 OR attempt_started_ms IS NULL OR attempt_started_ms <= ? THEN ? ELSE attempt_started_ms END,
          delivery_confirmed = 0, last_attempt_ms = ?, next_attempt_ms = ?
      WHERE kind = ? AND owner = ? AND state = 'firing'
        AND acknowledged_ms IS NULL AND next_attempt_ms <= ?
      RETURNING attempts, attempt_started_ms AS started`)
        .bind(
          now - maximumSafeRetryMs,
          now - maximumSafeRetryMs,
          now,
          now,
          now + repeatMs,
          alert.kind,
          alert.owner,
          now
        )
        .first()
    );
  });

export const deliverFiring = ({
  input,
  alert,
}: Readonly<{ input: OperationalAlertDelivery; alert: OperationalAlert }>): Effect.Effect<
  boolean,
  Cause.UnknownError | Schema.SchemaError
> =>
  Effect.gen(function* () {
    input.signal.throwIfAborted();
    const claimed = yield* claimOperationalAlert(input.db, alert, input.now);
    if (claimed === null) return true;
    const attempt = yield* Schema.decodeUnknownEffect(Claimed)(claimed);
    input.signal.throwIfAborted();
    return yield* Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        input.send(
          alert,
          `fidy-operational-${alert.kind}-${alert.owner}-${attempt.started}-${attempt.attempts}`,
          { signal: input.signal, phase: "firing" }
        )
      );
      yield* Effect.tryPromise(() =>
        input.db
          .prepare(`UPDATE operational_alerts SET delivery_confirmed = 1
        WHERE kind = ? AND owner = ? AND attempts = ? AND attempt_started_ms = ?`)
          .bind(alert.kind, alert.owner, attempt.attempts, attempt.started)
          .run()
      );
      return true;
    }).pipe(Effect.orElseSucceed(() => false));
  });

export const claimResolutions = (
  input: OperationalAlertDelivery
): Effect.Effect<ReadonlyArray<unknown>, Cause.UnknownError> =>
  Effect.gen(function* () {
    // An unavailable inspection cannot prove absence. Leave the previous firing state intact.
    if (input.alerts.every((alert) => alert.kind !== "inspection_unavailable")) {
      yield* Effect.tryPromise(() =>
        input.db
          .prepare(`UPDATE operational_alerts
      SET state = 'resolved', acknowledged_ms = NULL, delivery_confirmed = 0,
        attempts = 0, attempt_started_ms = NULL, next_attempt_ms = ?
      WHERE state = 'firing' AND last_seen_ms < ?`)
          .bind(input.now, input.now)
          .run()
      );
    }
    const claimed = yield* Effect.tryPromise(() =>
      input.db
        .prepare(`UPDATE operational_alerts
    SET attempts = attempts + CASE WHEN attempt_started_ms IS NULL OR attempt_started_ms <= ? THEN 1 ELSE 0 END,
        attempt_started_ms = CASE WHEN attempt_started_ms IS NULL OR attempt_started_ms <= ? THEN ? ELSE attempt_started_ms END,
        last_attempt_ms = ?, next_attempt_ms = ? + CASE WHEN severity = 'critical' THEN ? ELSE ? END
    WHERE rowid IN (SELECT rowid FROM operational_alerts
      WHERE state = 'resolved' AND delivery_confirmed = 0 AND next_attempt_ms <= ? LIMIT 16)
    RETURNING kind, owner, severity, attempts, attempt_started_ms AS started`)
        .bind(
          input.now - maximumSafeRetryMs,
          input.now - maximumSafeRetryMs,
          input.now,
          input.now,
          input.now,
          criticalRepeatMs,
          warningRepeatMs,
          input.now
        )
        .all()
    );
    return claimed.results;
  });

export const deliverResolution = ({
  input,
  row,
}: Readonly<{ input: OperationalAlertDelivery; row: unknown }>): Effect.Effect<
  boolean,
  Cause.UnknownError | Schema.SchemaError
> =>
  Effect.gen(function* () {
    input.signal.throwIfAborted();
    const alert = yield* Schema.decodeUnknownEffect(OperationalAlert)(row);
    const claim = yield* Schema.decodeUnknownEffect(Claimed)(row);
    return yield* Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        input.send(
          alert,
          `fidy-operational-resolved-${alert.kind}-${alert.owner}-${claim.started}-${claim.attempts}`,
          { signal: input.signal, phase: "resolved" }
        )
      );
      yield* Effect.tryPromise(() =>
        input.db
          .prepare(`UPDATE operational_alerts SET delivery_confirmed = 1
        WHERE kind = ? AND owner = ? AND state = 'resolved' AND attempts = ? AND attempt_started_ms = ?`)
          .bind(alert.kind, alert.owner, claim.attempts, claim.started)
          .run()
      );
      return true;
    }).pipe(Effect.orElseSucceed(() => false));
  });
