import { Effect, Option, Schema } from "effect";
import { UserId } from "../../../src/core/identity/contract";
import { IanaTimeZone } from "../../../src/core/_shared/context";
import { decideInsightDelivery } from "../../../src/core/insights/operations";
import {
  HostedDeliveryCorrelationToken,
  PreparedProactivityTemplate,
  type WhatsAppProviderMessageId,
} from "../../../src/shell/channels/whatsapp/contract";
import { type OwnedStatement } from "../../../src/shell/owner-write/contract";
import { prepareConsentAction, prepareProactivityConsentAction } from "../../consent/operations";
import { whatsAppIdentityQuery } from "../../identity/operations";
import { newId } from "../../secret-material/operations";
import {
  InsightRecipient,
  type ProactivityChannelClaim,
  type ProactivityChannelReconciliation,
  type ProactivityChannelScope,
  type ProactivityChannelStage,
  type WhatsAppStatusAdmission,
  type WhatsAppTurnAdmission,
  WhatsAppUnavailable,
} from "../contract";

const maximumDailyClaims = 32;
const dayMs = 86400000;
const retentionMs = 2592000000;
const timestampPrecisionMs = 1000;
const maximumFutureDriftMs = 300000;
const Claim = Schema.Struct({
  correlation_token: HostedDeliveryCorrelationToken,
  portfolio_id: InsightRecipient.fields.portfolioId,
  bsuid: InsightRecipient.fields.bsuid,
  business_phone_number_id: InsightRecipient.fields.businessPhoneNumberId,
  template_json: Schema.fromJsonString(PreparedProactivityTemplate),
  scheduled_at_ms: Schema.DateTimeUtcFromMillis,
  expires_at_ms: Schema.DateTimeUtcFromMillis,
  time_zone: IanaTimeZone,
});
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, WhatsAppUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new WhatsAppUnavailable() });
const protectedAction = (
  input: ProactivityChannelScope,
  statement: OwnedStatement
): Effect.Effect<D1PreparedStatement, WhatsAppUnavailable> =>
  Effect.sync(() => {
    if (!("grantId" in input)) {
      return prepareConsentAction({
        db: input.db,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement,
      });
    }
    return prepareProactivityConsentAction({
      db: input.db,
      userId: input.userId,
      kind: input.role === "reminder-question" ? "manual-entry-reminder" : input.role,
      grantId: input.grantId,
      statement,
    });
  });

const grantParameter = (input: ProactivityChannelScope): string =>
  "grantId" in input ? input.grantId : "";

export const stage = (input: ProactivityChannelStage): Effect.Effect<void, WhatsAppUnavailable> =>
  Effect.gen(function* () {
    const template = yield* input.sender.prepare(input.text);
    const serialized = yield* Schema.encodeEffect(
      Schema.fromJsonString(PreparedProactivityTemplate)
    )(template);
    const association = whatsAppIdentityQuery({ userId: input.userId, ...input.recipient });
    const prior = yield* protectedAction(input, {
      sql: "SELECT template_json FROM proactivity_whatsapp_claims WHERE user_id=? AND delivery_id=? AND state='staged'",
      params: [input.userId, input.id],
    });
    const raw = yield* attempt(() => prior.first());
    if (raw !== null) {
      const stored = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ template_json: Schema.String })
      )(raw);
      if (stored.template_json !== serialized) return yield* new WhatsAppUnavailable();
    }
    const statement = yield* protectedAction(input, {
      sql: `INSERT OR IGNORE INTO proactivity_whatsapp_claims(user_id,delivery_id,role,consent_grant_id,correlation_token,portfolio_id,bsuid,business_phone_number_id,template_json,text,scheduled_at_ms,expires_at_ms,time_zone,state) SELECT ?,?,?,NULLIF(?,''),?,?,?,?,?,?,?,?,?, 'staged' WHERE EXISTS (${input.guard.sql}) AND EXISTS (${association.sql})`,
      params: [
        input.userId,
        input.id,
        input.role,
        grantParameter(input),
        newId(),
        input.recipient.portfolioId,
        input.recipient.bsuid,
        input.recipient.businessPhoneNumberId,
        serialized,
        template.text,
        input.scheduledAt.epochMilliseconds,
        input.expiresAt.epochMilliseconds,
        input.timeZone,
        ...input.guard.params,
        ...association.params,
      ],
    });
    yield* attempt(() => statement.run());
  }).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

const expireStaged = (input: ProactivityChannelScope): Effect.Effect<void, WhatsAppUnavailable> =>
  attempt(() =>
    input.db
      .prepare(
        "UPDATE proactivity_whatsapp_claims SET state='expired',text=NULL,template_json=NULL WHERE user_id=? AND delivery_id=? AND state='staged'"
      )
      .bind(input.userId, input.id)
      .run()
  ).pipe(Effect.asVoid);

export const start = (
  input: ProactivityChannelScope
): Effect.Effect<ProactivityChannelClaim, WhatsAppUnavailable> =>
  Effect.gen(function* () {
    const select = yield* protectedAction(input, {
      sql: `SELECT correlation_token,portfolio_id,bsuid,business_phone_number_id,template_json,scheduled_at_ms,expires_at_ms,time_zone FROM proactivity_whatsapp_claims WHERE user_id=? AND delivery_id=? AND role=? AND consent_grant_id IS NULLIF(?,'') AND state='staged' AND EXISTS (${input.guard.sql})`,
      params: [input.userId, input.id, input.role, grantParameter(input), ...input.guard.params],
    });
    const raw = yield* attempt(() => select.first());
    if (raw === null) return { _tag: "NotClaimed" } as const;
    const row = yield* Schema.decodeUnknownEffect(Claim)(raw);
    const decision = decideInsightDelivery({
      now: input.now,
      scheduledAt: row.scheduled_at_ms,
      expiresAt: row.expires_at_ms,
      timeZone: row.time_zone,
    });
    if (decision._tag === "Deferred") return decision;
    if (decision._tag === "Expired") {
      yield* expireStaged(input);
      return { _tag: "Expired" } as const;
    }
    const association = whatsAppIdentityQuery({
      userId: input.userId,
      portfolioId: row.portfolio_id,
      bsuid: row.bsuid,
    });
    const update = yield* protectedAction(input, {
      sql: `UPDATE proactivity_whatsapp_claims SET state='sending',send_started_at_ms=? WHERE user_id=? AND delivery_id=? AND state='staged' AND correlation_token=? AND EXISTS (${input.guard.sql}) AND EXISTS (${association.sql}) AND (SELECT count(*) FROM proactivity_whatsapp_claims WHERE user_id=? AND send_started_at_ms>?)<?`,
      params: [
        input.now.epochMilliseconds,
        input.userId,
        input.id,
        row.correlation_token,
        ...input.guard.params,
        ...association.params,
        input.userId,
        input.now.epochMilliseconds - dayMs,
        maximumDailyClaims,
      ],
    });
    const changed = yield* attempt(() => update.run());
    if (changed.meta.changes !== 1) return { _tag: "NotClaimed" } as const;
    return {
      _tag: "Ready",
      correlationToken: row.correlation_token,
      request: {
        recipient: row.bsuid,
        businessPhoneNumberId: row.business_phone_number_id,
        correlationToken: row.correlation_token,
        template: row.template_json,
      },
    } as const;
  }).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const recordSend = (
  input: Readonly<{
    db: D1Database;
    userId: UserId;
    id: string;
    correlationToken: HostedDeliveryCorrelationToken;
    outcome: "accepted" | "ambiguous" | "rejected";
    providerMessageId: Option.Option<WhatsAppProviderMessageId>;
  }>
): Effect.Effect<void, WhatsAppUnavailable> =>
  attempt(() =>
    input.db
      .prepare(
        "UPDATE proactivity_whatsapp_claims SET state=?,provider_message_id=coalesce(provider_message_id,?) WHERE user_id=? AND delivery_id=? AND correlation_token=? AND state='sending'"
      )
      .bind(
        input.outcome,
        Option.getOrNull(input.providerMessageId),
        input.userId,
        input.id,
        input.correlationToken
      )
      .run()
  ).pipe(Effect.asVoid);

export const prepareReconciliation = (
  input: Readonly<{ db: D1Database; admission: WhatsAppStatusAdmission }>
): D1PreparedStatement => {
  const status = input.admission;
  return input.db
    .prepare(
      "UPDATE proactivity_whatsapp_claims SET state=CASE WHEN ?='delivered' THEN 'delivered' WHEN state IN ('delivered','rejected') THEN state WHEN ?='failed' THEN 'rejected' ELSE 'accepted' END,provider_message_id=coalesce(provider_message_id,?),delivered_at_ms=CASE WHEN ?='delivered' THEN coalesce(delivered_at_ms,?) ELSE delivered_at_ms END WHERE user_id=? AND correlation_token=? AND business_phone_number_id=? AND send_started_at_ms IS NOT NULL AND (provider_message_id IS NULL OR provider_message_id=?) AND ?+?>=send_started_at_ms AND ?<=? AND state NOT IN ('staged','expired')"
    )
    .bind(
      status.outcome,
      status.outcome,
      status.providerMessageId,
      status.outcome,
      status.occurredAtMs,
      status.userId,
      status.correlationToken,
      status.businessPhoneNumberId,
      status.providerMessageId,
      status.occurredAtMs,
      timestampPrecisionMs,
      status.occurredAtMs,
      status.receivedAtMs + maximumFutureDriftMs
    );
};

export const reconcile = (
  input: Readonly<{ db: D1Database; admission: WhatsAppStatusAdmission }>
): Effect.Effect<ProactivityChannelReconciliation, WhatsAppUnavailable> =>
  Effect.gen(function* () {
    const status = input.admission;
    const raw = yield* attempt(() =>
      input.db
        .prepare(
          `SELECT delivery_id,CASE WHEN ?='delivered' THEN 'delivered' ELSE state END AS state FROM proactivity_whatsapp_claims WHERE user_id=? AND correlation_token=? AND business_phone_number_id=? AND send_started_at_ms IS NOT NULL AND (provider_message_id IS NULL OR provider_message_id=?) AND ?+?>=send_started_at_ms AND ?<=? AND state NOT IN ('staged','expired')`
        )
        .bind(
          status.outcome,
          status.userId,
          status.correlationToken,
          status.businessPhoneNumberId,
          status.providerMessageId,
          status.occurredAtMs,
          timestampPrecisionMs,
          status.occurredAtMs,
          status.receivedAtMs + maximumFutureDriftMs
        )
        .first()
    );
    if (raw === null) return { _tag: "Refused" } as const;
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        delivery_id: Schema.String.check(Schema.isUUID()),
        state: Schema.Literals(["sending", "accepted", "ambiguous", "rejected", "delivered"]),
      })
    )(raw);
    if (row.state === "delivered") {
      return { _tag: "VerifiedDelivery", userId: status.userId, id: row.delivery_id } as const;
    }
    yield* attempt(() => prepareReconciliation(input).run());
    return { _tag: "Recorded" } as const;
  }).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const findDeliveryUser = (
  input: Readonly<{
    db: D1Database;
    correlationToken: HostedDeliveryCorrelationToken;
    businessPhoneNumberId: InsightRecipient["businessPhoneNumberId"];
  }>
): Effect.Effect<Option.Option<UserId>, WhatsAppUnavailable> =>
  Effect.gen(function* () {
    const raw = yield* attempt(() =>
      input.db
        .prepare(
          "SELECT user_id FROM proactivity_whatsapp_claims WHERE correlation_token=? AND business_phone_number_id=? AND send_started_at_ms IS NOT NULL"
        )
        .bind(input.correlationToken, input.businessPhoneNumberId)
        .first()
    );
    return raw === null
      ? Option.none()
      : Option.some(
          (yield* Schema.decodeUnknownEffect(Schema.Struct({ user_id: UserId }))(raw)).user_id
        );
  }).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

/** Metadata-only no-resend identities for bounded expiry/recovery; a begun send remains begun regardless of provider outcome. */
export const startedDeliveryQuery = (): OwnedStatement => ({
  sql: "SELECT user_id,delivery_id FROM proactivity_whatsapp_claims WHERE send_started_at_ms IS NOT NULL",
  params: [],
});

/** Definitive failure evidence for one captured delivery; unknown/accepted sends never authorize a replacement question. */
export const rejectedDeliveryQuery = (
  input: Readonly<{ userId: UserId; id: string }>
): OwnedStatement => ({
  sql: "SELECT user_id,delivery_id FROM proactivity_whatsapp_claims WHERE user_id=? AND delivery_id=? AND state='rejected'",
  params: [input.userId, input.id],
});

export const deliveryQuery = (input: Readonly<{ userId: UserId; id: string }>): OwnedStatement => ({
  sql: "SELECT user_id,delivery_id,role,provider_message_id,send_started_at_ms,delivered_at_ms FROM proactivity_whatsapp_claims WHERE user_id=? AND delivery_id=? AND state='delivered' AND provider_message_id IS NOT NULL AND delivered_at_ms IS NOT NULL",
  params: [input.userId, input.id],
});
export const transcriptQuery = (
  input: Readonly<{ userId: UserId; id: string; now: number }>
): OwnedStatement => {
  const base = deliveryQuery(input);
  return {
    sql: `SELECT v.*,c.text FROM (${base.sql}) AS v JOIN proactivity_whatsapp_claims AS c ON c.user_id=v.user_id AND c.delivery_id=v.delivery_id WHERE c.text IS NOT NULL AND c.send_started_at_ms+?>?`,
    params: [...base.params, retentionMs, input.now],
  };
};
/** A qualified question control is bound to exact verified visible delivery, current association and retained channel evidence. */
export const controlQuery = (
  input: Readonly<{ proof: WhatsAppTurnAdmission; id: string; now: number }>
): OwnedStatement => {
  const association = whatsAppIdentityQuery({
    userId: input.proof.userId,
    portfolioId: input.proof.portfolioId,
    bsuid: input.proof.bsuid,
  });
  return {
    sql: `SELECT c.user_id,c.delivery_id,c.consent_grant_id FROM proactivity_whatsapp_claims AS c WHERE c.user_id=? AND c.delivery_id=? AND c.role='reminder-question' AND c.state='delivered' AND c.text IS NOT NULL AND c.send_started_at_ms+?>? AND c.delivered_at_ms<=?+? AND c.portfolio_id=? AND c.bsuid=? AND c.business_phone_number_id=? AND EXISTS (${association.sql})`,
    params: [
      input.proof.userId,
      input.id,
      retentionMs,
      input.now,
      input.proof.occurredAtMs,
      timestampPrecisionMs,
      input.proof.portfolioId,
      input.proof.bsuid,
      input.proof.businessPhoneNumberId,
      ...association.params,
    ],
  };
};
export const replyQuery = (input: WhatsAppTurnAdmission): OwnedStatement => {
  const association = whatsAppIdentityQuery({
    userId: input.userId,
    portfolioId: input.portfolioId,
    bsuid: input.bsuid,
  });
  return {
    sql: `SELECT c.user_id,c.delivery_id,c.role,c.delivered_at_ms,? AS occurred_at_ms FROM proactivity_whatsapp_claims AS c WHERE c.user_id=? AND c.provider_message_id=? AND c.state='delivered' AND c.role IN ('manual-entry-reminder','reminder-question') AND c.portfolio_id=? AND c.bsuid=? AND c.business_phone_number_id=? AND EXISTS (${association.sql})`,
    params: [
      input.occurredAtMs,
      input.userId,
      Option.getOrElse(input.replyToMessageId, () => ""),
      input.portfolioId,
      input.bsuid,
      input.businessPhoneNumberId,
      ...association.params,
    ],
  };
};
export const sweepEvidence = (
  input: Readonly<{ db: D1Database; now: number }>
): Effect.Effect<void, WhatsAppUnavailable> =>
  attempt(() =>
    input.db.batch([
      input.db
        .prepare(
          `UPDATE proactivity_whatsapp_claims SET text=NULL,template_json=NULL WHERE rowid IN (
             SELECT rowid FROM proactivity_whatsapp_claims
             WHERE (text IS NOT NULL OR template_json IS NOT NULL) AND send_started_at_ms <= ?
             ORDER BY send_started_at_ms LIMIT 64
           ) AND (text IS NOT NULL OR template_json IS NOT NULL)`
        )
        .bind(input.now - retentionMs),
      input.db
        .prepare(
          `UPDATE proactivity_whatsapp_claims SET text=NULL,template_json=NULL WHERE rowid IN (
             SELECT rowid FROM proactivity_whatsapp_claims
             WHERE (text IS NOT NULL OR template_json IS NOT NULL) AND state='staged' AND expires_at_ms <= ?
             ORDER BY expires_at_ms LIMIT 64
           ) AND (text IS NOT NULL OR template_json IS NOT NULL)`
        )
        .bind(input.now),
    ])
  ).pipe(Effect.asVoid);
