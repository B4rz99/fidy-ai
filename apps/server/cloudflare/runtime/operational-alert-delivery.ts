import { Schema } from "effect";
import { OperationalAlert } from "./operational-alerts";

const Claimed = Schema.Struct({
  attempts: Schema.Int.check(Schema.isGreaterThan(0)),
  started: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const ResolvedClaim = Schema.Struct({ ...OperationalAlert.fields, ...Claimed.fields });
const maximumSafeRetryMs = 82_800_000;
const minuteMs = 60_000;
const warningRepeatMinutes = 240;
const criticalRepeatMinutes = 30;
const warningRepeatMs = warningRepeatMinutes * minuteMs;
const criticalRepeatMs = criticalRepeatMinutes * minuteMs;

type Delivery = Readonly<{
  db: D1Database;
  now: number;
  alerts: ReadonlyArray<OperationalAlert>;
  signal: AbortSignal;
  send: (
    alert: OperationalAlert,
    idempotencyKey: string,
    delivery: Readonly<{ signal: AbortSignal; phase: "firing" | "resolved" }>
  ) => Promise<void>;
}>;

const claimOperationalAlert = async (
  db: D1Database,
  alert: OperationalAlert,
  now: number
): Promise<unknown> => {
  await db
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
    .run();
  const repeatMs = alert.severity === "critical" ? criticalRepeatMs : warningRepeatMs;
  return db
    .prepare(`UPDATE operational_alerts
      SET attempts = attempts + CASE WHEN delivery_confirmed = 1 OR attempt_started_ms IS NULL THEN 1 ELSE 0 END,
          attempt_started_ms = CASE WHEN delivery_confirmed = 1 OR attempt_started_ms IS NULL THEN ? ELSE attempt_started_ms END,
          delivery_confirmed = 0, last_attempt_ms = ?, next_attempt_ms = ?
      WHERE kind = ? AND owner = ? AND state = 'firing'
        AND acknowledged_ms IS NULL AND next_attempt_ms <= ?
      RETURNING attempts, attempt_started_ms AS started`)
    .bind(now, now, now + repeatMs, alert.kind, alert.owner, now)
    .first();
};

const deliverFiring = async (input: Delivery, alert: OperationalAlert): Promise<boolean> => {
  input.signal.throwIfAborted();
  const claimed = await claimOperationalAlert(input.db, alert, input.now);
  if (claimed === null) return true;
  const attempt = Schema.decodeUnknownSync(Claimed)(claimed);
  if (input.now - attempt.started >= maximumSafeRetryMs) return false;
  input.signal.throwIfAborted();
  try {
    await input.send(
      alert,
      `fidy-operational-${alert.kind}-${alert.owner}-${attempt.started}-${attempt.attempts}`,
      { signal: input.signal, phase: "firing" }
    );
    await input.db
      .prepare(`UPDATE operational_alerts SET delivery_confirmed = 1
      WHERE kind = ? AND owner = ? AND attempts = ? AND attempt_started_ms = ?`)
      .bind(alert.kind, alert.owner, attempt.attempts, attempt.started)
      .run();
    return true;
  } catch {
    return false;
  }
};

const claimResolutions = async (input: Delivery): Promise<ReadonlyArray<unknown>> => {
  // An unavailable inspection cannot prove absence. Leave the previous firing state intact.
  if (input.alerts.every((alert) => alert.kind !== "inspection_unavailable")) {
    await input.db
      .prepare(`UPDATE operational_alerts
      SET state = 'resolved', acknowledged_ms = NULL, delivery_confirmed = 0,
        attempts = 0, attempt_started_ms = NULL, next_attempt_ms = ?
      WHERE state = 'firing' AND last_seen_ms < ?`)
      .bind(input.now, input.now)
      .run();
  }
  const claimed = await input.db
    .prepare(`UPDATE operational_alerts
    SET attempts = attempts + CASE WHEN attempt_started_ms IS NULL THEN 1 ELSE 0 END,
        attempt_started_ms = COALESCE(attempt_started_ms, ?),
        last_attempt_ms = ?, next_attempt_ms = ? + CASE WHEN severity = 'critical' THEN ? ELSE ? END
    WHERE rowid IN (SELECT rowid FROM operational_alerts
      WHERE state = 'resolved' AND delivery_confirmed = 0 AND next_attempt_ms <= ? LIMIT 16)
    RETURNING kind, owner, severity, attempts, attempt_started_ms AS started`)
    .bind(input.now, input.now, input.now, criticalRepeatMs, warningRepeatMs, input.now)
    .all();
  return claimed.results;
};

const deliverResolution = async (input: Delivery, row: unknown): Promise<boolean> => {
  input.signal.throwIfAborted();
  const claim = Schema.decodeUnknownSync(ResolvedClaim)(row);
  if (input.now - claim.started >= maximumSafeRetryMs) return false;
  try {
    await input.send(
      claim,
      `fidy-operational-resolved-${claim.kind}-${claim.owner}-${claim.started}-${claim.attempts}`,
      { signal: input.signal, phase: "resolved" }
    );
    await input.db
      .prepare(`UPDATE operational_alerts SET delivery_confirmed = 1
      WHERE kind = ? AND owner = ? AND state = 'resolved' AND attempts = ? AND attempt_started_ms = ?`)
      .bind(claim.kind, claim.owner, claim.attempts, claim.started)
      .run();
    return true;
  } catch {
    return false;
  }
};

/** Claims metadata-only email attempts atomically. Failed sends remain unconfirmed. */
export const runOperationalAlerts = async (input: Delivery): Promise<void> => {
  const attempts = await Promise.all(input.alerts.map((alert) => deliverFiring(input, alert)));
  const resolutions = await Promise.all(
    (await claimResolutions(input)).map((row) => deliverResolution(input, row))
  );
  if (attempts.includes(false) || resolutions.includes(false)) {
    throw new Error("Operator alert email unavailable");
  }
};
