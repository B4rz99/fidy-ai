import { Effect, Option, Schema } from "effect";
import {
  ConsentRecord,
  ConsentRecordId,
  DisclosureSnapshot,
} from "../../../src/core/consent/contract";
import { UserId, WhatsAppCallerReference } from "../../../src/core/identity/contract";
import { WhatsAppProviderMessageId } from "../../../src/core/provider-evidence/contract";
import {
  protectConsentStatement,
  weeklyDisclosureFor,
} from "../../../src/shell/consent/operations";
import { whatsAppAssociationQuery } from "../../../src/shell/identity/operations";
import { newId } from "../../secret-material/operations";
import {
  ConsentUnavailable,
  type PreparedWeeklyConsentDecision,
  type WeeklyConsentAction,
  type WeeklyConsentContext,
  type WeeklyConsentOffer,
} from "../contract";

const offerLifetimeMs = 600_000;
const dailyWindowMs = 86_400_000;
const Context = Schema.Struct({ userId: UserId, caller: WhatsAppCallerReference });
const OfferRow = Schema.Struct({
  id: ConsentRecordId,
  disclosure_json: Schema.String,
  disclosure_message_id: Schema.NullOr(WhatsAppProviderMessageId),
  decision_message_id: Schema.NullOr(WhatsAppProviderMessageId),
  expires_at_ms: Schema.Int,
});
type OfferRow = typeof OfferRow.Type;
const Choice = Schema.Tuple([
  Schema.Literal("weekly"),
  ConsentRecordId,
  Schema.Literals(["accept", "decline", "revoke"]),
]);
type Choice = typeof Choice.Type;
const RecordRow = Schema.Struct({ record_json: Schema.String });
const decodeRecord = (raw: unknown): Option.Option<ConsentRecord> =>
  Option.flatMap(Schema.decodeUnknownOption(RecordRow)(raw), ({ record_json }) =>
    Schema.decodeOption(Schema.fromJsonString(Schema.toCodecJson(ConsentRecord)))(record_json)
  );
const liveGrant = `SELECT g.id FROM weekly_consent_records g WHERE g.user_id = ? AND g.grant_id IS NULL
 AND NOT EXISTS (SELECT 1 FROM weekly_consent_records r WHERE r.user_id = g.user_id AND r.grant_id = g.id)`;

export const findGrant = ({
  db,
  userId,
}: Readonly<{ db: D1Database; userId: UserId }>): Effect.Effect<
  Option.Option<ConsentRecord>,
  ConsentUnavailable
> =>
  Effect.gen(function* () {
    const user = yield* Schema.decodeEffect(UserId)(userId);
    const rows = yield* Effect.tryPromise(() =>
      db
        .prepare(
          `SELECT record_json FROM weekly_consent_records WHERE id IN (${liveGrant}) LIMIT 2`
        )
        .bind(user)
        .all()
    );
    if (rows.results.length === 0) return Option.none<ConsentRecord>();
    if (rows.results.length !== 1) return yield* new ConsentUnavailable();
    const record = decodeRecord(rows.results[0]);
    if (Option.isNone(record)) return yield* new ConsentUnavailable();
    const event = record.value.event;
    if (record.value.subjectUserId !== user || event._tag !== "Granted") {
      return yield* new ConsentUnavailable();
    }
    if (event.grant._tag !== "InsightDelivery" || event.grant.insightKind !== "weekly-summary") {
      return yield* new ConsentUnavailable();
    }
    return record;
  }).pipe(Effect.mapError(() => new ConsentUnavailable()));

export const guardedAction = ({
  db,
  userId,
  grantId,
  statement,
}: WeeklyConsentAction): D1PreparedStatement => {
  const guard = protectConsentStatement({
    subject: { _tag: "User", userId },
    requirement: "active",
    statement: {
      sql: `${statement.sql} AND EXISTS (${liveGrant} AND g.id = ?)`,
      params: [...statement.params, userId, grantId],
    },
  });
  return db.prepare(guard.sql).bind(...guard.params);
};
const channelAction = (
  input: WeeklyConsentContext,
  statement: WeeklyConsentAction["statement"]
): D1PreparedStatement => {
  const context = Schema.decodeSync(Context)({ userId: input.userId, caller: input.caller });
  const association = whatsAppAssociationQuery(context);
  const protectedStatement = protectConsentStatement({
    subject: { _tag: "User", userId: context.userId },
    requirement: "active",
    statement: {
      sql: `${statement.sql} AND EXISTS (${association.sql})`,
      params: [...statement.params, ...association.params],
    },
  });
  return input.db.prepare(protectedStatement.sql).bind(...protectedStatement.params);
};

export const createOffer = (
  input: WeeklyConsentContext
): Effect.Effect<Option.Option<WeeklyConsentOffer>, ConsentUnavailable> =>
  Effect.gen(function* () {
    const id = ConsentRecordId.make(newId());
    const disclosure = weeklyDisclosureFor();
    const json = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(DisclosureSnapshot))
    )(disclosure);
    const now = input.now.epochMilliseconds;
    const inserted = yield* Effect.tryPromise(() =>
      channelAction(input, {
        sql: `INSERT INTO weekly_consent_offers (id,user_id,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms)
      SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM weekly_consent_offers WHERE user_id = ? AND created_at_ms > ?) < 8
      AND NOT EXISTS (SELECT 1 FROM weekly_consent_offers WHERE user_id = ? AND decision IS NULL AND expires_at_ms > ?)`,
        params: [
          id,
          input.userId,
          input.caller.businessPortfolioId,
          input.caller.businessScopedUserId,
          json,
          now,
          now + offerLifetimeMs,
          input.userId,
          now - dailyWindowMs,
          input.userId,
          now,
        ],
      }).run()
    );
    return inserted.meta.changes === 1
      ? Option.some({
          id,
          disclosure,
          acceptChoice: `weekly:${id}:accept`,
          declineChoice: `weekly:${id}:decline`,
          revokeChoice: `weekly:${id}:revoke`,
        })
      : Option.none();
  }).pipe(Effect.mapError(() => new ConsentUnavailable()));

export const discloseOffer = (
  input: WeeklyConsentContext & Readonly<{ offerId: ConsentRecordId; disclosureMessageId: string }>
): Effect.Effect<boolean, ConsentUnavailable> =>
  Effect.gen(function* () {
    const message = yield* Schema.decodeEffect(WhatsAppProviderMessageId)(
      input.disclosureMessageId
    );
    const id = yield* Schema.decodeEffect(ConsentRecordId)(input.offerId);
    const result = yield* Effect.tryPromise(() =>
      channelAction(input, {
        sql: `UPDATE weekly_consent_offers SET disclosure_message_id = ?, disclosed_at_ms = ? WHERE id = ? AND user_id = ? AND portfolio_id = ? AND bsuid = ? AND disclosure_message_id IS NULL AND decision IS NULL AND expires_at_ms > ?`,
        params: [
          message,
          input.now.epochMilliseconds,
          id,
          input.userId,
          input.caller.businessPortfolioId,
          input.caller.businessScopedUserId,
          input.now.epochMilliseconds,
        ],
      }).run()
    );
    return result.meta.changes === 1;
  }).pipe(Effect.mapError(() => new ConsentUnavailable()));

const findDecisionOffer = (
  input: WeeklyConsentContext,
  id: ConsentRecordId
): Effect.Effect<Option.Option<OfferRow>, ConsentUnavailable> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          "SELECT id,disclosure_json,disclosure_message_id,decision_message_id,expires_at_ms FROM weekly_consent_offers WHERE id = ? AND user_id = ? AND portfolio_id = ? AND bsuid = ?"
        )
        .bind(id, input.userId, input.caller.businessPortfolioId, input.caller.businessScopedUserId)
        .first()
    );
    if (raw === null) return Option.none();
    const offer = yield* Schema.decodeUnknownEffect(OfferRow)(raw);
    if (
      offer.disclosure_message_id === null ||
      offer.decision_message_id !== null ||
      offer.expires_at_ms <= input.now.epochMilliseconds
    ) {
      return Option.none();
    }
    return Option.some(offer);
  }).pipe(Effect.mapError(() => new ConsentUnavailable()));

const decisionUpdate = (
  input: WeeklyConsentContext,
  choice: Choice,
  message: WhatsAppProviderMessageId
): D1PreparedStatement =>
  channelAction(input, {
    sql: `UPDATE weekly_consent_offers SET decision_message_id = ?, decision = ? WHERE id = ? AND user_id = ? AND portfolio_id = ? AND bsuid = ? AND disclosure_message_id IS NOT NULL AND decision IS NULL AND expires_at_ms > ?`,
    params: [
      message,
      choice[2],
      choice[1],
      input.userId,
      input.caller.businessPortfolioId,
      input.caller.businessScopedUserId,
      input.now.epochMilliseconds,
    ],
  });
const decisionAssertion = (db: D1Database): D1PreparedStatement =>
  db.prepare(
    "INSERT INTO weekly_consent_assertion (id,accepted) VALUES (1,CASE WHEN changes() = 1 THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted"
  );

const prepareRecord = (
  input: WeeklyConsentContext,
  evidence: Readonly<{ offer: OfferRow; message: WhatsAppProviderMessageId }>,
  grantId: Option.Option<ConsentRecordId>
): Effect.Effect<
  Readonly<{ id: ConsentRecordId; statement: D1PreparedStatement }>,
  ConsentUnavailable
> =>
  Effect.gen(function* () {
    const { offer, message } = evidence;
    if (offer.disclosure_message_id === null) return yield* new ConsentUnavailable();
    const disclosure = yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(DisclosureSnapshot))
    )(offer.disclosure_json);
    const id = ConsentRecordId.make(newId());
    const record = ConsentRecord.make({
      id,
      subjectUserId: input.userId,
      event: Option.isSome(grantId)
        ? { _tag: "Revoked", grantId: grantId.value }
        : { _tag: "Granted", grant: { _tag: "InsightDelivery", insightKind: "weekly-summary" } },
      disclosure,
      occurredAt: input.now,
      evidence: {
        _tag: "ProviderQualifiedMessages",
        disclosureMessage: {
          channel: "whatsapp",
          provider: "kapso",
          providerMessageId: offer.disclosure_message_id,
        },
        decisionMessage: { channel: "whatsapp", provider: "kapso", providerMessageId: message },
      },
    });
    const json = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(ConsentRecord))
    )(record);
    const statement = input.db
      .prepare(
        `INSERT INTO weekly_consent_records (id,user_id,grant_id,offer_id,record_json,occurred_at_ms) SELECT ?,?,?,?,?,? WHERE changes() = 1`
      )
      .bind(
        id,
        input.userId,
        Option.getOrNull(grantId),
        offer.id,
        json,
        input.now.epochMilliseconds
      );
    return { id, statement };
  }).pipe(Effect.mapError(() => new ConsentUnavailable()));

const grantConflict = (decision: Choice[2], grant: Option.Option<ConsentRecord>): boolean =>
  (decision === "accept" && Option.isSome(grant)) ||
  (decision === "revoke" && Option.isNone(grant));

export const prepareDecision = (
  input: WeeklyConsentContext & Readonly<{ choice: string; decisionMessageId: string }>
): Effect.Effect<Option.Option<PreparedWeeklyConsentDecision>, ConsentUnavailable> =>
  Effect.gen(function* () {
    const choice = Schema.decodeUnknownOption(Choice)(input.choice.split(":"));
    if (Option.isNone(choice)) return Option.none();
    const offer = yield* findDecisionOffer(input, choice.value[1]);
    if (Option.isNone(offer)) return Option.none();
    const grant = yield* findGrant(input);
    const decision = choice.value[2];
    if (grantConflict(decision, grant)) return Option.none();
    const message = yield* Schema.decodeEffect(WhatsAppProviderMessageId)(input.decisionMessageId);
    const statements = [decisionUpdate(input, choice.value, message)];
    if (decision === "decline") {
      return Option.some({
        decision,
        grantId: Option.none(),
        statements: [...statements, decisionAssertion(input.db)],
      });
    }
    const revokedId =
      decision === "revoke"
        ? Option.map(grant, (record) => record.id)
        : Option.none<ConsentRecordId>();
    const record = yield* prepareRecord(input, { offer: offer.value, message }, revokedId);
    return Option.some({
      decision,
      grantId: decision === "accept" ? Option.some(record.id) : revokedId,
      statements: [...statements, record.statement, decisionAssertion(input.db)],
    });
  }).pipe(Effect.mapError(() => new ConsentUnavailable()));
