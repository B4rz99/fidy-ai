import { Effect, Exit, Schema } from "effect";
import { hostedChannelTurnObservation } from "../../agent/operations";
import { prepareConsentOperationalMetadata } from "../../consent/operations";
import { type WhatsAppOperationalSignal } from "../contract";

const WhatsAppAge = Schema.Struct({ created: Schema.Int });
const sampleLimit = 8;
const staleAfterMilliseconds = 120_000;
const rejectedWindowMilliseconds = 86_400_000;
const readWhatsAppSample = (
  statement: D1PreparedStatement
): Effect.Effect<ReadonlyArray<typeof WhatsAppAge.Type>, void> =>
  Effect.tryPromise(() => statement.all()).pipe(
    Effect.flatMap((rows) => Schema.decodeUnknownEffect(Schema.Array(WhatsAppAge))(rows.results)),
    Effect.mapError(() => undefined)
  );

const readPendingWhatsApp = (
  db: D1Database
): Effect.Effect<ReadonlyArray<typeof WhatsAppAge.Type>, void> =>
  readWhatsAppSample(
    prepareConsentOperationalMetadata({
      db,
      statement: {
        sql: `SELECT created FROM (
                SELECT created_at_ms AS created FROM consent_pending_deliveries
                UNION ALL SELECT d.proposed_at_ms FROM hosted_whatsapp_delivery AS d
                  JOIN (${hostedChannelTurnObservation()}) AS t ON t.id = d.turn_id AND t.user_id = d.user_id
                  WHERE t.status = 'pending' AND d.state IN ('sending', 'accepted', 'ambiguous')
              ) ORDER BY created LIMIT ?`,
        params: [sampleLimit],
      },
    })
  );

const readFailedWhatsApp = (
  db: D1Database,
  current: number
): Effect.Effect<ReadonlyArray<typeof WhatsAppAge.Type>, void> =>
  readWhatsAppSample(
    db
      .prepare(`SELECT created FROM (
            SELECT proposed_at_ms AS created FROM hosted_whatsapp_delivery
              WHERE state IN ('rejected', 'unconfirmed') AND proposed_at_ms >= ?
            UNION ALL SELECT t.terminal_at_ms FROM (${hostedChannelTurnObservation()}) AS t
              JOIN hosted_whatsapp_inbound AS i ON i.turn_id = t.id AND i.user_id = t.user_id
              WHERE t.status = 'failed' AND t.failure_reason = 'DeliveryFailed'
                AND t.terminal_at_ms >= ? AND NOT EXISTS
                  (SELECT 1 FROM hosted_whatsapp_delivery AS d WHERE d.turn_id = t.id)
          ) ORDER BY created LIMIT ?`)
      .bind(current - rejectedWindowMilliseconds, current - rejectedWindowMilliseconds, sampleLimit)
  );

/** Each condition has its own bounded sample; old pending work cannot mask failed delivery. */
export const inspectWhatsApp = ({
  db,
  current,
}: Readonly<{ db: D1Database; current: number }>): Effect.Effect<WhatsAppOperationalSignal> =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      Effect.all({
        pending: readPendingWhatsApp(db),
        failed: readFailedWhatsApp(db, current),
        cleanup: readWhatsAppSample(
          prepareConsentOperationalMetadata({
            db,
            statement: {
              sql: `SELECT created FROM (
                SELECT closes_at_ms AS created FROM hosted_whatsapp_windows WHERE closes_at_ms <= ?
                UNION ALL SELECT expires_at_ms FROM consent_expiry_deadlines WHERE expires_at_ms <= ?
              ) ORDER BY created LIMIT ?`,
              params: [current, current, sampleLimit],
            },
          })
        ),
      })
    );
    if (Exit.isFailure(result)) {
      return { component: "async-health", operation: "whatsapp", state: "unavailable" };
    }
    const { pending, failed, cleanup } = result.value;
    const oldestPendingAgeMilliseconds = Math.max(
      0,
      ...pending.map((row) => current - row.created)
    );
    return {
      component: "async-health",
      operation: "whatsapp",
      state:
        failed.length > 0 ||
        cleanup.length > 0 ||
        oldestPendingAgeMilliseconds >= staleAfterMilliseconds
          ? "attention"
          : "healthy",
      sampledPending: pending.length,
      sampledFailed: failed.length,
      overdueCleanup: cleanup.length,
      sampleLimited: [pending, failed, cleanup].some((rows) => rows.length === sampleLimit),
      oldestPendingAgeMilliseconds,
    };
  });
