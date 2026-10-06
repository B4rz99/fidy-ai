import { DateTime, Effect, Option, Schema } from "effect";
import {
  ConsentRecord,
  ConsentRecordId,
  DisclosureSnapshot,
} from "../../../src/core/consent/contract";
import { UserId, WhatsAppCallerReference } from "../../../src/core/identity/contract";
import { WhatsAppProviderMessageId } from "../../../src/core/provider-evidence/contract";
import { ProactivityOptInKind } from "../../../src/shell/consent/contract";
import {
  proactivityDisclosureFor,
  protectConsentStatement,
} from "../../../src/shell/consent/operations";
import { whatsAppAssociationQuery } from "../../../src/shell/identity/operations";
import { newId } from "../../secret-material/operations";
import {
  ConsentUnavailable,
  type PreparedProactivityConsentDecision,
  type ProactivityConsentAction,
  type ProactivityConsentContext,
  type ProactivityConsentOffer,
} from "../contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";

const offerLifetimeMs = 600_000;
const elapsedDayMs = 86_400_000;
const maximumDailyOffers = 8;
const maximumExpiredOffers = 64;

export const sweepOffers = (
  input: Readonly<{ db: D1Database; nowEpochMs: number }>
): Effect.Effect<void, ConsentUnavailable> =>
  Effect.tryPromise({
    try: () =>
      input.db
        .prepare(
          `DELETE FROM proactivity_consent_offers WHERE id IN (
 SELECT o.id FROM proactivity_consent_offers AS o WHERE o.decision IS NULL AND o.expires_at_ms<=?
 AND NOT EXISTS (SELECT 1 FROM proactivity_consent_records AS r WHERE r.offer_id=o.id)
 ORDER BY o.expires_at_ms,o.id LIMIT ?)`
        )
        .bind(input.nowEpochMs - elapsedDayMs, maximumExpiredOffers)
        .run(),
    catch: () => new ConsentUnavailable(),
  }).pipe(Effect.asVoid);
const ChannelContext = Schema.Struct({
  userId: UserId,
  caller: WhatsAppCallerReference,
  kind: ProactivityOptInKind,
});
const Choice = Schema.Tuple([
  Schema.Literal("proactivity"),
  ProactivityOptInKind,
  ConsentRecordId,
  Schema.Literals(["accept", "decline", "revoke"]),
]);
export const choiceKind = (choice: string): Option.Option<ProactivityOptInKind> =>
  Option.map(Schema.decodeUnknownOption(Choice)(choice.split(":")), (decoded) => decoded[1]);

export const hasChoiceReceipt = (
  input: ProactivityConsentContext & Readonly<{ choice: string; decisionMessageId: string }>
): Effect.Effect<boolean, ConsentUnavailable> =>
  Effect.gen(function* () {
    const choice = Schema.decodeUnknownOption(Choice)(input.choice.split(":"));
    if (Option.isNone(choice) || choice.value[1] !== input.kind) return false;
    const raw = yield* Effect.tryPromise(() =>
      channelAction(
        input,
        {
          sql: `SELECT 1 FROM proactivity_consent_offers AS o WHERE o.user_id=? AND o.kind=? AND o.id=? AND o.disclosure_message_id IS NOT NULL AND ((o.decision_message_id=? AND o.decision=?) OR (?='revoke' AND EXISTS (SELECT 1 FROM proactivity_consent_records AS r WHERE r.user_id=o.user_id AND r.kind=o.kind AND r.offer_id=o.id AND r.decision_message_id=? AND r.grant_id IS NOT NULL)))`,
          params: [
            input.userId,
            input.kind,
            choice.value[2],
            input.decisionMessageId,
            choice.value[3],
            choice.value[3],
            input.decisionMessageId,
          ],
        },
        true
      ).first()
    );
    return raw !== null;
  }).pipe(Effect.mapError(() => new ConsentUnavailable()));

const OfferRow = Schema.Struct({
  id: ConsentRecordId,
  disclosure_json: Schema.fromJsonString(Schema.toCodecJson(DisclosureSnapshot)),
  disclosure_message_id: Schema.NullOr(WhatsAppProviderMessageId),
  decision_message_id: Schema.NullOr(WhatsAppProviderMessageId),
  expires_at_ms: Schema.Int,
});
const liveGrant = `SELECT g.id FROM proactivity_consent_records AS g WHERE g.user_id=? AND g.kind=? AND g.grant_id IS NULL
 AND NOT EXISTS (SELECT 1 FROM proactivity_consent_records AS r WHERE r.user_id=g.user_id AND r.kind=g.kind AND r.grant_id=g.id)`;

/** Atomic historical eligibility capture; the caller receives only the current grant identity. */
export const currentGrantQuery = (
  input: Readonly<{ userId: UserId; kind: ProactivityOptInKind }>
): OwnedStatement =>
  protectConsentStatement({
    subject: { _tag: "User", userId: input.userId },
    requirement: "active",
    statement: { sql: liveGrant, params: [input.userId, input.kind] },
  });

export const guardedAction = (input: ProactivityConsentAction): D1PreparedStatement => {
  const guarded = protectConsentStatement({
    subject: { _tag: "User", userId: input.userId },
    requirement: "active",
    statement: {
      sql: `${input.statement.sql} AND EXISTS (${liveGrant} AND g.id=?)`,
      params: [...input.statement.params, input.userId, input.kind, input.grantId],
    },
  });
  return input.db.prepare(guarded.sql).bind(...guarded.params);
};

const channelAction = (
  input: ProactivityConsentContext,
  statement: OwnedStatement,
  privacy: boolean
): D1PreparedStatement => {
  const context = Schema.decodeSync(ChannelContext)(input);
  const association = whatsAppAssociationQuery(context);
  const channel = {
    sql: `${statement.sql} AND EXISTS (${association.sql})`,
    params: [...statement.params, ...association.params],
  };
  const guarded = privacy
    ? channel
    : protectConsentStatement({
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement: channel,
      });
  return input.db.prepare(guarded.sql).bind(...guarded.params);
};
const assertion = (db: D1Database): D1PreparedStatement =>
  db.prepare(
    "INSERT INTO proactivity_consent_assertion(id,accepted) VALUES (1,CASE WHEN changes()=1 THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET accepted=excluded.accepted"
  );

export const createOffer = (
  input: ProactivityConsentContext
): Effect.Effect<Option.Option<ProactivityConsentOffer>, ConsentUnavailable> =>
  Effect.gen(function* () {
    const disclosure = proactivityDisclosureFor(input.kind);
    const json = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(DisclosureSnapshot))
    )(disclosure);
    const id = ConsentRecordId.make(newId());
    const result = yield* Effect.tryPromise(() =>
      channelAction(
        input,
        {
          sql: `INSERT INTO proactivity_consent_offers(id,user_id,kind,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms)
 SELECT ?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM proactivity_consent_offers WHERE user_id=? AND created_at_ms>?) < ?
 AND NOT EXISTS (SELECT 1 FROM proactivity_consent_offers WHERE user_id=? AND kind=? AND decision IS NULL AND expires_at_ms>?)`,
          params: [
            id,
            input.userId,
            input.kind,
            input.caller.businessPortfolioId,
            input.caller.businessScopedUserId,
            json,
            input.now.epochMilliseconds,
            input.now.epochMilliseconds + offerLifetimeMs,
            input.userId,
            input.now.epochMilliseconds - elapsedDayMs,
            maximumDailyOffers,
            input.userId,
            input.kind,
            input.now.epochMilliseconds,
          ],
        },
        false
      ).run()
    );
    if (result.meta.changes !== 1) return Option.none();
    const prefix = `proactivity:${input.kind}:${id}`;
    return Option.some({
      id,
      disclosure,
      expiresAt: DateTime.makeUnsafe(input.now.epochMilliseconds + offerLifetimeMs),
      acceptChoice: `${prefix}:accept`,
      declineChoice: `${prefix}:decline`,
      revokeChoice: `${prefix}:revoke`,
    });
  }).pipe(Effect.mapError(() => new ConsentUnavailable()));

/** Reuse an unexpired exact category offer after a lost materialization acknowledgement. */
export const findCurrentOffer = (
  input: ProactivityConsentContext
): Effect.Effect<Option.Option<ProactivityConsentOffer>, ConsentUnavailable> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      channelAction(
        input,
        {
          sql: "SELECT id,disclosure_json,expires_at_ms FROM proactivity_consent_offers WHERE user_id=? AND kind=? AND portfolio_id=? AND bsuid=? AND decision IS NULL AND expires_at_ms>?",
          params: [
            input.userId,
            input.kind,
            input.caller.businessPortfolioId,
            input.caller.businessScopedUserId,
            input.now.epochMilliseconds,
          ],
        },
        false
      ).first()
    );
    if (raw === null) return Option.none();
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        expires_at_ms: Schema.DateTimeUtcFromMillis,
        id: ConsentRecordId,
        disclosure_json: Schema.fromJsonString(Schema.toCodecJson(DisclosureSnapshot)),
      })
    )(raw);
    const prefix = `proactivity:${input.kind}:${row.id}`;
    return Option.some({
      id: row.id,
      expiresAt: row.expires_at_ms,
      disclosure: row.disclosure_json,
      acceptChoice: `${prefix}:accept`,
      declineChoice: `${prefix}:decline`,
      revokeChoice: `${prefix}:revoke`,
    });
  }).pipe(Effect.mapError(() => new ConsentUnavailable()));

export const prepareVerifiedDisclosure = (
  input: Readonly<{ db: D1Database; userId: UserId; id: string; proof: OwnedStatement }>
): D1PreparedStatement =>
  input.db
    .prepare(
      `UPDATE proactivity_consent_offers SET disclosure_message_id=(SELECT v.provider_message_id FROM (${input.proof.sql}) AS v WHERE v.user_id=? AND v.delivery_id=?) WHERE user_id=? AND id=? AND disclosure_message_id IS NULL AND decision IS NULL AND EXISTS (SELECT 1 FROM (${input.proof.sql}) AS v WHERE v.user_id=? AND v.delivery_id=? AND ((kind='budget-threshold' AND v.role='budget-offer') OR (kind='manual-entry-reminder' AND v.role='reminder-offer')))`
    )
    .bind(
      ...input.proof.params,
      input.userId,
      input.id,
      input.userId,
      input.id,
      ...input.proof.params,
      input.userId,
      input.id
    );

export const discloseOffer = (
  input: ProactivityConsentContext &
    Readonly<{ offerId: ConsentRecordId; disclosureMessageId: string }>
): Effect.Effect<boolean, ConsentUnavailable> =>
  Effect.gen(function* () {
    const message = yield* Schema.decodeEffect(WhatsAppProviderMessageId)(
      input.disclosureMessageId
    );
    const result = yield* Effect.tryPromise(() =>
      channelAction(
        input,
        {
          sql: "UPDATE proactivity_consent_offers SET disclosure_message_id=? WHERE user_id=? AND kind=? AND id=? AND portfolio_id=? AND bsuid=? AND disclosure_message_id IS NULL AND decision IS NULL",
          params: [
            message,
            input.userId,
            input.kind,
            input.offerId,
            input.caller.businessPortfolioId,
            input.caller.businessScopedUserId,
          ],
        },
        true
      ).run()
    );
    return result.meta.changes === 1;
  }).pipe(Effect.mapError(() => new ConsentUnavailable()));

export const findGrant = (
  input: Readonly<{ db: D1Database; userId: UserId; kind: ProactivityOptInKind }>
): Effect.Effect<Option.Option<ConsentRecord>, ConsentUnavailable> =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          `SELECT id,record_json FROM proactivity_consent_records WHERE id IN (${liveGrant}) LIMIT 2`
        )
        .bind(input.userId, input.kind)
        .all()
    );
    if (rows.results.length === 0) return Option.none();
    if (rows.results.length !== 1) return yield* new ConsentUnavailable();
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        id: ConsentRecordId,
        record_json: Schema.fromJsonString(Schema.toCodecJson(ConsentRecord)),
      })
    )(rows.results[0]);
    const record = row.record_json;
    if (
      record.id !== row.id ||
      record.subjectUserId !== input.userId ||
      record.event._tag !== "Granted" ||
      record.event.grant._tag !== "InsightDelivery" ||
      record.event.grant.insightKind !== input.kind
    ) {
      return yield* new ConsentUnavailable();
    }
    return Option.some(record);
  }).pipe(Effect.mapError(() => new ConsentUnavailable()));

type DecisionInput = ProactivityConsentContext &
  Readonly<{ choice: string; decisionMessageId: string }>;
type PreparedChoice = Readonly<{
  offer: typeof OfferRow.Type;
  choice: typeof Choice.Type;
  message: WhatsAppProviderMessageId;
  grant: Option.Option<ConsentRecord>;
}>;
const canUseOffer = (
  offer: Readonly<typeof OfferRow.Type>,
  decision: (typeof Choice.Type)[3],
  now: number
): boolean => {
  if (offer.disclosure_message_id === null) return false;
  if (decision === "accept") return offer.decision_message_id === null && offer.expires_at_ms > now;
  return decision === "revoke" || offer.decision_message_id === null;
};

const readChoice = (
  input: DecisionInput
): Effect.Effect<Option.Option<PreparedChoice>, ConsentUnavailable> =>
  Effect.gen(function* () {
    const choice = Schema.decodeUnknownOption(Choice)(input.choice.split(":"));
    if (Option.isNone(choice) || choice.value[1] !== input.kind) return Option.none();
    const message = yield* Schema.decodeEffect(WhatsAppProviderMessageId)(input.decisionMessageId);
    const raw = yield* Effect.tryPromise(() =>
      channelAction(
        input,
        {
          sql: "SELECT id,disclosure_json,disclosure_message_id,decision_message_id,expires_at_ms FROM proactivity_consent_offers WHERE user_id=? AND kind=? AND id=?",
          params: [input.userId, input.kind, choice.value[2]],
        },
        true
      ).first()
    );
    if (raw === null) return Option.none();
    const offer = yield* Schema.decodeUnknownEffect(OfferRow)(raw);
    if (!canUseOffer(offer, choice.value[3], input.now.epochMilliseconds)) return Option.none();
    const grant = yield* findGrant(input);
    if (choice.value[3] === "revoke" && Option.isNone(grant)) return Option.none();
    return Option.some({ offer, choice: choice.value, message, grant });
  }).pipe(Effect.mapError(() => new ConsentUnavailable()));

const acceptChoiceAction = (
  input: DecisionInput,
  evidence: PreparedChoice
): D1PreparedStatement => {
  const grantGuard = Option.match(evidence.grant, {
    onNone: () => ({ sql: `NOT EXISTS (${liveGrant})`, params: [input.userId, input.kind] }),
    onSome: (grant) => ({
      sql: `EXISTS (${liveGrant} AND g.id=?)`,
      params: [input.userId, input.kind, grant.id],
    }),
  });
  return channelAction(
    input,
    {
      sql: `UPDATE proactivity_consent_offers SET decision='accept',decision_message_id=? WHERE user_id=? AND kind=? AND id=? AND decision IS NULL AND disclosure_message_id IS NOT NULL AND portfolio_id=? AND bsuid=? AND expires_at_ms>? AND ${grantGuard.sql}`,
      params: [
        evidence.message,
        input.userId,
        input.kind,
        evidence.offer.id,
        input.caller.businessPortfolioId,
        input.caller.businessScopedUserId,
        input.now.epochMilliseconds,
        ...grantGuard.params,
      ],
    },
    false
  );
};

const authorizeChoice = (input: DecisionInput, evidence: PreparedChoice): D1PreparedStatement => {
  const decision = evidence.choice[3];
  if (decision === "accept") return acceptChoiceAction(input, evidence);
  if (
    decision === "revoke" &&
    evidence.offer.decision_message_id !== null &&
    Option.isSome(evidence.grant)
  ) {
    return channelAction(
      input,
      {
        sql: `UPDATE proactivity_consent_offers SET decision=decision WHERE user_id=? AND kind=? AND id=? AND disclosure_message_id IS NOT NULL
 AND EXISTS (${liveGrant} AND g.id=?) AND NOT EXISTS (SELECT 1 FROM proactivity_consent_records WHERE decision_message_id=?)`,
        params: [
          input.userId,
          input.kind,
          evidence.offer.id,
          input.userId,
          input.kind,
          evidence.grant.value.id,
          evidence.message,
        ],
      },
      true
    );
  }
  return channelAction(
    input,
    {
      sql: "UPDATE proactivity_consent_offers SET decision=?,decision_message_id=? WHERE user_id=? AND kind=? AND id=? AND decision IS NULL AND disclosure_message_id IS NOT NULL AND (?<>'accept' OR (portfolio_id=? AND bsuid=? AND expires_at_ms>?))",
      params: [
        decision,
        evidence.message,
        input.userId,
        input.kind,
        evidence.offer.id,
        decision,
        input.caller.businessPortfolioId,
        input.caller.businessScopedUserId,
        input.now.epochMilliseconds,
      ],
    },
    true
  );
};

const prepareRecord = (
  input: DecisionInput,
  evidence: PreparedChoice,
  event: ConsentRecord["event"]
): Effect.Effect<
  Readonly<{ id: ConsentRecordId; statement: D1PreparedStatement }>,
  ConsentUnavailable
> =>
  Effect.gen(function* () {
    if (evidence.offer.disclosure_message_id === null) return yield* new ConsentUnavailable();
    const id = ConsentRecordId.make(newId());
    const grantId =
      event._tag === "Revoked" ? Option.some(event.grantId) : Option.none<ConsentRecordId>();
    const record = ConsentRecord.make({
      id,
      subjectUserId: input.userId,
      disclosure: evidence.offer.disclosure_json,
      occurredAt: input.now,
      event,
      evidence: {
        _tag: "ProviderQualifiedMessages",
        disclosureMessage: {
          channel: "whatsapp",
          provider: "kapso",
          providerMessageId: evidence.offer.disclosure_message_id,
        },
        decisionMessage: {
          channel: "whatsapp",
          provider: "kapso",
          providerMessageId: evidence.message,
        },
      },
    });
    const json = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(ConsentRecord))
    )(record);
    const statement = input.db
      .prepare(
        "INSERT INTO proactivity_consent_records(id,user_id,kind,grant_id,offer_id,decision_message_id,record_json,occurred_at_ms) SELECT ?,?,?,?,?,?,?,? WHERE changes()=1"
      )
      .bind(
        id,
        input.userId,
        input.kind,
        Option.getOrNull(grantId),
        evidence.offer.id,
        evidence.message,
        json,
        input.now.epochMilliseconds
      );
    return { id, statement };
  }).pipe(Effect.mapError(() => new ConsentUnavailable()));

export const prepareDecision = (
  input: DecisionInput
): Effect.Effect<Option.Option<PreparedProactivityConsentDecision>, ConsentUnavailable> =>
  Effect.gen(function* () {
    const evidence = yield* readChoice(input);
    if (Option.isNone(evidence)) return Option.none();
    const { choice, grant } = evidence.value;
    const common = { kind: input.kind, statements: [authorizeChoice(input, evidence.value)] };
    if (choice[3] === "accept") {
      if (Option.isSome(grant)) {
        return Option.some<PreparedProactivityConsentDecision>({
          ...common,
          decision: "continue",
          grantId: grant.value.id,
          statements: [...common.statements, assertion(input.db)],
        });
      }
      const record = yield* prepareRecord(input, evidence.value, {
        _tag: "Granted",
        grant: { _tag: "InsightDelivery", insightKind: input.kind },
      });
      return Option.some<PreparedProactivityConsentDecision>({
        ...common,
        decision: "accept",
        grantId: record.id,
        statements: [...common.statements, record.statement, assertion(input.db)],
      });
    }
    if (Option.isNone(grant)) {
      return Option.some<PreparedProactivityConsentDecision>({
        ...common,
        decision: "decline",
        statements: [...common.statements, assertion(input.db)],
      });
    }
    const record = yield* prepareRecord(input, evidence.value, {
      _tag: "Revoked",
      grantId: grant.value.id,
    });
    return Option.some<PreparedProactivityConsentDecision>({
      ...common,
      decision: "revoke",
      grantId: grant.value.id,
      statements: [...common.statements, record.statement, assertion(input.db)],
    });
  }).pipe(Effect.mapError(() => new ConsentUnavailable()));
