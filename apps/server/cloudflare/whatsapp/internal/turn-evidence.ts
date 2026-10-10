import { TranscriptText, type TranscriptTurnId } from "../../../src/core/agent/contract";
import {
  type UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "../../../src/core/identity/contract";
import { type Cause, Effect, Option, Schema } from "effect";

import { type OwnedStatement } from "../../../src/shell/owner-write/contract";
import { prepareHostedChannelRetention, prepareHostedChannelTurn } from "../../agent/operations";
import { prepareWhatsAppIdentity } from "../../identity/operations";
import {
  type WhatsAppHostedSubject,
  type WhatsAppInboundEvidence,
  type WhatsAppTurnCompletion,
} from "../contract";

const RecoverableWhatsAppDelivery = Schema.Struct({
  text: TranscriptText,
  send_started_at_ms: Schema.NullOr(Schema.Int),
  state: Schema.Literals([
    "sending",
    "accepted",
    "ambiguous",
    "rejected",
    "delivered",
    "unconfirmed",
  ]),
  portfolio_id: WhatsAppBusinessPortfolioId,
  bsuid: WhatsAppBusinessScopedUserId,
});

const isUnstartedWhatsAppSend = (delivery: typeof RecoverableWhatsAppDelivery.Type): boolean =>
  delivery.state === "sending" && delivery.send_started_at_ms === null;

const recoveredDeliveryOutcome = (
  delivery: typeof RecoverableWhatsAppDelivery.Type
): WhatsAppTurnCompletion["result"] =>
  delivery.state === "delivered"
    ? { _tag: "Completed", text: delivery.text }
    : {
        _tag: "Failed",
        reason: delivery.state === "rejected" ? "DeliveryFailed" : "DeliveryUnconfirmed",
      };

const recoveredDeliverySubject = (
  delivery: typeof RecoverableWhatsAppDelivery.Type,
  userId: UserId
): WhatsAppHostedSubject => ({
  _tag: "WhatsAppHosted",
  userId,
  portfolioId: delivery.portfolio_id,
  bsuid: delivery.bsuid,
});

/** Once a provider call might have begun, interruption is no longer an honest delivery outcome. */
export const recoverWhatsAppDelivery = ({
  db,
  userId,
  turnId,
  startedAtMs,
  now,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  turnId: TranscriptTurnId;
  startedAtMs: number;
  now: number;
}>): Effect.Effect<
  Option.Option<WhatsAppTurnCompletion>,
  Cause.UnknownError | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT d.text, d.state, d.send_started_at_ms, i.portfolio_id, i.bsuid
        FROM hosted_whatsapp_delivery AS d JOIN hosted_whatsapp_inbound AS i
          ON i.turn_id = d.turn_id AND i.user_id = d.user_id
        WHERE d.turn_id = ? AND d.user_id = ?`)
        .bind(turnId, userId)
        .first()
    );
    if (raw === null) return Option.none();
    const delivery = yield* Schema.decodeUnknownEffect(RecoverableWhatsAppDelivery)(raw);
    if (isUnstartedWhatsAppSend(delivery)) {
      return Option.none(); // Pre-send abandonment: normal Pending Turn recovery writes Interrupted.
    }
    if (
      delivery.state === "sending" ||
      delivery.state === "accepted" ||
      delivery.state === "ambiguous"
    ) {
      yield* Effect.tryPromise(() =>
        db
          .prepare(`UPDATE hosted_whatsapp_delivery SET state = 'unconfirmed'
          WHERE turn_id = ? AND user_id = ? AND state IN ('sending','accepted','ambiguous')`)
          .bind(turnId, userId)
          .run()
      );
    }
    return Option.some({
      userId,
      turnId,
      startedAtMs,
      result: recoveredDeliveryOutcome(delivery),
      subject: recoveredDeliverySubject(delivery, userId),
      now,
    });
  });

export const prepareWhatsAppInbound = ({
  db,
  subject,
  inbound,
  id,
  now,
}: Readonly<{
  db: D1Database;
  subject: WhatsAppHostedSubject;
  inbound: WhatsAppInboundEvidence;
  id: TranscriptTurnId;
  now: number;
}>): ReadonlyArray<D1PreparedStatement> => [
  prepareHostedChannelTurn({
    db,
    userId: subject.userId,
    statement: {
      sql: `INSERT INTO hosted_whatsapp_inbound
      (turn_id, user_id, portfolio_id, bsuid, message_id, business_phone_number_id,
       occurred_at_ms, received_at_ms,reply_to_message_id)
      SELECT id, user_id, ?, ?, ?, ?, ?, ?,NULLIF(?,'') FROM channel_turns
      WHERE id = ? AND user_id = ? AND status = 'pending'`,
      params: [
        subject.portfolioId,
        subject.bsuid,
        inbound.messageId,
        inbound.businessPhoneNumberId,
        inbound.occurredAtMs,
        inbound.receivedAtMs,
        Option.getOrElse(inbound.replyToMessageId, () => ""),
        id,
        subject.userId,
      ],
    },
  }),
  db
    .prepare(`INSERT INTO hosted_whatsapp_outbox (turn_id, user_id, created_at_ms)
      SELECT turn_id, user_id, ? FROM hosted_whatsapp_inbound WHERE turn_id = ? AND user_id = ?`)
    .bind(now, id, subject.userId),
  prepareWhatsAppIdentity({
    db,
    userId: subject.userId,
    statement: {
      sql: `INSERT INTO hosted_whatsapp_windows
      (user_id, portfolio_id, bsuid, last_verified_inbound_at_ms, closes_at_ms)
      SELECT i.user_id, i.portfolio_id, i.bsuid, MIN(i.occurred_at_ms, i.received_at_ms),
        MIN(i.occurred_at_ms, i.received_at_ms) + 86400000
      FROM hosted_whatsapp_inbound AS i
      JOIN identity_associations AS w ON w.userId = i.user_id AND w.businessPortfolioId = i.portfolio_id
        AND w.businessScopedUserId = i.bsuid
      WHERE i.turn_id = ? AND i.user_id = ?
      ON CONFLICT (user_id, portfolio_id, bsuid) DO UPDATE SET
        last_verified_inbound_at_ms = excluded.last_verified_inbound_at_ms,
        closes_at_ms = excluded.closes_at_ms
      WHERE excluded.last_verified_inbound_at_ms > hosted_whatsapp_windows.last_verified_inbound_at_ms`,
      params: [id, subject.userId],
    },
  }),
];

const expiredChannelOutbox = `DELETE FROM hosted_whatsapp_outbox WHERE rowid IN (
  SELECT o.rowid FROM channel_retention_turns AS t CROSS JOIN hosted_whatsapp_outbox AS o
  WHERE o.user_id=t.user_id AND o.turn_id=t.id LIMIT 100)`;

/** Expire only terminal channel evidence older than the approved thirty-day retention, for one explicit User. */
export const expireWhatsAppEvidence = ({
  db,
  userId,
  now,
}: Readonly<{ db: D1Database; userId: UserId; now: number }>): Effect.Effect<
  void,
  Cause.UnknownError
> =>
  Effect.tryPromise(() =>
    db.batch([
      prepareHostedChannelRetention({
        db,
        userId,
        now,
        statement: {
          sql: `DELETE FROM hosted_whatsapp_delivery_events WHERE rowid IN (
        SELECT e.rowid FROM channel_retention_turns AS t CROSS JOIN hosted_whatsapp_delivery AS d CROSS JOIN hosted_whatsapp_delivery_events AS e
        WHERE d.user_id=t.user_id AND d.turn_id=t.id AND e.correlation_token=d.correlation_token
        LIMIT 200)`,
          params: [],
        },
      }),
      prepareHostedChannelRetention({
        db,
        userId,
        now,
        statement: {
          sql: `DELETE FROM hosted_whatsapp_delivery WHERE rowid IN (
        SELECT d.rowid FROM channel_retention_turns AS t CROSS JOIN hosted_whatsapp_delivery AS d
        WHERE d.user_id=t.user_id AND d.turn_id=t.id AND NOT EXISTS (
          SELECT 1 FROM hosted_whatsapp_delivery_events AS e WHERE e.correlation_token=d.correlation_token)
        LIMIT 100)`,
          params: [],
        },
      }),
      prepareHostedChannelRetention({
        db,
        userId,
        now,
        statement: {
          sql: expiredChannelOutbox,
          params: [],
        },
      }),
      prepareHostedChannelRetention({
        db,
        userId,
        now,
        statement: {
          sql: `DELETE FROM hosted_whatsapp_inbound WHERE rowid IN (
        SELECT i.rowid FROM channel_retention_turns AS t CROSS JOIN hosted_whatsapp_inbound AS i
        WHERE i.user_id=t.user_id AND i.turn_id=t.id AND NOT EXISTS (
          SELECT 1 FROM hosted_whatsapp_delivery AS d WHERE d.user_id=i.user_id AND d.turn_id=i.turn_id)
        AND NOT EXISTS (SELECT 1 FROM hosted_whatsapp_outbox AS o WHERE o.turn_id=i.turn_id)
        LIMIT 100)`,
          params: [],
        },
      }),
    ])
  ).pipe(Effect.asVoid);
/** Permit Interrupted only while this same Pending hosted_turns row has no begun channel send. */
export const whatsAppInterruptionGuard =
  (): string => `AND NOT EXISTS (SELECT 1 FROM hosted_whatsapp_delivery AS d
          WHERE d.turn_id = hosted_turns.id AND d.user_id = hosted_turns.user_id
            AND d.send_started_at_ms IS NOT NULL)`;
/** Require verified visible delivery before this same hosted_turns row can become Completed. */
export const whatsAppCompletionGuard = (
  status: string
): Readonly<{ sql: string; bindings: ReadonlyArray<string> }> => ({
  sql: `AND (? <> 'completed' OR EXISTS (SELECT 1 FROM hosted_whatsapp_delivery AS d
          WHERE d.turn_id = hosted_turns.id AND d.user_id = hosted_turns.user_id
            AND d.state = 'delivered'))`,
  bindings: [status],
});
/** Same-User proposal times for bounded abandoned-Turn recovery; never a delivery receipt. */
export const whatsAppProposalTimes = (userId: UserId): OwnedStatement => ({
  sql: "SELECT turn_id AS turnId, proposed_at_ms AS proposedAtMs FROM hosted_whatsapp_delivery WHERE user_id = ?",
  params: [userId],
});
/** Compose removal of one Turn's queued identity with the owner's terminal or interruption unit. */
export const prepareWhatsAppWorkCleanup = ({
  db,
  userId,
  turnId,
  requireTerminal,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  turnId: TranscriptTurnId;
  requireTerminal: boolean;
}>): D1PreparedStatement =>
  requireTerminal
    ? prepareHostedChannelTurn({
        db,
        userId,
        statement: {
          sql: `DELETE FROM hosted_whatsapp_outbox WHERE turn_id = ? AND user_id = ?
      AND EXISTS (SELECT 1 FROM channel_turns WHERE id = ? AND user_id = ? AND status <> 'pending')`,
          params: [turnId, userId, turnId, userId],
        },
      })
    : db
        .prepare("DELETE FROM hosted_whatsapp_outbox WHERE turn_id = ? AND user_id = ?")
        .bind(turnId, userId);

/** Bounded sweep ordering for its enclosing hosted_turns alias t; the caller keeps its due predicates and limit. */
export const whatsAppRecoveryPriority = (): string =>
  `COALESCE((SELECT created_at_ms FROM hosted_whatsapp_outbox WHERE turn_id = t.id AND user_id = t.user_id), t.started_at_ms)`;
