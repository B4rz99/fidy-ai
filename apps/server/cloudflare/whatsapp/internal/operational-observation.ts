import { Effect, Exit, Schema } from "effect";
import { hostedChannelTurnObservation } from "../../agent/operations";
import { prepareConsentOperationalMetadata } from "../../consent/operations";
import { type WhatsAppOperationalSignal, whatsAppServiceWindowMilliseconds } from "../contract";

const WhatsAppAge = Schema.Struct({ created: Schema.Int });
const sampleLimit = 8;
const staleAfterMilliseconds = 120_000;
const rejectedWindowMilliseconds = 86_400_000;
const pendingWhatsApp = (db: D1Database): D1PreparedStatement =>
  prepareConsentOperationalMetadata({
    db,
    statement: {
      sql: `SELECT created FROM (
                SELECT created_at_ms AS created FROM consent_pending_deliveries
                UNION ALL SELECT d.proposed_at_ms FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') AS d
                  JOIN (${hostedChannelTurnObservation()}) AS t ON t.id = d.turn_id AND t.user_id = d.user_id
                  WHERE t.status = 'pending' AND d.state IN ('sending', 'accepted', 'ambiguous')
              ) ORDER BY created LIMIT ?`,
      params: [sampleLimit],
    },
  });

const failedWhatsApp = (db: D1Database, current: number): D1PreparedStatement =>
  db
    .prepare(`SELECT created FROM (
            SELECT proposed_at_ms AS created FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') AS hosted_whatsapp_delivery
              WHERE state IN ('rejected', 'unconfirmed') AND proposed_at_ms >= ?
            UNION ALL SELECT t.terminal_at_ms FROM (${hostedChannelTurnObservation()}) AS t
              JOIN (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL) AS i ON i.turn_id = t.id AND i.user_id = t.user_id
              WHERE t.status = 'failed' AND t.failure_reason = 'DeliveryFailed'
                AND t.terminal_at_ms >= ? AND NOT EXISTS
                  (SELECT 1 FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') AS d WHERE d.turn_id = t.id)
          ) ORDER BY created LIMIT ?`)
    .bind(current - rejectedWindowMilliseconds, current - rejectedWindowMilliseconds, sampleLimit);

/** Each condition has its own bounded sample; old pending work cannot mask failed delivery. */
export const inspectWhatsApp = ({
  db,
  current,
}: Readonly<{ db: D1Database; current: number }>): Effect.Effect<WhatsAppOperationalSignal> =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      Effect.tryPromise(() =>
        db.batch([
          pendingWhatsApp(db),
          failedWhatsApp(db, current),
          prepareConsentOperationalMetadata({
            db,
            statement: {
              sql: `SELECT created FROM (
              SELECT last_verified_inbound_at_ms + 86400000 AS created FROM whatsapp_service_windows WHERE last_verified_inbound_at_ms <= ?
              UNION ALL SELECT expires_at_ms FROM consent_expiry_deadlines WHERE expires_at_ms <= ?
            ) ORDER BY created LIMIT ?`,
              params: [current - whatsAppServiceWindowMilliseconds, current, sampleLimit],
            },
          }),
        ])
      ).pipe(
        Effect.flatMap((results) =>
          Schema.decodeUnknownEffect(
            Schema.Tuple([
              Schema.Struct({ results: Schema.Array(WhatsAppAge) }),
              Schema.Struct({ results: Schema.Array(WhatsAppAge) }),
              Schema.Struct({ results: Schema.Array(WhatsAppAge) }),
            ])
          )(results)
        )
      )
    );
    if (Exit.isFailure(result)) {
      return { component: "async-health", operation: "whatsapp", state: "unavailable" };
    }
    const [{ results: pending }, { results: failed }, { results: cleanup }] = result.value;
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
