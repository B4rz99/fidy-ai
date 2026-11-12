import { TranscriptText, TranscriptTurnId } from "../../../src/core/agent/contract";
import { E164PhoneNumber, UserId } from "../../../src/core/identity/contract";
import { type Cause, Clock, DateTime, Effect, Option, Schema } from "effect";
import {
  HostedDeliveryCorrelationToken,
  type WhatsAppHostedLifecycleEvidence,
  WhatsAppProviderMessageId,
} from "../../../src/shell/channels/whatsapp/contract";
import { isWhatsAppWindowOpen } from "./whatsapp-turn";
import { deliveryAcknowledgmentWindowMs } from "../../agent/contract";
import { hostedChannelTurnQuery, prepareHostedChannelTurn } from "../../agent/operations";
import { prepareWhatsAppIdentity } from "../../identity/operations";
import { newId } from "../../secret-material/operations";
import {
  type WhatsAppDeliveryProposal,
  type WhatsAppHostedRecipient,
  WhatsAppHostedSubject,
  WhatsAppInboundEvidence,
  type WhatsAppStatusAdmission,
  type WhatsAppStatusReconciliation,
  type WhatsAppUnavailable,
  whatsAppServiceWindowMilliseconds,
} from "../contract";

const Proposal = Schema.Struct({
  turn_id: TranscriptTurnId,
  user_id: UserId,
  text: TranscriptText,
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

type AuthenticatedHostedStatus = Pick<
  WhatsAppHostedLifecycleEvidence,
  | "correlationToken"
  | "messageEvidence"
  | "businessPhoneNumberId"
  | "occurredAt"
  | "recipientUserId"
  | "recipientPhone"
> &
  Readonly<{ outcome: "sent" | "delivered" | "failed" }>;

const hostedRecipientGuard = `AND EXISTS (SELECT 1 FROM hosted_turns AS recipient
  WHERE recipient.id = hosted_whatsapp_delivery.turn_id AND recipient.user_id = hosted_whatsapp_delivery.user_id
    AND ((recipient.inbound_sandbox_phone IS NULL AND recipient.inbound_bsuid = ?)
      OR (recipient.inbound_sandbox_phone IS NOT NULL AND recipient.inbound_sandbox_phone = ?))
    AND (? IS NULL OR recipient.inbound_bsuid = ?))`;

const recipientParams = (evidence: AuthenticatedHostedStatus): ReadonlyArray<unknown> => [
  Option.getOrNull(evidence.recipientUserId),
  Option.getOrNull(evidence.recipientPhone),
  Option.getOrNull(evidence.recipientUserId),
  Option.getOrNull(evidence.recipientUserId),
];

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
      prepareHostedChannelTurn({
        db,
        userId,
        statement: {
          sql: `INSERT INTO whatsapp_deliveries AS hosted_whatsapp_delivery(kind,turn_id, user_id, text, correlation_token, business_phone_number_id, proposed_at_ms, state) SELECT 'hosted', t.id, t.user_id, ?, ?, i.business_phone_number_id, ?, 'sending'
        FROM channel_turns AS t JOIN (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL) AS i
          ON i.turn_id = t.id AND i.user_id = t.user_id
        WHERE t.id = ? AND t.user_id = ? AND t.status = 'pending'`,
          params: [text, token, now, turnId, userId],
        },
      }).run()
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
    const turns = hostedChannelTurnQuery(userId);
    const saved = yield* Effect.tryPromise(() =>
      prepareWhatsAppIdentity({
        db,
        userId,
        statement: {
          sql: `UPDATE whatsapp_deliveries AS hosted_whatsapp_delivery
      SET send_started_at_ms = ?
      WHERE kind='hosted' AND turn_id = ? AND user_id = ? AND correlation_token = ?
        AND state = 'sending' AND send_started_at_ms IS NULL
        AND proposed_at_ms + ? > ?
        AND EXISTS (SELECT 1 FROM (${turns.sql}) AS t
          WHERE t.id = hosted_whatsapp_delivery.turn_id AND t.user_id = ? AND t.status = 'pending')
        AND EXISTS (SELECT 1 FROM (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL) AS i
          JOIN whatsapp_service_windows AS w ON w.user_id = i.user_id
            AND w.portfolio_id = i.portfolio_id AND w.bsuid = i.bsuid
          JOIN identity_associations AS identity ON identity.userId = i.user_id
            AND identity.businessPortfolioId = i.portfolio_id AND identity.businessScopedUserId = i.bsuid
          WHERE i.turn_id = hosted_whatsapp_delivery.turn_id AND i.user_id = ?
            AND i.business_phone_number_id = hosted_whatsapp_delivery.business_phone_number_id
            AND NOT EXISTS (SELECT 1 FROM whatsapp_recipients AS recipient
              WHERE recipient.user_id = i.user_id AND
                (recipient.portfolio_id <> i.portfolio_id OR recipient.bsuid <> i.bsuid
                  OR recipient.business_phone_number_id <> i.business_phone_number_id))
            AND w.last_verified_inbound_at_ms > ?)`,
          params: [
            now,
            turnId,
            userId,
            token,
            deliveryAcknowledgmentWindowMs,
            now,
            ...turns.params,
            userId,
            userId,
            now - whatsAppServiceWindowMilliseconds,
          ],
        },
      }).run()
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
      prepareHostedChannelTurn({
        db,
        userId,
        statement: {
          sql: `UPDATE whatsapp_deliveries AS hosted_whatsapp_delivery
      SET state = 'rejected' WHERE kind='hosted' AND turn_id = ? AND user_id = ? AND correlation_token = ?
        AND state = 'sending' AND send_started_at_ms IS NULL
        AND EXISTS (SELECT 1 FROM channel_turns AS t
          WHERE t.id = hosted_whatsapp_delivery.turn_id AND t.user_id = ? AND t.status = 'pending')`,
          params: [turnId, userId, token, userId],
        },
      }).run()
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
        .prepare(`UPDATE whatsapp_deliveries AS hosted_whatsapp_delivery
        SET state = ?, provider_message_id = COALESCE(provider_message_id, ?)
        WHERE kind='hosted' AND turn_id = ? AND user_id = ? AND correlation_token = ? AND state = 'sending'
          AND send_started_at_ms IS NOT NULL
          AND (provider_message_id IS NULL OR provider_message_id = ?)`)
        .bind(outcome.kind, id, turnId, userId, token, id)
        .run()
    );
    return saved.meta.changes === 1;
  });

const prepareStatusEvidence = ({
  db,
  userId,
  evidence,
  receivedAtMs,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  evidence: AuthenticatedHostedStatus;
  receivedAtMs: number;
}>): D1PreparedStatement => {
  const token = evidence.correlationToken;
  const id = evidence.messageEvidence.providerMessageId;
  const phoneId = evidence.businessPhoneNumberId;
  const status = evidence.outcome;
  return db
    .prepare(`INSERT OR IGNORE INTO whatsapp_event_records
      (kind,correlation_token,provider_message_id,status,occurred_at_ms,received_at_ms)
      SELECT 'delivery-status',?,?,?,?,? WHERE EXISTS (SELECT 1 FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') AS hosted_whatsapp_delivery
        WHERE user_id = ? AND correlation_token = ? AND business_phone_number_id = ?
          AND (provider_message_id IS NULL OR provider_message_id = ?) ${hostedRecipientGuard})`)
    .bind(
      token,
      id,
      status,
      DateTime.toEpochMillis(evidence.occurredAt),
      receivedAtMs,
      userId,
      token,
      phoneId,
      id,
      ...recipientParams(evidence)
    );
};

const retainWhatsAppStatus = ({
  db,
  userId,
  evidence,
  receivedAtMs,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  evidence: AuthenticatedHostedStatus;
  receivedAtMs: number;
}>): Effect.Effect<void, Cause.UnknownError> => {
  const token = evidence.correlationToken;
  const id = evidence.messageEvidence.providerMessageId;
  const phoneId = evidence.businessPhoneNumberId;
  const status = evidence.outcome;
  return Effect.tryPromise(() =>
    db.batch([
      prepareStatusEvidence({ db, userId, evidence, receivedAtMs }),
      db
        .prepare(`UPDATE whatsapp_deliveries AS hosted_whatsapp_delivery SET provider_message_id = ?,
      state = CASE WHEN ? = 'delivered' AND ? <= proposed_at_ms + ? THEN 'delivered'
        WHEN ? = 'failed' THEN 'rejected' ELSE state END,
      delivered_at_ms = CASE WHEN ? = 'delivered' AND ? <= proposed_at_ms + ?
        THEN ? ELSE delivered_at_ms END
      WHERE kind='hosted' AND user_id = ? AND correlation_token = ? AND business_phone_number_id = ?
        AND state IN ('sending','accepted','ambiguous') AND send_started_at_ms IS NOT NULL
        AND (provider_message_id IS NULL OR provider_message_id = ?) ${hostedRecipientGuard}`)
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
          userId,
          token,
          phoneId,
          id,
          ...recipientParams(evidence)
        ),
    ])
  ).pipe(Effect.asVoid);
};

/** Only a previously authenticated Kapso projection may enter this module. Signed statuses are
 * retained as immutable metadata even when a late event cannot change a terminal Turn. */
export const recordWhatsAppStatus = ({
  db,
  userId,
  evidence,
  receivedAtMs,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  evidence: AuthenticatedHostedStatus;
  receivedAtMs: number;
}>): Effect.Effect<
  Option.Option<WhatsAppDeliveryProposal>,
  Cause.UnknownError | Schema.SchemaError | WhatsAppUnavailable
> =>
  Effect.gen(function* () {
    const token = evidence.correlationToken;
    const id = evidence.messageEvidence.providerMessageId;
    const phoneId = evidence.businessPhoneNumberId;
    const existing = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT turn_id, user_id, text, state, provider_message_id
        FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') AS hosted_whatsapp_delivery WHERE user_id = ? AND correlation_token = ? AND business_phone_number_id = ?
          AND (provider_message_id IS NULL OR provider_message_id = ?) ${hostedRecipientGuard}`)
        .bind(userId, token, phoneId, id, ...recipientParams(evidence))
        .first()
    );
    if (existing === null) return Option.none();
    yield* Schema.decodeUnknownEffect(Proposal)(existing);
    yield* retainWhatsAppStatus({ db, userId, evidence, receivedAtMs });
    const updated = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT turn_id, user_id, text, state, provider_message_id
        FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') AS hosted_whatsapp_delivery WHERE user_id = ? AND correlation_token = ? AND business_phone_number_id = ?
          AND (provider_message_id IS NULL OR provider_message_id = ?) ${hostedRecipientGuard}`)
        .bind(userId, token, phoneId, id, ...recipientParams(evidence))
        .first()
    );
    if (updated === null) return Option.none();
    const row = yield* Schema.decodeUnknownEffect(Proposal)(updated);
    return Option.some({
      turnId: row.turn_id,
      userId: row.user_id,
      text: row.text,
      state: row.state,
      providerMessageId: Option.fromNullishOr(row.provider_message_id),
    });
  });

const admittedStatusEvidence = (admission: WhatsAppStatusAdmission): AuthenticatedHostedStatus => ({
  recipientUserId: Option.fromUndefinedOr(admission.recipientUserId),
  recipientPhone: Option.fromUndefinedOr(admission.recipientPhone),
  correlationToken: admission.correlationToken,
  businessPhoneNumberId: admission.businessPhoneNumberId,
  messageEvidence: {
    channel: "whatsapp",
    provider: "kapso",
    providerMessageId: admission.providerMessageId,
  },
  occurredAt: DateTime.makeUnsafe(admission.occurredAtMs),
  outcome: admission.outcome,
});

/** Reconcile the signed status through the User coordinator; only delivered proof promotes text. */
export const reconcileWhatsAppStatus = ({
  db,
  admission,
}: Readonly<{
  db: D1Database;
  admission: WhatsAppStatusAdmission;
}>): Effect.Effect<
  WhatsAppStatusReconciliation,
  Cause.UnknownError | Schema.SchemaError | WhatsAppUnavailable
> =>
  Effect.gen(function* () {
    const matched = yield* recordWhatsAppStatus({
      db,
      userId: admission.userId,
      evidence: admittedStatusEvidence(admission),
      receivedAtMs: admission.receivedAtMs,
    });
    if (Option.isNone(matched) || matched.value.userId !== admission.userId) {
      return { _tag: "Refused" };
    }
    if (!["delivered", "rejected"].includes(matched.value.state)) return { _tag: "Recorded" };
    const raw = yield* Effect.tryPromise(() =>
      prepareHostedChannelTurn({
        db,
        userId: admission.userId,
        statement: {
          sql: `SELECT t.started_at_ms, i.portfolio_id, i.bsuid
        FROM channel_turns AS t JOIN (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL) AS i ON i.turn_id = t.id
        WHERE t.id = ? AND t.user_id = ?`,
          params: [matched.value.turnId, admission.userId],
        },
      }).first()
    );
    const original = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        started_at_ms: Schema.Int,
        portfolio_id: WhatsAppHostedSubject.fields.portfolioId,
        bsuid: WhatsAppHostedSubject.fields.bsuid,
      })
    )(raw);
    return {
      _tag: "TerminalEvidence",
      completion: {
        userId: admission.userId,
        turnId: matched.value.turnId,
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
      },
    };
  });

const findHostedRecipient = ({
  db,
  userId,
  turnId,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  turnId: TranscriptTurnId;
}>): Effect.Effect<
  Option.Option<WhatsAppHostedRecipient>,
  Cause.UnknownError | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const turns = hostedChannelTurnQuery(userId);
    const rawRecipient = yield* Effect.tryPromise(() =>
      prepareWhatsAppIdentity({
        db,
        userId,
        statement: {
          sql: `SELECT t.inbound_portfolio_id AS portfolioId, t.inbound_bsuid AS bsuid,
        t.inbound_business_phone_number_id AS businessPhoneNumberId,
        t.inbound_sandbox_phone AS sandboxPhone, t.inbound_reply_to_message_id AS replyToMessageId
        FROM hosted_turns AS t JOIN (${turns.sql}) AS turn
          ON turn.id = t.id AND turn.user_id = t.user_id
        JOIN identity_associations AS identity ON identity.userId = t.user_id
          AND identity.businessPortfolioId = t.inbound_portfolio_id
          AND identity.businessScopedUserId = t.inbound_bsuid
        WHERE t.id = ? AND t.user_id = ? AND turn.status = 'pending' AND t.inbound_message_id IS NOT NULL`,
          params: [...turns.params, turnId, userId],
        },
      }).first()
    );
    if (rawRecipient === null) return Option.none();
    return Option.some(
      yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          portfolioId: WhatsAppHostedSubject.fields.portfolioId,
          bsuid: WhatsAppHostedSubject.fields.bsuid,
          businessPhoneNumberId: WhatsAppInboundEvidence.fields.businessPhoneNumberId,
          sandboxPhone: Schema.OptionFromNullOr(E164PhoneNumber),
          replyToMessageId: Schema.OptionFromNullOr(WhatsAppProviderMessageId),
        })
      )(rawRecipient)
    );
  });

type HostedReplySender<E> = (
  input: Readonly<{
    text: TranscriptText;
    turnId: TranscriptTurnId;
    correlationToken: HostedDeliveryCorrelationToken;
    recipient: WhatsAppHostedRecipient;
  }>
) => Effect.Effect<
  | Readonly<{ kind: "accepted"; messageId: WhatsAppProviderMessageId }>
  | Readonly<{ kind: "ambiguous" | "rejected" }>,
  E
>;

/** Own the complete hosted provider boundary; Agent still owns terminal Turn settlement. */
export const submitHostedReply = <E>({
  db,
  userId,
  turnId,
  text,
  send,
  scheduleRecovery,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  turnId: TranscriptTurnId;
  text: TranscriptText;
  send: HostedReplySender<E>;
  scheduleRecovery: (dueAtMs: number) => Promise<void>;
}>): Effect.Effect<
  Readonly<{ _tag: "Refused" | "NotSubmitted" | "AwaitingDelivery" }>,
  Cause.UnknownError | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const recipient = yield* findHostedRecipient({ db, userId, turnId });
    if (Option.isNone(recipient)) return { _tag: "Refused" as const };
    const proposedAt = yield* Clock.currentTimeMillis;
    if (!(yield* isWhatsAppWindowOpen({ db, userId, turnId, now: proposedAt }))) {
      return { _tag: "Refused" as const };
    }
    const token = yield* stageWhatsAppDelivery({ db, userId, turnId, text, now: proposedAt });
    if (Option.isNone(token)) return { _tag: "NotSubmitted" as const };
    yield* Effect.tryPromise(() => scheduleRecovery(proposedAt + deliveryAcknowledgmentWindowMs));
    const started = yield* startWhatsAppSend({
      db,
      userId,
      turnId,
      token: token.value,
      now: yield* Clock.currentTimeMillis,
    });
    if (!started) {
      yield* rejectUnstartedWhatsAppDelivery({ db, userId, turnId, token: token.value });
      return { _tag: "Refused" as const };
    }
    const outcome = yield* send({
      text,
      turnId,
      correlationToken: token.value,
      recipient: recipient.value,
    }).pipe(Effect.orElseSucceed(() => ({ kind: "ambiguous" as const })));
    const recorded = yield* recordWhatsAppSend({ db, userId, turnId, token: token.value, outcome });
    return outcome.kind === "rejected" && recorded
      ? { _tag: "Refused" as const }
      : { _tag: "AwaitingDelivery" as const };
  });
