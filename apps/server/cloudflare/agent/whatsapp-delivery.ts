import { type Cause, DateTime, Effect, Option, Schema } from "effect";
import { TranscriptText, TranscriptTurnId, UserId } from "@fidy/server/agent-runtime";
import { newId } from "../platform/operations";
import { deliveryAcknowledgmentWindowMs, finishHostedTurn } from "./turn-store";
import { WhatsAppHostedSubject } from "./hosted-authority";
import type { WhatsAppStatusAdmission } from "./whatsapp-turn";
import type { KapsoHostedLifecycleEvidence } from "../../src/shell/channels/whatsapp/kapso-webhook";
import {
  HostedDeliveryCorrelationToken,
  WhatsAppProviderMessageId,
} from "../../src/shell/channels/whatsapp/model";

const Proposal = Schema.Struct({
  turn_id: TranscriptTurnId,
  user_id: UserId,
  text: Schema.String,
  state: Schema.Literals([
    "sending",
    "accepted",
    "ambiguous",
    "rejected",
    "delivered",
    "unconfirmed",
  ]),
  provider_message_id: Schema.NullOr(WhatsAppProviderMessageId),
});
export type WhatsAppDeliveryProposal = typeof Proposal.Type;
type AuthenticatedHostedStatus = Pick<
  KapsoHostedLifecycleEvidence,
  "correlationToken" | "messageEvidence" | "businessPhoneNumberId" | "occurredAt"
> &
  Readonly<{ outcome: "sent" | "delivered" | "failed" }>;

/** Reserve before any network call; the unique Turn row prevents a second visible send. */
export const stageWhatsAppDelivery = ({
  db,
  userId,
  turnId,
  text,
  now,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  turnId: TranscriptTurnId;
  text: TranscriptText;
  now: number;
}>): Effect.Effect<Option.Option<HostedDeliveryCorrelationToken>, Cause.UnknownError> =>
  Effect.gen(function* () {
    const token = HostedDeliveryCorrelationToken.make(newId());
    const saved = yield* Effect.tryPromise(() =>
      db
        .prepare(`INSERT INTO hosted_whatsapp_delivery
        (turn_id, user_id, text, correlation_token, business_phone_number_id, proposed_at_ms, state)
        SELECT t.id, t.user_id, ?, ?, i.business_phone_number_id, ?, 'sending'
        FROM hosted_turns AS t JOIN hosted_whatsapp_inbound AS i
          ON i.turn_id = t.id AND i.user_id = t.user_id
        WHERE t.id = ? AND t.user_id = ? AND t.status = 'pending'`)
        .bind(text, token, now, turnId, userId)
        .run()
    );
    return saved.meta.changes === 1 ? Option.some(token) : Option.none();
  });

/** Claim the irreversible provider boundary only when the same verified window remains open. */
export const startWhatsAppSend = ({
  db,
  userId,
  turnId,
  token,
  now,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  turnId: TranscriptTurnId;
  token: HostedDeliveryCorrelationToken;
  now: number;
}>): Effect.Effect<boolean, Cause.UnknownError> =>
  Effect.gen(function* () {
    const saved = yield* Effect.tryPromise(() =>
      db
        .prepare(`UPDATE hosted_whatsapp_delivery
      SET send_started_at_ms = ?
      WHERE turn_id = ? AND user_id = ? AND correlation_token = ?
        AND state = 'sending' AND send_started_at_ms IS NULL
        AND EXISTS (SELECT 1 FROM hosted_turns AS t
          WHERE t.id = hosted_whatsapp_delivery.turn_id AND t.user_id = ? AND t.status = 'pending')
        AND EXISTS (SELECT 1 FROM hosted_whatsapp_inbound AS i
          JOIN hosted_whatsapp_windows AS w ON w.user_id = i.user_id
            AND w.portfolio_id = i.portfolio_id AND w.bsuid = i.bsuid
          JOIN whatsapp_identities AS identity ON identity.user_id = i.user_id
            AND identity.portfolio_id = i.portfolio_id AND identity.bsuid = i.bsuid
          WHERE i.turn_id = hosted_whatsapp_delivery.turn_id AND i.user_id = ?
            AND w.closes_at_ms > ?)`)
        .bind(now, turnId, userId, token, userId, userId, now)
        .run()
    );
    return saved.meta.changes === 1;
  });

/** Refuse a prepared reply without ever claiming the provider boundary. */
export const rejectUnstartedWhatsAppDelivery = ({
  db,
  userId,
  turnId,
  token,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  turnId: TranscriptTurnId;
  token: HostedDeliveryCorrelationToken;
}>): Effect.Effect<boolean, Cause.UnknownError> =>
  Effect.gen(function* () {
    const saved = yield* Effect.tryPromise(() =>
      db
        .prepare(`UPDATE hosted_whatsapp_delivery
      SET state = 'rejected' WHERE turn_id = ? AND user_id = ? AND correlation_token = ?
        AND state = 'sending' AND send_started_at_ms IS NULL
        AND EXISTS (SELECT 1 FROM hosted_turns AS t
          WHERE t.id = hosted_whatsapp_delivery.turn_id AND t.user_id = ? AND t.status = 'pending')`)
        .bind(turnId, userId, token, userId)
        .run()
    );
    return saved.meta.changes === 1;
  });

/** Send acceptance never means delivery; ambiguous outcomes are not automatically resent. */
export const recordWhatsAppSend = ({
  db,
  userId,
  turnId,
  token,
  outcome,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  turnId: TranscriptTurnId;
  token: HostedDeliveryCorrelationToken;
  outcome:
    | Readonly<{ kind: "accepted"; messageId: WhatsAppProviderMessageId }>
    | Readonly<{ kind: "ambiguous" | "rejected" }>;
}>): Effect.Effect<boolean, Cause.UnknownError> =>
  Effect.gen(function* () {
    const id = outcome.kind === "accepted" ? outcome.messageId : null;
    const saved = yield* Effect.tryPromise(() =>
      db
        .prepare(`UPDATE hosted_whatsapp_delivery
        SET state = ?, provider_message_id = COALESCE(provider_message_id, ?)
        WHERE turn_id = ? AND user_id = ? AND correlation_token = ? AND state = 'sending'
          AND send_started_at_ms IS NOT NULL
          AND (provider_message_id IS NULL OR provider_message_id = ?)`)
        .bind(outcome.kind, id, turnId, userId, token, id)
        .run()
    );
    return saved.meta.changes === 1;
  });

const retainWhatsAppStatus = ({
  db,
  evidence,
  receivedAtMs,
}: Readonly<{
  db: D1Database;
  evidence: AuthenticatedHostedStatus;
  receivedAtMs: number;
}>): Effect.Effect<void, Cause.UnknownError> => {
  const token = evidence.correlationToken;
  const id = evidence.messageEvidence.providerMessageId;
  const phoneId = evidence.businessPhoneNumberId;
  const status = evidence.outcome;
  return Effect.tryPromise(() =>
    db.batch([
      db
        .prepare(`INSERT OR IGNORE INTO hosted_whatsapp_delivery_events
      (correlation_token, provider_message_id, status, occurred_at_ms, received_at_ms)
      VALUES (?, ?, ?, ?, ?)`)
        .bind(token, id, status, DateTime.toEpochMillis(evidence.occurredAt), receivedAtMs),
      db
        .prepare(`UPDATE hosted_whatsapp_delivery SET provider_message_id = ?,
      state = CASE WHEN ? = 'delivered' AND ? <= proposed_at_ms + ? THEN 'delivered'
        WHEN ? = 'failed' THEN 'rejected' ELSE state END,
      delivered_at_ms = CASE WHEN ? = 'delivered' AND ? <= proposed_at_ms + ?
        THEN ? ELSE delivered_at_ms END
      WHERE correlation_token = ? AND business_phone_number_id = ?
        AND state IN ('sending','accepted','ambiguous') AND send_started_at_ms IS NOT NULL
        AND (provider_message_id IS NULL OR provider_message_id = ?)`)
        .bind(
          id,
          status,
          receivedAtMs,
          deliveryAcknowledgmentWindowMs,
          status,
          status,
          receivedAtMs,
          deliveryAcknowledgmentWindowMs,
          receivedAtMs,
          token,
          phoneId,
          id
        ),
    ])
  ).pipe(Effect.asVoid);
};

/** Only a previously authenticated Kapso projection may enter this module. Signed statuses are
 * retained as immutable metadata even when a late event cannot change a terminal Turn. */
export const recordWhatsAppStatus = ({
  db,
  evidence,
  receivedAtMs,
}: Readonly<{
  db: D1Database;
  evidence: AuthenticatedHostedStatus;
  receivedAtMs: number;
}>): Effect.Effect<
  Option.Option<WhatsAppDeliveryProposal>,
  Cause.UnknownError | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const token = evidence.correlationToken;
    const id = evidence.messageEvidence.providerMessageId;
    const phoneId = evidence.businessPhoneNumberId;
    const existing = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT turn_id, user_id, text, state, provider_message_id
        FROM hosted_whatsapp_delivery WHERE correlation_token = ? AND business_phone_number_id = ?
          AND (provider_message_id IS NULL OR provider_message_id = ?)`)
        .bind(token, phoneId, id)
        .first()
    );
    if (existing === null) return Option.none();
    yield* retainWhatsAppStatus({ db, evidence, receivedAtMs });
    const updated = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT turn_id, user_id, text, state, provider_message_id
        FROM hosted_whatsapp_delivery WHERE correlation_token = ? AND business_phone_number_id = ?
          AND (provider_message_id IS NULL OR provider_message_id = ?)`)
        .bind(token, phoneId, id)
        .first()
    );
    return Schema.decodeUnknownOption(Proposal)(updated);
  });

/** Reconcile the signed status through the User coordinator; only delivered proof promotes text. */
export const reconcileWhatsAppStatus = ({
  db,
  admission,
}: Readonly<{
  db: D1Database;
  admission: WhatsAppStatusAdmission;
}>): Effect.Effect<boolean, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const matched = yield* recordWhatsAppStatus({
      db,
      evidence: {
        correlationToken: admission.correlationToken,
        businessPhoneNumberId: admission.businessPhoneNumberId,
        messageEvidence: {
          channel: "whatsapp",
          provider: "kapso",
          providerMessageId: admission.providerMessageId,
        },
        occurredAt: DateTime.makeUnsafe(admission.occurredAtMs),
        outcome: admission.outcome,
      },
      receivedAtMs: admission.receivedAtMs,
    });
    if (Option.isNone(matched) || matched.value.user_id !== admission.userId) return false;
    if (!["delivered", "rejected"].includes(matched.value.state)) return true;
    const raw = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT t.started_at_ms, i.portfolio_id, i.bsuid
        FROM hosted_turns AS t JOIN hosted_whatsapp_inbound AS i ON i.turn_id = t.id
        WHERE t.id = ? AND t.user_id = ?`)
        .bind(matched.value.turn_id, admission.userId)
        .first()
    );
    const original = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        started_at_ms: Schema.Int,
        portfolio_id: WhatsAppHostedSubject.fields.portfolioId,
        bsuid: WhatsAppHostedSubject.fields.bsuid,
      })
    )(raw);
    yield* finishHostedTurn({
      db,
      userId: admission.userId,
      turnId: matched.value.turn_id,
      startedAtMs: original.started_at_ms,
      result:
        matched.value.state === "delivered"
          ? { _tag: "Completed", text: TranscriptText.make(matched.value.text) }
          : { _tag: "Failed", reason: "DeliveryFailed" },
      subject: WhatsAppHostedSubject.make({
        userId: admission.userId,
        portfolioId: original.portfolio_id,
        bsuid: original.bsuid,
      }),
      now: admission.receivedAtMs,
    });
    return true;
  });
