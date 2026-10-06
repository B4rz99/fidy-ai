import { type Cause, DateTime, Duration, Effect, Option, Schema } from "effect";
import { IanaTimeZone } from "../../../src/core/_shared/context";
import { TranscriptText } from "../../../src/core/agent/contract";
import { InsightEventId } from "../../../src/core/insights/contract";
import { UserId } from "../../../src/core/identity/contract";
import { decideInsightDelivery } from "../../../src/core/insights/operations";
import {
  HostedDeliveryCorrelationToken,
  InsightTemplateSummary,
  type InsightTemplateUnavailable,
  WhatsAppProviderMessageId,
  maxWhatsAppFutureTimestampMinutes,
} from "../../../src/shell/channels/whatsapp/contract";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { type OwnedStatement } from "../../../src/shell/owner-write/contract";
import { prepareConsentAction, prepareWeeklyConsentAction } from "../../consent/operations";
import { whatsAppIdentityQuery } from "../../identity/operations";
import { hostedTranscriptRetentionMs } from "../../agent/contract";
import { newId } from "../../secret-material/operations";
import {
  InsightRecipient,
  type InsightVerifiedDeliveryEvidence,
  type InsightWhatsAppClaim,
  type InsightWhatsAppReconciliation,
  type InsightWhatsAppSendResult,
  type InsightWhatsAppStage,
  type InsightWhatsAppStart,
  type WhatsAppStatusAdmission,
  type WhatsAppTurnAdmission,
} from "../contract";

const Claim = Schema.Struct({
  user_id: UserId,
  insight_event_id: InsightEventId,
  correlation_token: HostedDeliveryCorrelationToken,
  portfolio_id: InsightRecipient.fields.portfolioId,
  bsuid: InsightRecipient.fields.bsuid,
  business_phone_number_id: InsightRecipient.fields.businessPhoneNumberId,
  summary_json: Schema.NullOr(Schema.fromJsonString(InsightTemplateSummary)),
  text: Schema.NullOr(TranscriptText),
  scheduled_at_ms: Schema.Int,
  expires_at_ms: Schema.Int,
  time_zone: IanaTimeZone,
  state: Schema.Literals([
    "staged",
    "sending",
    "accepted",
    "ambiguous",
    "rejected",
    "delivered",
    "expired",
  ]),
});
const providerTimestampPrecisionMs = 1000;
const maximumFutureClockDriftMs = Duration.toMillis(
  Duration.minutes(maxWhatsAppFutureTimestampMinutes)
);
type InsightDeliveryFailure = Cause.UnknownError | Schema.SchemaError | InsightTemplateUnavailable;

/** Prepare authenticated routing in the caller's atomic inbound/decision unit, under its exact current association. */
export const prepareInsightRecipient = (
  input: Readonly<{
    db: D1Database;
    userId: UserId;
    recipient: InsightRecipient;
    receivedAtMs: number;
  }>
): D1PreparedStatement => {
  const association = whatsAppIdentityQuery({ ...input.recipient, userId: input.userId });
  // UPDATE and INSERT are deliberately one UPSERT; the association is rechecked before mutation.
  // Consent's generic action helper appends a predicate, so qualify this SELECT directly with its published query instead.
  return input.db
    .prepare(`INSERT INTO insight_whatsapp_routes(user_id,portfolio_id,bsuid,business_phone_number_id,verified_at_ms)
 SELECT ?,?,?,?,? WHERE EXISTS (${association.sql})
 ON CONFLICT(user_id) DO UPDATE SET portfolio_id=excluded.portfolio_id,bsuid=excluded.bsuid,
 business_phone_number_id=excluded.business_phone_number_id,verified_at_ms=excluded.verified_at_ms
 WHERE excluded.verified_at_ms >= insight_whatsapp_routes.verified_at_ms`)
    .bind(
      input.userId,
      input.recipient.portfolioId,
      input.recipient.bsuid,
      input.recipient.businessPhoneNumberId,
      input.receivedAtMs,
      ...association.params
    );
};
export const findInsightRecipient = (
  input: Readonly<{ db: D1Database; userId: UserId }>
): Effect.Effect<Option.Option<InsightRecipient>, InsightDeliveryFailure> =>
  Effect.gen(function* () {
    const row = yield* Effect.tryPromise(() =>
      prepareConsentAction({
        ...input,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement: {
          sql: "SELECT portfolio_id AS portfolioId,bsuid,business_phone_number_id AS businessPhoneNumberId FROM insight_whatsapp_routes WHERE user_id = ?",
          params: [input.userId],
        },
      }).first()
    );
    return row === null
      ? Option.none()
      : Option.some(yield* Schema.decodeUnknownEffect(InsightRecipient)(row));
  });
/** Freeze the exact complete prepared body before claiming any provider call. */
export const stageInsightDelivery = (
  input: InsightWhatsAppStage
): Effect.Effect<boolean, InsightDeliveryFailure> =>
  Effect.gen(function* () {
    const prepared = yield* input.sender.prepare(input.summary);
    const summary = yield* Schema.decodeUnknownEffect(InsightTemplateSummary)(input.summary);
    const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(InsightTemplateSummary))(
      summary
    );
    const existing = yield* Effect.tryPromise(() =>
      input.db
        .prepare("SELECT 1 FROM insight_whatsapp_claims WHERE user_id=? AND insight_event_id=?")
        .bind(input.userId, input.insightEventId)
        .first()
    );
    if (existing !== null) {
      return false;
    }
    const association = whatsAppIdentityQuery({ ...input.recipient, userId: input.userId });
    const result = yield* Effect.tryPromise(() =>
      prepareWeeklyConsentAction({
        db: input.db,
        userId: input.userId,
        grantId: input.grantId,
        statement: {
          sql: `INSERT INTO insight_whatsapp_claims(user_id,insight_event_id,correlation_token,portfolio_id,bsuid,business_phone_number_id,summary_json,text,scheduled_at_ms,expires_at_ms,time_zone,state)
 SELECT ?,?,?,?,?,?,?,?,?,?,?,'staged' WHERE EXISTS (${input.guard.sql}) AND EXISTS (${association.sql})`,
          params: [
            input.userId,
            input.insightEventId,
            HostedDeliveryCorrelationToken.make(newId()),
            input.recipient.portfolioId,
            input.recipient.bsuid,
            input.recipient.businessPhoneNumberId,
            serialized,
            prepared.text,
            DateTime.toEpochMillis(input.scheduledAt),
            DateTime.toEpochMillis(input.expiresAt),
            input.timeZone,
            ...input.guard.params,
            ...association.params,
          ],
        },
      }).run()
    );
    return result.meta.changes === 1;
  });
const claimSend = (
  input: InsightWhatsAppStart,
  row: typeof Claim.Type
): Effect.Effect<boolean, Cause.UnknownError> => {
  const association = whatsAppIdentityQuery({
    userId: input.userId,
    portfolioId: row.portfolio_id,
    bsuid: row.bsuid,
  });
  return Effect.tryPromise(() =>
    prepareWeeklyConsentAction({
      db: input.db,
      userId: input.userId,
      grantId: input.grantId,
      statement: {
        sql: `UPDATE insight_whatsapp_claims SET state='sending',send_started_at_ms=? WHERE user_id=? AND insight_event_id=? AND state='staged' AND correlation_token=? AND EXISTS (${input.guard.sql}) AND EXISTS (${association.sql})`,
        params: [
          DateTime.toEpochMillis(input.now),
          input.userId,
          input.insightEventId,
          row.correlation_token,
          ...input.guard.params,
          ...association.params,
        ],
      },
    }).run()
  ).pipe(Effect.map((result) => result.meta.changes === 1));
};

/** No blind retry: a started, accepted or ambiguous claim can only be reconciled. */
export const startInsightSend = (
  input: InsightWhatsAppStart
): Effect.Effect<InsightWhatsAppClaim, InsightDeliveryFailure> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      prepareWeeklyConsentAction({
        db: input.db,
        userId: input.userId,
        grantId: input.grantId,
        statement: {
          sql: `SELECT * FROM insight_whatsapp_claims WHERE user_id=? AND insight_event_id=? AND state='staged' AND EXISTS (${input.guard.sql})`,
          params: [input.userId, input.insightEventId, ...input.guard.params],
        },
      }).first()
    );
    if (raw === null) {
      return { _tag: "NotClaimed" };
    }
    const row = yield* Schema.decodeUnknownEffect(Claim)(raw);
    const decision = decideInsightDelivery({
      now: input.now,
      scheduledAt: DateTime.makeUnsafe(row.scheduled_at_ms),
      expiresAt: DateTime.makeUnsafe(row.expires_at_ms),
      timeZone: row.time_zone,
    });
    if (decision._tag === "Expired") {
      yield* Effect.tryPromise(() =>
        input.db
          .prepare(
            "UPDATE insight_whatsapp_claims SET state='expired',text=NULL,summary_json=NULL WHERE user_id=? AND insight_event_id=? AND state='staged'"
          )
          .bind(input.userId, input.insightEventId)
          .run()
      );
      return { _tag: "Expired" };
    }
    if (decision._tag === "Deferred") {
      return decision;
    }
    if (row.summary_json === null || row.text === null) {
      return { _tag: "NotClaimed" };
    }
    if (!(yield* claimSend(input, row))) {
      return { _tag: "NotClaimed" };
    }
    return {
      _tag: "Ready",
      correlationToken: row.correlation_token,
      request: {
        recipient: row.bsuid,
        businessPhoneNumberId: row.business_phone_number_id,
        correlationToken: row.correlation_token,
        summary: row.summary_json,
      },
    };
  });
export const recordInsightSend = (
  input: InsightWhatsAppSendResult
): Effect.Effect<void, InsightDeliveryFailure> =>
  Effect.gen(function* () {
    const providerId = input.outcome.kind === "accepted" ? input.outcome.providerMessageId : null;
    yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          `UPDATE insight_whatsapp_claims SET state=?,provider_message_id=coalesce(provider_message_id,?) WHERE user_id=? AND insight_event_id=? AND correlation_token=? AND state='sending' AND (provider_message_id IS NULL OR provider_message_id IS ?)`
        )
        .bind(
          input.outcome.kind,
          providerId,
          input.userId,
          input.insightEventId,
          input.correlationToken,
          providerId
        )
        .run()
    );
  });
/** The ingress must authenticate raw provider bytes before this private coordinator admission. */
export const reconcileInsightStatus = (
  input: Readonly<{ db: D1Database; admission: WhatsAppStatusAdmission }>
): Effect.Effect<InsightWhatsAppReconciliation, InsightDeliveryFailure> =>
  Effect.gen(function* () {
    const status = input.admission;
    const result = yield* Effect.tryPromise(() =>
      input.db
        .prepare(`UPDATE insight_whatsapp_claims SET
 state=CASE WHEN ?='delivered' THEN 'delivered' WHEN state IN ('delivered','rejected') THEN state WHEN ?='failed' THEN 'rejected' ELSE 'accepted' END,
 provider_message_id=coalesce(provider_message_id,?),delivered_at_ms=CASE WHEN ?='delivered' THEN coalesce(delivered_at_ms,?) ELSE delivered_at_ms END,last_received_at_ms=max(coalesce(last_received_at_ms,?),?)
 WHERE user_id=? AND correlation_token=? AND business_phone_number_id=? AND send_started_at_ms IS NOT NULL
 AND (provider_message_id IS NULL OR provider_message_id=?) AND ? + ? >= send_started_at_ms AND ? <= ?
 AND state NOT IN ('staged','expired') RETURNING insight_event_id,state`)
        .bind(
          status.outcome,
          status.outcome,
          status.providerMessageId,
          status.outcome,
          status.occurredAtMs,
          status.receivedAtMs,
          status.receivedAtMs,
          status.userId,
          status.correlationToken,
          status.businessPhoneNumberId,
          status.providerMessageId,
          status.occurredAtMs,
          providerTimestampPrecisionMs,
          status.occurredAtMs,
          status.receivedAtMs + maximumFutureClockDriftMs
        )
        .first()
    );
    if (result === null) {
      return { _tag: "Refused" };
    }
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ insight_event_id: InsightEventId, state: Schema.String })
    )(result);
    return row.state === "delivered"
      ? { _tag: "VerifiedDelivery", userId: status.userId, insightEventId: row.insight_event_id }
      : { _tag: "Recorded" };
  });
/** Metadata-only correlation lookup cannot establish financial or User authority. */
export const findInsightDeliveryUser = (
  input: Readonly<{
    db: D1Database;
    correlationToken: HostedDeliveryCorrelationToken;
    businessPhoneNumberId: InsightRecipient["businessPhoneNumberId"];
  }>
): Effect.Effect<Option.Option<UserId>, InsightDeliveryFailure> =>
  Effect.gen(function* () {
    const row = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          "SELECT user_id FROM insight_whatsapp_claims WHERE correlation_token=? AND business_phone_number_id=? AND send_started_at_ms IS NOT NULL"
        )
        .bind(input.correlationToken, input.businessPhoneNumberId)
        .first()
    );
    return row === null
      ? Option.none()
      : Option.some(
          (yield* Schema.decodeUnknownEffect(Schema.Struct({ user_id: UserId }))(row)).user_id
        );
  });
/** Metadata remains reconcilable after expiry/revocation; exact visible text requires current processing Consent. */
export const readInsightDeliveryEvidence = (
  input: Readonly<{ db: D1Database; userId: UserId; insightEventId: InsightEventId; now: number }>
): Effect.Effect<Option.Option<InsightVerifiedDeliveryEvidence>, InsightDeliveryFailure> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          "SELECT insight_event_id,provider_message_id,send_started_at_ms,delivered_at_ms FROM insight_whatsapp_claims WHERE user_id=? AND insight_event_id=? AND state='delivered'"
        )
        .bind(input.userId, input.insightEventId)
        .first()
    );
    if (raw === null) {
      return Option.none();
    }
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        insight_event_id: InsightEventId,
        provider_message_id: WhatsAppProviderMessageId,
        send_started_at_ms: Schema.Int,
        delivered_at_ms: Schema.Int,
      })
    )(raw);
    const textRaw = yield* Effect.tryPromise(() =>
      prepareConsentAction({
        db: input.db,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement: {
          sql: "SELECT text FROM insight_whatsapp_claims WHERE user_id=? AND insight_event_id=? AND state='delivered' AND send_started_at_ms + ? > ?",
          params: [input.userId, input.insightEventId, hostedTranscriptRetentionMs, input.now],
        },
      }).first()
    );
    const text =
      textRaw === null
        ? Option.none<TranscriptText>()
        : (yield* Schema.decodeUnknownEffect(
            Schema.Struct({ text: Schema.OptionFromNullOr(TranscriptText) })
          )(textRaw)).text;
    return Option.some({
      insightEventId: row.insight_event_id,
      providerMessageId: row.provider_message_id,
      sentAt: DateTime.makeUnsafe(row.send_started_at_ms),
      deliveredAt: DateTime.makeUnsafe(row.delivered_at_ms),
      text,
    });
  });
/** Delete only exact channel content at its fixed boundary; retain one-shot correlation tombstones, not a resend path. */
export const expireInsightChannelEvidence = (
  input: Readonly<{ db: D1Database; userId: UserId; now: number }>
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    input.db
      .prepare(
        "UPDATE insight_whatsapp_claims SET text=NULL,summary_json=NULL WHERE user_id=? AND ((send_started_at_ms IS NOT NULL AND send_started_at_ms + ? <= ?) OR (state='staged' AND expires_at_ms <= ?))"
      )
      .bind(input.userId, hostedTranscriptRetentionMs, input.now, input.now)
      .run()
  ).pipe(Effect.asVoid);

/** Bounded independent retention, including Users with no Hosted Agent Session. */
export const sweepInsightChannelEvidence = (
  input: Readonly<{ db: D1Database; now: number }>
): Effect.Effect<void, InsightDeliveryFailure> =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          "SELECT DISTINCT user_id FROM insight_whatsapp_claims WHERE (text IS NOT NULL OR summary_json IS NOT NULL) AND ((send_started_at_ms IS NOT NULL AND send_started_at_ms+2592000000<=?) OR (state='staged' AND expires_at_ms<=?)) LIMIT 64"
        )
        .bind(input.now, input.now)
        .all()
    );
    const users = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ user_id: UserId }))
    )(rows.results);
    for (const user of users) {
      yield* expireInsightChannelEvidence({ ...input, userId: user.user_id });
    }
  });

/** Identity-bound attention metadata, independent of model and processing availability; no report content is released. */
export const weeklySummaryReplyQuery = (proof: WhatsAppTurnAdmission): OwnedStatement => {
  const association = whatsAppIdentityQuery({
    userId: proof.userId,
    portfolioId: proof.portfolioId,
    bsuid: proof.bsuid,
  });
  const statement: OwnedStatement = {
    sql: `SELECT d.user_id,d.insight_event_id,NULL AS question_id,? AS occurred_at_ms,d.delivered_at_ms FROM insight_whatsapp_claims AS d WHERE d.user_id=? AND d.portfolio_id=? AND d.bsuid=? AND d.provider_message_id=? AND d.state='delivered' UNION ALL SELECT d.user_id,NULL,d.id,?,d.delivered_at_ms FROM weekly_governor_questions AS d WHERE d.user_id=? AND d.portfolio_id=? AND d.bsuid=? AND d.provider_message_id=? AND d.state='delivered'`,
    params: [
      proof.occurredAtMs,
      proof.userId,
      proof.portfolioId,
      proof.bsuid,
      Option.getOrElse(proof.replyToMessageId, () => ""),
      proof.occurredAtMs,
      proof.userId,
      proof.portfolioId,
      proof.bsuid,
      Option.getOrElse(proof.replyToMessageId, () => ""),
    ],
  };
  return {
    sql: `SELECT v.* FROM (${statement.sql}) AS v WHERE EXISTS (${association.sql})`,
    params: [...statement.params, ...association.params],
  };
};

/** Live same-association delivery evidence for one referenced message. The caller must separately guard its own data read. */
export const contextualInsightQuery = (
  input: Pick<WhatsAppTurnAdmission, "userId" | "portfolioId" | "bsuid" | "replyToMessageId">
): Option.Option<OwnedStatement> => {
  if (Option.isNone(input.replyToMessageId)) return Option.none();
  const association = whatsAppIdentityQuery(input);
  return Option.some(
    protectConsentStatement({
      subject: { _tag: "User", userId: input.userId },
      requirement: "active",
      statement: {
        sql: `SELECT user_id,insight_event_id,delivery_id FROM (SELECT user_id,insight_event_id,insight_event_id AS delivery_id FROM insight_whatsapp_claims WHERE user_id=? AND portfolio_id=? AND bsuid=? AND provider_message_id=? AND state='delivered' UNION ALL SELECT user_id,delivery_id AS insight_event_id,delivery_id FROM proactivity_whatsapp_claims WHERE user_id=? AND portfolio_id=? AND bsuid=? AND provider_message_id=? AND state='delivered') WHERE EXISTS (${association.sql})`,
        params: [
          input.userId,
          input.portfolioId,
          input.bsuid,
          input.replyToMessageId.value,
          input.userId,
          input.portfolioId,
          input.bsuid,
          input.replyToMessageId.value,
          ...association.params,
        ],
      },
    })
  );
};

/** Complete exact visible-text row for the Agent's atomic copy, guarded by current purpose and channel retention. Published columns are user_id, insight_event_id, delivered_at_ms and text. */
export const insightVerifiedTranscriptQuery = (
  input: Readonly<{ userId: UserId; insightEventId: InsightEventId; now: number }>
): OwnedStatement =>
  protectConsentStatement({
    subject: { _tag: "User", userId: input.userId },
    requirement: "active",
    statement: {
      sql: "SELECT user_id,insight_event_id,delivered_at_ms,text FROM insight_whatsapp_claims WHERE user_id=? AND insight_event_id=? AND state='delivered' AND text IS NOT NULL AND send_started_at_ms + ? > ?",
      params: [input.userId, input.insightEventId, hostedTranscriptRetentionMs, input.now],
    },
  });

/** Owner proof for atomic Insights/Agent settlement; it contains no visible text in the published query. */
export const insightVerifiedDeliveryQuery = (
  input: Readonly<{ userId: UserId; insightEventId: InsightEventId }>
): OwnedStatement => ({
  sql: "SELECT user_id,insight_event_id,provider_message_id,send_started_at_ms,delivered_at_ms FROM insight_whatsapp_claims WHERE user_id=? AND insight_event_id=? AND state='delivered' AND provider_message_id IS NOT NULL AND delivered_at_ms IS NOT NULL",
  params: [input.userId, input.insightEventId],
});
