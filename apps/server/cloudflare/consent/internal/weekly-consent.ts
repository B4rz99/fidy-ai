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
  type WeeklyConsentOfferRequest,
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
 AND NOT EXISTS (SELECT 1 FROM weekly_consent_records r WHERE r.user_id = g.user_id AND r.grant_id = g.id)
 AND NOT EXISTS (SELECT 1 FROM weekly_consent_revocation_records r WHERE r.user_id = g.user_id AND r.grant_id = g.id)`;

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

/** Identity-bound privacy control and public-disclosure audit; never used to grant financial authority. */
const privacyChannelAction = (
  input: WeeklyConsentContext,
  statement: WeeklyConsentAction["statement"]
): D1PreparedStatement => {
  const context = Schema.decodeSync(Context)({ userId: input.userId, caller: input.caller });
  const association = whatsAppAssociationQuery(context);
  return input.db
    .prepare(`${statement.sql} AND EXISTS (${association.sql})`)
    .bind(...statement.params, ...association.params);
};

export const latestRejection = (
  input: Readonly<{ db: D1Database; userId: UserId }>
): Effect.Effect<Option.Option<ConsentRecordId>, ConsentUnavailable> =>
  Effect.gen(function* () {
    const query = protectConsentStatement({
      subject: { _tag: "User", userId: input.userId },
      requirement: "active",
      statement: {
        sql: "SELECT id FROM weekly_consent_rejections WHERE user_id=?",
        params: [input.userId],
      },
    });
    const raw = yield* Effect.tryPromise(() =>
      input.db
        .prepare(`${query.sql} ORDER BY sequence DESC LIMIT 1`)
        .bind(...query.params)
        .first()
    );
    return raw === null
      ? Option.none()
      : Option.some(
          (yield* Schema.decodeUnknownEffect(Schema.Struct({ id: ConsentRecordId }))(raw)).id
        );
  }).pipe(Effect.mapError(() => new ConsentUnavailable()));

const requestedOfferIsCurrent = (
  input: WeeklyConsentContext & Readonly<{ request: WeeklyConsentOfferRequest }>
): Effect.Effect<boolean, ConsentUnavailable> =>
  Effect.gen(function* () {
    const request = input.request;
    if (request._tag !== "GovernorQuestion" || request.origin !== "requested") return true;
    const rejection = yield* latestRejection(input);
    return (
      request.requestedAt.epochMilliseconds <= input.now.epochMilliseconds &&
      request.requestedAt.epochMilliseconds + dailyWindowMs > input.now.epochMilliseconds &&
      Option.getOrNull(rejection) === Option.getOrNull(request.rejectionOfferId)
    );
  });

const existingSourceOffer = (
  input: WeeklyConsentContext & Readonly<{ request: WeeklyConsentOfferRequest }>
): Effect.Effect<Option.Option<WeeklyConsentOffer>, ConsentUnavailable> =>
  Effect.gen(function* () {
    if (input.request._tag === "GovernorQuestion") {
      const sourceId = yield* Schema.decodeEffect(Schema.String.check(Schema.isUUID()))(
        input.request.sourceId
      );
      const raw = yield* Effect.tryPromise(() =>
        channelAction(input, {
          sql: "SELECT id,disclosure_json FROM weekly_consent_offers WHERE user_id=? AND source_id=? AND portfolio_id=? AND bsuid=? AND expires_at_ms>?",
          params: [
            input.userId,
            sourceId,
            input.caller.businessPortfolioId,
            input.caller.businessScopedUserId,
            input.now.epochMilliseconds,
          ],
        }).first()
      );
      if (raw !== null) {
        const row = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            id: ConsentRecordId,
            disclosure_json: Schema.fromJsonString(Schema.toCodecJson(DisclosureSnapshot)),
          })
        )(raw);
        return Option.some({
          id: row.id,
          disclosure: row.disclosure_json,
          acceptChoice: `weekly:${row.id}:accept`,
          declineChoice: `weekly:${row.id}:decline`,
          revokeChoice: `weekly:${row.id}:revoke`,
        });
      }
    }
    return Option.none();
  }).pipe(Effect.mapError(() => new ConsentUnavailable()));

export const createOffer = (
  input: WeeklyConsentContext & Readonly<{ request: WeeklyConsentOfferRequest }>
): Effect.Effect<Option.Option<WeeklyConsentOffer>, ConsentUnavailable> =>
  Effect.gen(function* () {
    if (!(yield* requestedOfferIsCurrent(input))) return Option.none();
    const existing = yield* existingSourceOffer(input);
    if (Option.isSome(existing)) return existing;
    const id = ConsentRecordId.make(newId());
    const disclosure = weeklyDisclosureFor();
    const json = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(DisclosureSnapshot))
    )(disclosure);
    const now = input.now.epochMilliseconds;
    const inserted = yield* Effect.tryPromise(() =>
      channelAction(input, {
        sql: `INSERT INTO weekly_consent_offers (id,user_id,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms,source_id,rejection_id)
      SELECT ?,?,?,?,?,?,?,NULLIF(?,''),(SELECT id FROM weekly_consent_rejections WHERE user_id=? ORDER BY sequence DESC LIMIT 1) WHERE (SELECT COUNT(*) FROM weekly_consent_offers WHERE user_id = ? AND created_at_ms > ?) < 8
      AND NOT EXISTS (SELECT 1 FROM weekly_consent_offers WHERE user_id = ? AND decision IS NULL AND expires_at_ms > ?)
      AND (? = 'requested' OR NOT EXISTS (SELECT 1 FROM weekly_consent_rejections WHERE user_id = ?))`,
        params: [
          id,
          input.userId,
          input.caller.businessPortfolioId,
          input.caller.businessScopedUserId,
          json,
          now,
          now + (input.request._tag === "GovernorQuestion" ? dailyWindowMs : offerLifetimeMs),
          input.request._tag === "GovernorQuestion" ? input.request.sourceId : "",
          input.userId,
          input.userId,
          now - dailyWindowMs,
          input.userId,
          now,
          input.request.origin,
          input.userId,
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
      privacyChannelAction(input, {
        sql: `UPDATE weekly_consent_offers SET disclosure_message_id = ?, disclosed_at_ms = ? WHERE id = ? AND user_id = ? AND portfolio_id = ? AND bsuid = ? AND disclosure_message_id IS NULL AND decision IS NULL`,
        params: [
          message,
          input.now.epochMilliseconds,
          id,
          input.userId,
          input.caller.businessPortfolioId,
          input.caller.businessScopedUserId,
        ],
      }).run()
    );
    return result.meta.changes === 1;
  }).pipe(Effect.mapError(() => new ConsentUnavailable()));

/** Privacy control receipts are independent of provider availability and do not authorize sending. */
export const hasChoiceReceipt = (
  input: WeeklyConsentContext & Readonly<{ choice: string; decisionMessageId: string }>
): Effect.Effect<boolean, ConsentUnavailable> =>
  Effect.gen(function* () {
    const choice = Schema.decodeUnknownOption(Choice)(input.choice.split(":"));
    if (Option.isNone(choice)) return false;
    const raw = yield* Effect.tryPromise(() =>
      privacyChannelAction(input, {
        sql: `SELECT 1 FROM weekly_consent_offers AS o WHERE o.user_id=? AND o.id=? AND o.disclosure_message_id IS NOT NULL AND ((o.decision_message_id=? AND o.decision=?) OR EXISTS (SELECT 1 FROM weekly_consent_revocation_records AS r WHERE r.user_id=o.user_id AND r.offer_id=o.id AND r.decision_message_id=? AND r.decision=?) OR (? <> 'accept' AND EXISTS (SELECT 1 FROM weekly_consent_rejections WHERE user_id=o.user_id) AND NOT EXISTS (${liveGrant})))`,
        params: [
          input.userId,
          choice.value[1],
          input.decisionMessageId,
          choice.value[2],
          input.decisionMessageId,
          choice.value[2],
          choice.value[2],
          input.userId,
        ],
      }).first()
    );
    return raw !== null;
  }).pipe(Effect.mapError(() => new ConsentUnavailable()));

const findDecisionOffer = (
  input: WeeklyConsentContext,
  id: ConsentRecordId,
  decision: Choice[2]
): Effect.Effect<Option.Option<OfferRow>, ConsentUnavailable> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          "SELECT id,disclosure_json,disclosure_message_id,decision_message_id,expires_at_ms FROM weekly_consent_offers WHERE id = ? AND user_id = ? AND (? <> 'accept' OR (portfolio_id = ? AND bsuid = ?))"
        )
        .bind(
          id,
          input.userId,
          decision,
          input.caller.businessPortfolioId,
          input.caller.businessScopedUserId
        )
        .first()
    );
    if (raw === null) return Option.none();
    const offer = yield* Schema.decodeUnknownEffect(OfferRow)(raw);
    if (
      offer.disclosure_message_id === null ||
      (decision === "accept" &&
        (offer.decision_message_id !== null || offer.expires_at_ms <= input.now.epochMilliseconds))
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
  (choice[2] === "accept" ? channelAction : privacyChannelAction)(input, {
    sql: `UPDATE weekly_consent_offers SET decision_message_id = ?, decision = ? WHERE id = ? AND user_id = ? AND (? <> 'accept' OR (portfolio_id = ? AND bsuid = ?)) AND disclosure_message_id IS NOT NULL AND decision IS NULL AND (? <> 'accept' OR (expires_at_ms > ? AND rejection_id IS (SELECT id FROM weekly_consent_rejections WHERE user_id=? ORDER BY sequence DESC LIMIT 1)))`,
    params: [
      message,
      choice[2],
      choice[1],
      input.userId,
      choice[2],
      input.caller.businessPortfolioId,
      input.caller.businessScopedUserId,
      choice[2],
      input.now.epochMilliseconds,
      input.userId,
    ],
  });

const revocationAuthorization = (
  input: WeeklyConsentContext,
  {
    offer,
    message,
    grantId,
  }: Readonly<{ offer: OfferRow; message: WhatsAppProviderMessageId; grantId: ConsentRecordId }>
): D1PreparedStatement =>
  privacyChannelAction(input, {
    sql: `UPDATE weekly_consent_offers SET decision_message_id=decision_message_id WHERE id=? AND user_id=? AND disclosure_message_id IS NOT NULL AND EXISTS (${liveGrant} AND g.id=?) AND NOT EXISTS (SELECT 1 FROM weekly_consent_offers WHERE user_id=? AND decision_message_id=?)`,
    params: [offer.id, input.userId, input.userId, grantId, input.userId, message],
  });
const rejectionStatement = (
  input: WeeklyConsentContext,
  {
    id,
    offerId,
    message,
    decision,
  }: Readonly<{
    id: ConsentRecordId;
    offerId: ConsentRecordId;
    message: WhatsAppProviderMessageId;
    decision: "decline" | "revoke";
  }>
): D1PreparedStatement =>
  input.db
    .prepare(
      "INSERT INTO weekly_consent_rejections(id,user_id,offer_id,decision_message_id,decision) SELECT ?,?,?,?,? WHERE changes()=1"
    )
    .bind(id, input.userId, offerId, message, decision);

const decisionAssertion = (db: D1Database): D1PreparedStatement =>
  db.prepare(
    "INSERT INTO weekly_consent_assertion (id,accepted) VALUES (1,CASE WHEN changes() = 1 THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted"
  );

const prepareRecord = (
  input: WeeklyConsentContext,
  evidence: Readonly<{ offer: OfferRow; message: WhatsAppProviderMessageId; decision: Choice[2] }>,
  grantId: Option.Option<ConsentRecordId>
): Effect.Effect<
  Readonly<{ id: ConsentRecordId; statement: D1PreparedStatement }>,
  ConsentUnavailable
> =>
  Effect.gen(function* () {
    const { offer, message, decision } = evidence;
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
    const statement = Option.isSome(grantId)
      ? input.db
          .prepare(
            "INSERT INTO weekly_consent_revocation_records(id,user_id,grant_id,offer_id,record_json,occurred_at_ms,decision_message_id,decision) SELECT ?,?,?,?,?,?,?,? WHERE changes()=1"
          )
          .bind(
            id,
            input.userId,
            grantId.value,
            offer.id,
            json,
            input.now.epochMilliseconds,
            message,
            decision
          )
      : input.db
          .prepare(
            "INSERT INTO weekly_consent_records(id,user_id,grant_id,offer_id,record_json,occurred_at_ms) SELECT ?,?,NULL,?,?,? WHERE changes()=1"
          )
          .bind(id, input.userId, offer.id, json, input.now.epochMilliseconds);
    return { id, statement };
  }).pipe(Effect.mapError(() => new ConsentUnavailable()));

const grantConflict = (decision: Choice[2], grant: Option.Option<ConsentRecord>): boolean =>
  decision === "revoke" && Option.isNone(grant);

const effectiveDecision = (
  decision: Choice[2],
  grant: Option.Option<ConsentRecord>
): PreparedWeeklyConsentDecision["decision"] => {
  if (decision === "accept" && Option.isSome(grant)) return "continue";
  if (decision === "decline" && Option.isSome(grant)) return "revoke";
  return decision;
};

export const prepareDecision = (
  input: WeeklyConsentContext & Readonly<{ choice: string; decisionMessageId: string }>
): Effect.Effect<Option.Option<PreparedWeeklyConsentDecision>, ConsentUnavailable> =>
  Effect.gen(function* () {
    const choice = Schema.decodeUnknownOption(Choice)(input.choice.split(":"));
    if (Option.isNone(choice)) return Option.none();
    const offer = yield* findDecisionOffer(input, choice.value[1], choice.value[2]);
    if (Option.isNone(offer)) return Option.none();
    const grant = yield* findGrant(input);
    const decision = choice.value[2];
    if (grantConflict(decision, grant)) return Option.none();
    const message = yield* Schema.decodeEffect(WhatsAppProviderMessageId)(input.decisionMessageId);
    const effective = effectiveDecision(decision, grant);
    if (offer.value.decision_message_id !== null && effective !== "revoke") return Option.none();
    return yield* prepareAppliedDecision(input, {
      offer: offer.value,
      choice: choice.value,
      message,
      grant,
      effective,
    });
  }).pipe(Effect.mapError(() => new ConsentUnavailable()));

const authorizationStatement = (
  input: WeeklyConsentContext,
  evidence: Readonly<{
    offer: OfferRow;
    choice: Choice;
    message: WhatsAppProviderMessageId;
    grant: Option.Option<ConsentRecord>;
  }>
): D1PreparedStatement => {
  if (evidence.offer.decision_message_id !== null && Option.isSome(evidence.grant)) {
    return revocationAuthorization(input, {
      offer: evidence.offer,
      message: evidence.message,
      grantId: evidence.grant.value.id,
    });
  }
  return decisionUpdate(input, evidence.choice, evidence.message);
};
const recordRejectionStatements = (
  input: WeeklyConsentContext,
  evidence: Readonly<{
    effective: PreparedWeeklyConsentDecision["decision"];
    recordId: ConsentRecordId;
    offerId: ConsentRecordId;
    message: WhatsAppProviderMessageId;
    decision: Choice[2];
  }>
): ReadonlyArray<D1PreparedStatement> =>
  evidence.effective === "revoke"
    ? [
        rejectionStatement(input, {
          id: evidence.recordId,
          offerId: evidence.offerId,
          message: evidence.message,
          decision: evidence.decision === "decline" ? "decline" : "revoke",
        }),
      ]
    : [];

const prepareAppliedDecision = (
  input: WeeklyConsentContext,
  evidence: Readonly<{
    offer: OfferRow;
    choice: Choice;
    message: WhatsAppProviderMessageId;
    grant: Option.Option<ConsentRecord>;
    effective: PreparedWeeklyConsentDecision["decision"];
  }>
): Effect.Effect<Option.Option<PreparedWeeklyConsentDecision>, ConsentUnavailable> =>
  Effect.gen(function* () {
    const { offer, choice, message, grant, effective } = evidence;
    const decision = choice[2];
    const statements = [authorizationStatement(input, evidence)];
    if (effective === "continue") {
      return Option.some<PreparedWeeklyConsentDecision>({
        decision: "continue",
        grantId: Option.map(grant, (record) => record.id),
        statements: [...statements, decisionAssertion(input.db)],
      });
    }
    if (effective === "decline") {
      return Option.some<PreparedWeeklyConsentDecision>({
        decision,
        grantId: Option.none(),
        statements: [
          ...statements,
          rejectionStatement(input, {
            id: offer.id,
            offerId: offer.id,
            message,
            decision: "decline",
          }),
          decisionAssertion(input.db),
        ],
      });
    }
    const revokedId =
      effective === "revoke"
        ? Option.map(grant, (record) => record.id)
        : Option.none<ConsentRecordId>();
    const record = yield* prepareRecord(input, { offer, message, decision }, revokedId);
    return Option.some<PreparedWeeklyConsentDecision>({
      decision: effective,
      grantId: effective === "accept" ? Option.some(record.id) : revokedId,
      statements: [
        ...statements,
        record.statement,
        ...recordRejectionStatements(input, {
          effective,
          recordId: record.id,
          offerId: offer.id,
          message,
          decision,
        }),
        decisionAssertion(input.db),
      ],
    });
  }).pipe(Effect.mapError(() => new ConsentUnavailable()));
