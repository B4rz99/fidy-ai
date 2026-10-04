import { DateTime, Effect, Option, Schema } from "effect";
import { ConsentRecordId } from "../../../src/core/consent/contract";
import { UserId } from "../../../src/core/identity/contract";
import { IanaTimeZone } from "../../../src/core/_shared/context";
import { decideInsightDelivery } from "../../../src/core/insights/operations";
import {
  HostedDeliveryCorrelationToken,
  WeeklyQuestionOffer,
  type WeeklyQuestionSender,
  type WhatsAppProviderMessageId,
} from "../../../src/shell/channels/whatsapp/contract";
import { type OwnedStatement } from "../../../src/shell/owner-write/contract";
import { prepareConsentAction, prepareWeeklyConsentAction } from "../../consent/operations";
import { whatsAppIdentityQuery } from "../../identity/operations";
import { newId } from "../../secret-material/operations";
import {
  InsightRecipient,
  type WhatsAppStatusAdmission,
  type WhatsAppTurnAdmission,
  WhatsAppUnavailable,
} from "../contract";

const choiceLifetimeMs = 86400000;
const QuestionRow = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  user_id: UserId,
  offer_id: ConsentRecordId,
  grant_id: Schema.OptionFromNullOr(ConsentRecordId),
  correlation_token: HostedDeliveryCorrelationToken,
  portfolio_id: InsightRecipient.fields.portfolioId,
  bsuid: InsightRecipient.fields.bsuid,
  business_phone_number_id: InsightRecipient.fields.businessPhoneNumberId,
  offer_json: Schema.OptionFromNullOr(Schema.fromJsonString(WeeklyQuestionOffer)),
  created_at_ms: Schema.Int,
  expires_at_ms: Schema.Int,
  time_zone: IanaTimeZone,
  state: Schema.String,
});
export type QuestionStart = Readonly<{
  db: D1Database;
  userId: UserId;
  id: string;
  now: DateTime.Utc;
  guard: OwnedStatement;
}>;
export const stageWeeklyQuestion = (
  input: QuestionStart &
    Readonly<{
      offer: typeof WeeklyQuestionOffer.Type;
      grantId: Option.Option<ConsentRecordId>;
      recipient: InsightRecipient;
      timeZone: IanaTimeZone;
      sender: WeeklyQuestionSender;
    }>
): Effect.Effect<boolean, WhatsAppUnavailable> =>
  Effect.gen(function* () {
    const prepared = yield* input.sender.prepare(input.offer);
    const offerJson = yield* Schema.encodeEffect(Schema.fromJsonString(WeeklyQuestionOffer))(
      input.offer
    );
    const association = whatsAppIdentityQuery({ userId: input.userId, ...input.recipient });
    const result = yield* Effect.tryPromise(() =>
      prepareConsentAction({
        db: input.db,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement: {
          sql: `INSERT INTO weekly_governor_questions(id,user_id,offer_id,grant_id,created_at_ms,expires_at_ms,correlation_token,portfolio_id,bsuid,business_phone_number_id,text,offer_json,time_zone) SELECT ?,?,?,NULLIF(?,''),?,?,?,?,?,?,?,?,? WHERE EXISTS (${input.guard.sql}) AND EXISTS (${association.sql}) AND NOT EXISTS (SELECT 1 FROM weekly_governor_questions WHERE user_id=? AND id=?)`,
          params: [
            input.id,
            input.userId,
            input.offer.id,
            Option.getOrElse(input.grantId, () => ""),
            input.now.epochMilliseconds,
            input.now.epochMilliseconds + choiceLifetimeMs,
            HostedDeliveryCorrelationToken.make(newId()),
            input.recipient.portfolioId,
            input.recipient.bsuid,
            input.recipient.businessPhoneNumberId,
            prepared.text,
            offerJson,
            input.timeZone,
            ...input.guard.params,
            ...association.params,
            input.userId,
            input.id,
          ],
        },
      }).run()
    );
    return result.meta.changes === 1;
  }).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

const readQuestionForClaim = (input: QuestionStart): Effect.Effect<unknown, WhatsAppUnavailable> =>
  Effect.gen(function* () {
    const predicate = `FROM weekly_governor_questions AS q WHERE q.user_id=? AND q.id=? AND q.state='ready' AND EXISTS (${input.guard.sql}) AND EXISTS (SELECT 1 FROM whatsapp_identities AS i WHERE i.user_id=q.user_id AND i.portfolio_id=q.portfolio_id AND i.bsuid=q.bsuid)`;
    const params = [input.userId, input.id, ...input.guard.params];
    const raw = yield* Effect.tryPromise(() =>
      prepareConsentAction({
        db: input.db,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement: { sql: `SELECT q.grant_id ${predicate}`, params },
      }).first()
    );
    if (raw === null) return null;
    const metadata = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ grant_id: Schema.OptionFromNullOr(ConsentRecordId) })
    )(raw);
    const statement = { sql: `SELECT q.* ${predicate}`, params };
    const authorized = Option.match(metadata.grant_id, {
      onNone: () =>
        prepareConsentAction({
          db: input.db,
          subject: { _tag: "User", userId: input.userId },
          requirement: "active",
          statement,
        }),
      onSome: (grantId) =>
        prepareWeeklyConsentAction({ db: input.db, userId: input.userId, grantId, statement }),
    });
    return yield* Effect.tryPromise(() => authorized.first());
  }).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

export const startWeeklyQuestion = (
  input: QuestionStart
): Effect.Effect<
  | Readonly<{ _tag: "Done" }>
  | Readonly<{ _tag: "Deferred"; nextEligibleAtMs: number }>
  | Readonly<{ _tag: "Ready"; request: Parameters<WeeklyQuestionSender["send"]>[0] }>,
  WhatsAppUnavailable
> =>
  Effect.gen(function* () {
    const raw = yield* readQuestionForClaim(input);
    if (raw === null) return { _tag: "Done" } as const;
    const row = yield* Schema.decodeUnknownEffect(QuestionRow)(raw);
    const decision = decideInsightDelivery({
      now: input.now,
      scheduledAt: DateTime.makeUnsafe(row.created_at_ms),
      expiresAt: DateTime.makeUnsafe(row.expires_at_ms),
      timeZone: row.time_zone,
    });
    if (decision._tag === "Deferred") {
      return {
        _tag: "Deferred",
        nextEligibleAtMs: decision.nextEligibleAt.epochMilliseconds,
      } as const;
    }
    if (decision._tag === "Expired") {
      yield* Effect.tryPromise(() =>
        input.db
          .prepare(
            "UPDATE weekly_governor_questions SET state='expired',text=NULL,offer_json=NULL WHERE user_id=? AND id=? AND state='ready'"
          )
          .bind(input.userId, input.id)
          .run()
      );
      return { _tag: "Done" } as const;
    }
    if (Option.isNone(row.offer_json)) return { _tag: "Done" } as const;
    const result = yield* Effect.tryPromise(() => prepareQuestionClaim(input, row).run());
    if (result.meta.changes !== 1) return { _tag: "Done" } as const;
    return {
      _tag: "Ready",
      request: {
        offer: row.offer_json.value,
        recipient: row.bsuid,
        businessPhoneNumberId: row.business_phone_number_id,
        correlationToken: row.correlation_token,
      },
    } as const;
  }).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

const prepareQuestionClaim = (
  input: QuestionStart,
  row: typeof QuestionRow.Type
): D1PreparedStatement => {
  const association = whatsAppIdentityQuery({
    userId: input.userId,
    portfolioId: row.portfolio_id,
    bsuid: row.bsuid,
  });
  const statement = {
    sql: `UPDATE weekly_governor_questions SET state='sending',send_started_at_ms=? WHERE user_id=? AND id=? AND state='ready' AND EXISTS (${input.guard.sql}) AND EXISTS (${association.sql})`,
    params: [
      input.now.epochMilliseconds,
      input.userId,
      input.id,
      ...input.guard.params,
      ...association.params,
    ],
  };
  return Option.isSome(row.grant_id)
    ? prepareWeeklyConsentAction({
        db: input.db,
        userId: input.userId,
        grantId: row.grant_id.value,
        statement,
      })
    : prepareConsentAction({
        db: input.db,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement,
      });
};

export const recordWeeklyQuestionSend = (
  input: Readonly<{
    db: D1Database;
    userId: UserId;
    id: string;
    outcome: "accepted" | "ambiguous" | "rejected";
    providerMessageId: Option.Option<WhatsAppProviderMessageId>;
  }>
): Effect.Effect<void, WhatsAppUnavailable> =>
  Effect.tryPromise(() =>
    input.db
      .prepare(
        "UPDATE weekly_governor_questions SET state=?,provider_message_id=coalesce(provider_message_id,?) WHERE user_id=? AND id=? AND state='sending'"
      )
      .bind(input.outcome, Option.getOrNull(input.providerMessageId), input.userId, input.id)
      .run()
  ).pipe(
    Effect.asVoid,
    Effect.mapError(() => new WhatsAppUnavailable())
  );

export const findWeeklyQuestionUser = (
  input: Readonly<{
    db: D1Database;
    correlationToken: HostedDeliveryCorrelationToken;
    businessPhoneNumberId: InsightRecipient["businessPhoneNumberId"];
  }>
): Effect.Effect<Option.Option<UserId>, WhatsAppUnavailable> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          "SELECT user_id FROM weekly_governor_questions WHERE correlation_token=? AND business_phone_number_id=? AND send_started_at_ms IS NOT NULL"
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

export const reconcileWeeklyQuestion = (
  input: Readonly<{ db: D1Database; admission: WhatsAppStatusAdmission }>
): Effect.Effect<
  Option.Option<
    Readonly<{
      id: string;
      offerId: ConsentRecordId;
      caller: Readonly<{
        businessPortfolioId: InsightRecipient["portfolioId"];
        businessScopedUserId: InsightRecipient["bsuid"];
      }>;
      providerMessageId: WhatsAppProviderMessageId;
    }>
  >,
  WhatsAppUnavailable
> =>
  Effect.gen(function* () {
    const status = input.admission;
    const raw = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          `UPDATE weekly_governor_questions SET state=CASE WHEN ?='delivered' THEN 'delivered' WHEN state IN ('delivered','rejected') THEN state WHEN ?='failed' THEN 'rejected' ELSE 'accepted' END,provider_message_id=coalesce(provider_message_id,?),delivered_at_ms=CASE WHEN ?='delivered' THEN coalesce(delivered_at_ms,?) ELSE delivered_at_ms END WHERE user_id=? AND correlation_token=? AND business_phone_number_id=? AND send_started_at_ms IS NOT NULL AND (provider_message_id IS NULL OR provider_message_id=?) AND ?+1000 >= send_started_at_ms AND ? <= ?+300000 RETURNING *`
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
          status.occurredAtMs,
          status.receivedAtMs
        )
        .first()
    );
    if (raw === null) return Option.none();
    const row = yield* Schema.decodeUnknownEffect(QuestionRow)(raw);
    return row.state !== "delivered"
      ? Option.none()
      : Option.some({
          id: row.id,
          offerId: row.offer_id,
          caller: { businessPortfolioId: row.portfolio_id, businessScopedUserId: row.bsuid },
          providerMessageId: status.providerMessageId,
        });
  }).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

/** Accept requires a current offer; an authenticated no may revoke the category even after that disclosure expires or was accepted. */
export const readWeeklyReplyChoice = (
  input: Readonly<{ db: D1Database; proof: WhatsAppTurnAdmission; now: number }>
): Effect.Effect<Option.Option<string>, WhatsAppUnavailable> =>
  Effect.gen(function* () {
    const normalized = input.proof.text.trim().toLowerCase();
    const decision = ["no", "no, gracias"].includes(normalized) ? "decline" : "accept";
    if (
      !["no", "no, gracias", "sí", "si"].includes(normalized) ||
      Option.isNone(input.proof.replyToMessageId)
    ) {
      return Option.none();
    }
    const raw = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          "SELECT offer_id FROM weekly_governor_questions WHERE user_id=? AND portfolio_id=? AND bsuid=? AND provider_message_id=? AND state='delivered' AND (?='decline' OR expires_at_ms>?)"
        )
        .bind(
          input.proof.userId,
          input.proof.portfolioId,
          input.proof.bsuid,
          Option.getOrElse(input.proof.replyToMessageId, () => ""),
          decision,
          input.now
        )
        .first()
    );
    if (raw === null) return Option.none();
    const row = yield* Schema.decodeUnknownEffect(Schema.Struct({ offer_id: ConsentRecordId }))(
      raw
    );
    return Option.some(`weekly:${row.offer_id}:${decision}`);
  }).pipe(Effect.mapError(() => new WhatsAppUnavailable()));

/** Only verified question sends, with identity and send instant for the Insights-owned counter policy. */
export const weeklyQuestionDeliveryQuery = (
  input: Readonly<{ userId: UserId; id: string }>
): OwnedStatement => ({
  sql: "SELECT user_id,id AS question_id,send_started_at_ms,delivered_at_ms FROM weekly_governor_questions WHERE user_id=? AND id=? AND state='delivered'",
  params: [input.userId, input.id],
});

export const expireWeeklyQuestions = (
  input: Readonly<{ db: D1Database; now: number }>
): Effect.Effect<void, WhatsAppUnavailable> =>
  Effect.tryPromise(() =>
    input.db
      .prepare(
        "UPDATE weekly_governor_questions SET text=NULL,offer_json=NULL WHERE created_at_ms+2592000000 <= ? OR (state='ready' AND expires_at_ms<=?)"
      )
      .bind(input.now, input.now)
      .run()
  ).pipe(
    Effect.asVoid,
    Effect.mapError(() => new WhatsAppUnavailable())
  );
