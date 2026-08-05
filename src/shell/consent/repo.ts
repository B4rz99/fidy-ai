import { Crypto, DateTime, Effect, Option, Schema, SchemaTransformation } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { ProviderMessageEvidence } from "~/core/_shared/provider-message-evidence";
import {
  ConsentEvent,
  ConsentRecord,
  ConsentRecordId,
  DisclosureSnapshot,
  PendingConsentExchange,
  PendingConsentExchangeId,
  PolicySnapshot,
} from "~/core/consent/model";
import {
  UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
  WhatsAppCallerReference,
} from "~/core/identity/reference";
import { InsightKind } from "~/core/insights/reference";
import { AgentTokenId } from "~/core/tokens/reference";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { currentDisclosure } from "./current-disclosure";
const OptionalAgentTokenId = Schema.OptionFromNullOr(Schema.toEncoded(AgentTokenId));
const OptionalConsentRecordId = Schema.OptionFromNullOr(Schema.toEncoded(ConsentRecordId));
const OptionalInsightKind = Schema.OptionFromNullOr(InsightKind);
const OptionalMessageChannel = Schema.OptionFromNullOr(ProviderMessageEvidence.fields.channel);
const OptionalMessageProvider = Schema.OptionFromNullOr(ProviderMessageEvidence.fields.provider);
const OptionalMessageId = Schema.OptionFromNullOr(ProviderMessageEvidence.fields.providerMessageId);
const OptionalUtcDate = Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate);
const StoredGrantType = Schema.Literals(["onboarding", "agent-token", "insight-delivery"]);
type StoredGrantType = typeof StoredGrantType.Type;

const DisclosureRowFields = {
  serviceMarket: DisclosureSnapshot.fields.serviceMarket,
  locale: DisclosureSnapshot.fields.locale,
  disclosureRevision: Schema.toEncoded(DisclosureSnapshot.fields.revision),
  disclosureSha256: Schema.toEncoded(DisclosureSnapshot.fields.contentSha256),
  disclosureText: DisclosureSnapshot.fields.text,
  policyUrl: Schema.toEncoded(PolicySnapshot.fields.publicUrl),
  policyRevision: Schema.toEncoded(PolicySnapshot.fields.revision),
  policySha256: Schema.toEncoded(PolicySnapshot.fields.contentSha256),
  purposes: DisclosureSnapshot.fields.purposes,
  dataCategories: DisclosureSnapshot.fields.dataCategories,
  duration: DisclosureSnapshot.fields.duration,
  revocationMethod: DisclosureSnapshot.fields.revocationMethod,
} as const;
const DisclosureRow = Schema.Struct(DisclosureRowFields);
type DisclosureRow = typeof DisclosureRow.Type;

const ConsentRecordRow = Schema.Struct({
  id: Schema.toEncoded(ConsentRecordId),
  subjectUserId: Schema.toEncoded(UserId),
  eventType: Schema.Literals(["granted", "revoked"]),
  grantType: Schema.OptionFromNullOr(StoredGrantType),
  agentTokenId: OptionalAgentTokenId,
  insightKind: OptionalInsightKind,
  revokedGrantId: OptionalConsentRecordId,
  ...DisclosureRowFields,
  disclosureChannel: ProviderMessageEvidence.fields.channel,
  disclosureProvider: ProviderMessageEvidence.fields.provider,
  disclosureProviderMessageId: ProviderMessageEvidence.fields.providerMessageId,
  decisionChannel: ProviderMessageEvidence.fields.channel,
  decisionProvider: ProviderMessageEvidence.fields.provider,
  decisionProviderMessageId: ProviderMessageEvidence.fields.providerMessageId,
  occurredAt: Schema.DateTimeUtcFromDate,
});
type ConsentRecordRow = typeof ConsentRecordRow.Type;

const consentColumns = `id, subject_user_id AS "subjectUserId", event_type AS "eventType",
  grant_type AS "grantType", agent_token_id AS "agentTokenId", insight_kind AS "insightKind",
  revoked_grant_id AS "revokedGrantId", service_market AS "serviceMarket", locale,
  disclosure_revision AS "disclosureRevision", disclosure_sha256 AS "disclosureSha256",
  disclosure_text AS "disclosureText", policy_url AS "policyUrl",
  policy_revision AS "policyRevision", policy_sha256 AS "policySha256", purposes,
  data_categories AS "dataCategories", duration, revocation_method AS "revocationMethod",
  disclosure_channel AS "disclosureChannel", disclosure_provider AS "disclosureProvider",
  disclosure_provider_message_id AS "disclosureProviderMessageId",
  decision_channel AS "decisionChannel", decision_provider AS "decisionProvider",
  decision_provider_message_id AS "decisionProviderMessageId", occurred_at AS "occurredAt"`;

const disclosureFromRow = (row: DisclosureRow) => ({
  serviceMarket: row.serviceMarket,
  locale: row.locale,
  revision: row.disclosureRevision,
  contentSha256: row.disclosureSha256,
  text: row.disclosureText,
  policy: {
    publicUrl: row.policyUrl,
    revision: row.policyRevision,
    contentSha256: row.policySha256,
  },
  purposes: row.purposes,
  dataCategories: row.dataCategories,
  duration: row.duration,
  revocationMethod: row.revocationMethod,
});

const disclosureToRow = (disclosure: typeof DisclosureSnapshot.Encoded) => ({
  serviceMarket: disclosure.serviceMarket,
  locale: disclosure.locale,
  disclosureRevision: disclosure.revision,
  disclosureSha256: disclosure.contentSha256,
  disclosureText: disclosure.text,
  policyUrl: disclosure.policy.publicUrl,
  policyRevision: disclosure.policy.revision,
  policySha256: disclosure.policy.contentSha256,
  purposes: disclosure.purposes,
  dataCategories: disclosure.dataCategories,
  duration: disclosure.duration,
  revocationMethod: disclosure.revocationMethod,
});

const decodeConsentEvent = Schema.decodeUnknownSync(Schema.toEncoded(ConsentEvent));
const decodeConsentRecord = Schema.decodeUnknownSync(Schema.toEncoded(ConsentRecord));
const decodePendingExchange = Schema.decodeUnknownSync(Schema.toEncoded(PendingConsentExchange));
const utcFromIso = (value: string): DateTime.Utc => DateTime.toUtc(DateTime.makeUnsafe(value));

const grantsFromRow: Record<StoredGrantType, (row: ConsentRecordRow) => unknown> = {
  onboarding: () => ({ _tag: "Onboarding" }),
  "agent-token": (row) =>
    Option.match(row.agentTokenId, {
      onNone: () => ({ _tag: "AgentToken" }),
      onSome: (tokenId) => ({ _tag: "AgentToken", tokenId }),
    }),
  "insight-delivery": (row) =>
    Option.match(row.insightKind, {
      onNone: () => ({ _tag: "InsightDelivery" }),
      onSome: (insightKind) => ({ _tag: "InsightDelivery", insightKind }),
    }),
};

const eventFromRow = (row: ConsentRecordRow) => {
  if (row.eventType === "revoked") {
    const event = Option.match(row.revokedGrantId, {
      onNone: () => ({ _tag: "Revoked" }),
      onSome: (grantId) => ({ _tag: "Revoked", grantId }),
    });
    return decodeConsentEvent(event);
  }
  const grant = Option.match(row.grantType, {
    onNone: () => ({}),
    onSome: (grantType) => grantsFromRow[grantType](row),
  });
  return decodeConsentEvent({ _tag: "Granted", grant });
};

const eventToRow = (event: typeof ConsentEvent.Encoded) => {
  if (event._tag === "Revoked") {
    return {
      eventType: "revoked" as const,
      grantType: Option.none(),
      agentTokenId: Option.none(),
      insightKind: Option.none(),
      revokedGrantId: Option.some(event.grantId),
    };
  }
  if (event.grant._tag === "Onboarding") {
    return {
      eventType: "granted" as const,
      grantType: Option.some("onboarding" as const),
      agentTokenId: Option.none(),
      insightKind: Option.none(),
      revokedGrantId: Option.none(),
    };
  }
  if (event.grant._tag === "AgentToken") {
    return {
      eventType: "granted" as const,
      grantType: Option.some("agent-token" as const),
      agentTokenId: Option.some(event.grant.tokenId),
      insightKind: Option.none(),
      revokedGrantId: Option.none(),
    };
  }
  return {
    eventType: "granted" as const,
    grantType: Option.some("insight-delivery" as const),
    agentTokenId: Option.none(),
    insightKind: Option.some(event.grant.insightKind),
    revokedGrantId: Option.none(),
  };
};

const ConsentRecordFromRow = ConsentRecordRow.pipe(
  Schema.decodeTo(
    ConsentRecord,
    SchemaTransformation.transform({
      decode: (row) =>
        decodeConsentRecord({
          id: row.id,
          subjectUserId: row.subjectUserId,
          event: eventFromRow(row),
          disclosure: disclosureFromRow(row),
          disclosureMessage: {
            channel: row.disclosureChannel,
            provider: row.disclosureProvider,
            providerMessageId: row.disclosureProviderMessageId,
          },
          decisionMessage: {
            channel: row.decisionChannel,
            provider: row.decisionProvider,
            providerMessageId: row.decisionProviderMessageId,
          },
          occurredAt: DateTime.formatIso(row.occurredAt),
        }),
      encode: (input) => {
        const record = decodeConsentRecord(input);
        return {
          id: record.id,
          subjectUserId: record.subjectUserId,
          ...eventToRow(record.event),
          ...disclosureToRow(record.disclosure),
          disclosureChannel: record.disclosureMessage.channel,
          disclosureProvider: record.disclosureMessage.provider,
          disclosureProviderMessageId: record.disclosureMessage.providerMessageId,
          decisionChannel: record.decisionMessage.channel,
          decisionProvider: record.decisionMessage.provider,
          decisionProviderMessageId: record.decisionMessage.providerMessageId,
          occurredAt: utcFromIso(record.occurredAt),
        };
      },
    })
  )
);

/**
 * Serializes authorization and ledger changes for one stable Consent subject.
 * The caller must already be inside the transaction that defines the protected
 * unit; serialization lasts until that transaction completes.
 */
export const lockConsentSubject = (subjectUserId: UserId) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`consent-subject:${subjectUserId}`}, 0))
    `
  ).pipe(Effect.asVoid, Effect.orDie);

/**
 * Runs one consent-dependent unit after serializing it with revocation and
 * confirming an unrevoked onboarding grant. The caller must supply the
 * surrounding transaction; `onMissing` decides the boundary-specific failure.
 */
export const useCurrentConsent = Effect.fn("useCurrentConsent")(function* <A, E, R, E2, R2>(
  subjectUserId: UserId,
  onMissing: () => Effect.Effect<never, E2, R2>,
  use: Effect.Effect<A, E, R>
) {
  yield* lockConsentSubject(subjectUserId);
  if (!(yield* hasCurrentOnboardingConsent(subjectUserId))) return yield* onMissing();
  return yield* use;
});

/**
 * Appends one immutable grant or revocation after serializing changes for its
 * subject. A revocation must reference that subject's existing grant, and an
 * AgentToken grant must reference that subject's existing token. Violating
 * either ownership prerequisite or any persistence invariant is a defect.
 */
export const appendConsentRecord = Effect.fn("appendConsentRecord")(function* (
  record: ConsentRecord
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* withUserTransaction(
    record.subjectUserId,
    Effect.gen(function* () {
      yield* lockConsentSubject(record.subjectUserId);
      return yield* SqlSchema.findOne({
        Request: ConsentRecordFromRow,
        Result: ConsentRecordFromRow,
        execute: (input) => sql`
      INSERT INTO consent_records (
        id, subject_user_id, event_type, grant_type, agent_token_id, insight_kind,
        revoked_grant_id, service_market, locale, disclosure_revision,
        disclosure_sha256, disclosure_text, policy_url, policy_revision, policy_sha256,
        purposes, data_categories, duration, revocation_method, disclosure_channel,
        disclosure_provider, disclosure_provider_message_id, decision_channel,
        decision_provider, decision_provider_message_id, occurred_at
      ) SELECT
        ${input.id}, ${input.subjectUserId}, ${input.eventType}, ${input.grantType},
        ${input.agentTokenId}, ${input.insightKind}, ${input.revokedGrantId},
        ${input.serviceMarket}, ${input.locale}, ${input.disclosureRevision},
        ${input.disclosureSha256}, ${input.disclosureText}, ${input.policyUrl},
        ${input.policyRevision}, ${input.policySha256}, ${input.purposes},
        ${input.dataCategories}, ${input.duration}, ${input.revocationMethod},
        ${input.disclosureChannel}, ${input.disclosureProvider},
        ${input.disclosureProviderMessageId}, ${input.decisionChannel},
        ${input.decisionProvider}, ${input.decisionProviderMessageId}, ${input.occurredAt}
      WHERE (
        ${input.eventType} = 'revoked'
        AND EXISTS (
          SELECT 1 FROM consent_records AS grant_record
          WHERE grant_record.id = ${input.revokedGrantId}
            AND grant_record.subject_user_id = ${input.subjectUserId}
            AND grant_record.event_type = 'granted'
        )
      ) OR (
        ${input.eventType} = 'granted'
        AND (
          ${input.grantType} <> 'agent-token'
          OR EXISTS (
            SELECT 1 FROM agent_tokens AS granted_token
            WHERE granted_token.id = ${input.agentTokenId}
              AND granted_token.user_id = ${input.subjectUserId}
          )
        )
      )
          RETURNING ${sql.literal(consentColumns)}
        `,
      })(record).pipe(Effect.orDie);
    })
  );
});

const ResolvedConsentSubject = Schema.Struct({ subjectUserId: UserId });

/** Finds the immutable decision already associated with one provider-qualified replay key. */
export const findConsentRecordByDecisionMessage = (message: ProviderMessageEvidence) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const resolved = yield* SqlSchema.findOneOption({
      Request: ProviderMessageEvidence,
      Result: ResolvedConsentSubject,
      execute: (input) => sql`
        SELECT resolved.subject_user_id AS "subjectUserId"
        FROM (
          SELECT fidy_resolve_consent_decision_subject(
            ${input.channel}, ${input.provider}, ${input.providerMessageId}
          ) AS subject_user_id
        ) AS resolved
        WHERE resolved.subject_user_id IS NOT NULL
      `,
    })(message).pipe(Effect.orDie);
    if (Option.isNone(resolved)) return Option.none();

    return yield* withUserTransaction(
      resolved.value.subjectUserId,
      SqlSchema.findOneOption({
        Request: ProviderMessageEvidence,
        Result: ConsentRecordFromRow,
        execute: (input) => sql`
          SELECT ${sql.literal(consentColumns)} FROM consent_records
          WHERE decision_channel = ${input.channel}
            AND decision_provider = ${input.provider}
            AND decision_provider_message_id = ${input.providerMessageId}
        `,
      })(message).pipe(Effect.orDie)
    );
  });

const queryCurrentOnboardingConsent = Effect.fn("Consent.queryCurrentOnboardingConsent")(function* (
  subjectUserId: UserId,
  occurredAt: Option.Option<DateTime.Utc>
) {
  const sql = yield* SqlClient.SqlClient;
  const disclosure = yield* currentDisclosure;
  const occurrenceCondition = Option.match(occurredAt, {
    onNone: () => sql``,
    onSome: (value) => sql`AND grant_record.occurred_at <= ${value}`,
  });
  const result = yield* SqlSchema.findOne({
    Request: UserId,
    Result: Schema.Struct({ current: Schema.Boolean }),
    execute: (userId) => sql`
        SELECT EXISTS (
          SELECT 1 FROM consent_records AS grant_record
          WHERE grant_record.subject_user_id = ${userId}
            AND grant_record.event_type = 'granted'
            AND grant_record.grant_type = 'onboarding'
            ${occurrenceCondition}
            AND grant_record.disclosure_revision = ${disclosure.revision}
            AND grant_record.disclosure_sha256 = ${disclosure.contentSha256}
            AND grant_record.policy_revision = ${disclosure.policy.revision}
            AND grant_record.policy_sha256 = ${disclosure.policy.contentSha256}
            AND NOT EXISTS (
              SELECT 1 FROM consent_records AS revocation
              WHERE revocation.event_type = 'revoked'
                AND revocation.subject_user_id = grant_record.subject_user_id
                AND revocation.revoked_grant_id = grant_record.id
            )
        ) AS current
      `,
  })(subjectUserId);
  return result.current;
});

/**
 * Reports whether the current unrevoked onboarding grant already existed at the supplied evidence
 * time, preventing delayed pre-consent messages from inheriting a later authorization.
 */
export const hasCurrentOnboardingConsentAt = Effect.fn("Consent.hasCurrentOnboardingConsentAt")(
  (subjectUserId: UserId, occurredAt: DateTime.Utc) =>
    withUserTransaction(
      subjectUserId,
      queryCurrentOnboardingConsent(subjectUserId, Option.some(occurredAt)).pipe(Effect.orDie)
    )
);

/** Reports whether an unrevoked onboarding grant matches the complete current consent basis. */
export const hasCurrentOnboardingConsent = (subjectUserId: UserId) =>
  withUserTransaction(
    subjectUserId,
    queryCurrentOnboardingConsent(subjectUserId, Option.none()).pipe(Effect.orDie)
  );

/** Test observer for the append-only ledger in deterministic occurrence order. */
export const observeConsentRecords = (subjectUserId: UserId) =>
  withUserTransaction(
    subjectUserId,
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      SqlSchema.findAll({
        Request: UserId,
        Result: ConsentRecordFromRow,
        execute: (userId) => sql`
          SELECT ${sql.literal(consentColumns)} FROM consent_records
          WHERE subject_user_id = ${userId}
          ORDER BY occurred_at, id
        `,
      })(subjectUserId)
    ).pipe(
      Effect.map((rows): ReadonlyArray<ConsentRecord> => rows),
      Effect.orDie
    )
  );

const PendingRow = Schema.Struct({
  id: Schema.toEncoded(PendingConsentExchangeId),
  businessPortfolioId: Schema.toEncoded(WhatsAppBusinessPortfolioId),
  businessScopedUserId: Schema.toEncoded(WhatsAppBusinessScopedUserId),
  lifecycle: Schema.Literals(["awaiting-disclosure-delivery", "awaiting-decision"]),
  ...DisclosureRowFields,
  initiatingChannel: ProviderMessageEvidence.fields.channel,
  initiatingProvider: ProviderMessageEvidence.fields.provider,
  initiatingProviderMessageId: ProviderMessageEvidence.fields.providerMessageId,
  disclosureChannel: OptionalMessageChannel,
  disclosureProvider: OptionalMessageProvider,
  disclosureProviderMessageId: OptionalMessageId,
  createdAt: Schema.DateTimeUtcFromDate,
  disclosedAt: OptionalUtcDate,
  expiresAt: Schema.DateTimeUtcFromDate,
});
type PendingRow = typeof PendingRow.Type;

const pendingColumns = `id, business_portfolio_id AS "businessPortfolioId",
  business_scoped_user_id AS "businessScopedUserId", lifecycle,
  service_market AS "serviceMarket", locale, disclosure_revision AS "disclosureRevision",
  disclosure_sha256 AS "disclosureSha256", disclosure_text AS "disclosureText",
  policy_url AS "policyUrl", policy_revision AS "policyRevision",
  policy_sha256 AS "policySha256", purposes, data_categories AS "dataCategories", duration,
  revocation_method AS "revocationMethod", initiating_channel AS "initiatingChannel",
  initiating_provider AS "initiatingProvider",
  initiating_provider_message_id AS "initiatingProviderMessageId",
  disclosure_channel AS "disclosureChannel",
  disclosure_provider AS "disclosureProvider",
  disclosure_provider_message_id AS "disclosureProviderMessageId",
  created_at AS "createdAt", disclosed_at AS "disclosedAt", expires_at AS "expiresAt"`;

const PendingFromRow = PendingRow.pipe(
  Schema.decodeTo(
    PendingConsentExchange,
    SchemaTransformation.transform({
      decode: (row) => {
        const common = {
          id: row.id,
          caller: {
            businessPortfolioId: row.businessPortfolioId,
            businessScopedUserId: row.businessScopedUserId,
          },
          disclosure: disclosureFromRow(row),
          initiatingMessage: {
            channel: row.initiatingChannel,
            provider: row.initiatingProvider,
            providerMessageId: row.initiatingProviderMessageId,
          },
          createdAt: DateTime.formatIso(row.createdAt),
          expiresAt: DateTime.formatIso(row.expiresAt),
        };
        return decodePendingExchange(
          row.lifecycle === "awaiting-disclosure-delivery"
            ? { _tag: "AwaitingDisclosureDelivery", ...common }
            : Option.match(
                Option.all({
                  channel: row.disclosureChannel,
                  provider: row.disclosureProvider,
                  providerMessageId: row.disclosureProviderMessageId,
                  disclosedAt: row.disclosedAt,
                }),
                {
                  onNone: () => ({ _tag: "AwaitingDecision", ...common }),
                  onSome: ({ disclosedAt, ...disclosureMessage }) => ({
                    _tag: "AwaitingDecision",
                    ...common,
                    disclosureMessage,
                    disclosedAt: DateTime.formatIso(disclosedAt),
                  }),
                }
              )
        );
      },
      encode: (input) => {
        const pending = decodePendingExchange(input);
        const common = {
          id: pending.id,
          businessPortfolioId: pending.caller.businessPortfolioId,
          businessScopedUserId: pending.caller.businessScopedUserId,
          ...disclosureToRow(pending.disclosure),
          initiatingChannel: pending.initiatingMessage.channel,
          initiatingProvider: pending.initiatingMessage.provider,
          initiatingProviderMessageId: pending.initiatingMessage.providerMessageId,
          createdAt: utcFromIso(pending.createdAt),
          expiresAt: utcFromIso(pending.expiresAt),
        };
        if (pending._tag === "AwaitingDisclosureDelivery") {
          return {
            ...common,
            lifecycle: "awaiting-disclosure-delivery" as const,
            disclosureChannel: Option.none(),
            disclosureProvider: Option.none(),
            disclosureProviderMessageId: Option.none(),
            disclosedAt: Option.none(),
          };
        }
        return {
          ...common,
          lifecycle: "awaiting-decision" as const,
          disclosureChannel: Option.some(pending.disclosureMessage.channel),
          disclosureProvider: Option.some(pending.disclosureMessage.provider),
          disclosureProviderMessageId: Option.some(pending.disclosureMessage.providerMessageId),
          disclosedAt: Option.some(utcFromIso(pending.disclosedAt)),
        };
      },
    })
  )
);

/** Serializes all gate decisions for one portfolio-scoped BSUID within the caller's transaction. */
export const lockConsentGate = (caller: WhatsAppCallerReference) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      SELECT pg_advisory_xact_lock(hashtextextended(
        ${`consent-gate:${caller.businessPortfolioId}:${caller.businessScopedUserId}`}, 0
      ))
    `
  ).pipe(Effect.asVoid, Effect.orDie);

/** Persists only the disclosure facts needed before a User exists. */
export const insertPendingConsentExchange = Effect.fn("insertPendingConsentExchange")(function* (
  pending: Extract<PendingConsentExchange, { readonly _tag: "AwaitingDisclosureDelivery" }>
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: PendingFromRow,
    Result: PendingFromRow,
    execute: (input) => sql`
      INSERT INTO pending_consent_exchanges (
        id, business_portfolio_id, business_scoped_user_id,
        lifecycle, service_market, locale, disclosure_revision,
        disclosure_sha256, disclosure_text, policy_url, policy_revision, policy_sha256,
        purposes, data_categories, duration, revocation_method, initiating_channel,
        initiating_provider, initiating_provider_message_id, disclosure_channel,
        disclosure_provider, disclosure_provider_message_id, created_at, disclosed_at, expires_at
      ) VALUES (
        ${input.id}, ${input.businessPortfolioId}, ${input.businessScopedUserId},
        ${input.lifecycle}, ${input.serviceMarket},
        ${input.locale}, ${input.disclosureRevision}, ${input.disclosureSha256},
        ${input.disclosureText}, ${input.policyUrl}, ${input.policyRevision},
        ${input.policySha256}, ${input.purposes}, ${input.dataCategories}, ${input.duration},
        ${input.revocationMethod}, ${input.initiatingChannel}, ${input.initiatingProvider},
        ${input.initiatingProviderMessageId}, ${input.disclosureChannel}, ${input.disclosureProvider},
        ${input.disclosureProviderMessageId}, ${input.createdAt}, ${input.disclosedAt},
        ${input.expiresAt}
      ) RETURNING ${sql.literal(pendingColumns)}
    `,
  })(pending).pipe(Effect.orDie);
});

/** Finds the sole minimal pending exchange for one portfolio-scoped BSUID. */
export const findPendingConsentExchange = (caller: WhatsAppCallerReference) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOneOption({
      Request: WhatsAppCallerReference,
      Result: PendingFromRow,
      execute: (key) => sql`
        SELECT ${sql.literal(pendingColumns)} FROM pending_consent_exchanges
        WHERE business_portfolio_id = ${key.businessPortfolioId}
          AND business_scoped_user_id = ${key.businessScopedUserId}
      `,
    })({
      businessPortfolioId: caller.businessPortfolioId,
      businessScopedUserId: caller.businessScopedUserId,
    })
  ).pipe(Effect.orDie);

const DisclosureDeliveryClaimId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("DisclosureDeliveryClaimId")
);
const DisclosureDeliveryClaimRequest = Schema.Struct({
  exchangeId: PendingConsentExchangeId,
  claimId: DisclosureDeliveryClaimId,
  claimedAt: Schema.DateTimeUtcFromDate,
});
const DisclosureDeliveryClaim = Schema.Struct({ claimId: DisclosureDeliveryClaimId });

/**
 * Claims one disclosure send for 30 seconds. An active or already delivered exchange returns None.
 * An expired pre-provider claim may be reclaimed; a claim marked started remains unavailable for
 * reconciliation rather than risking an automatic duplicate send.
 */
export const claimConsentDisclosureDelivery = Effect.fn("Consent.claimDisclosureDelivery")(
  function* (exchangeId: PendingConsentExchangeId, claimedAt: DateTime.Utc) {
    const crypto = yield* Crypto.Crypto;
    const claimId = DisclosureDeliveryClaimId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOneOption({
      Request: DisclosureDeliveryClaimRequest,
      Result: DisclosureDeliveryClaim,
      execute: (request) => sql`
        UPDATE pending_consent_exchanges
        SET disclosure_delivery_claim_id = ${request.claimId},
          disclosure_delivery_claim_expires_at = ${request.claimedAt}::timestamptz + interval '30 seconds'
        WHERE id = ${request.exchangeId}
          AND lifecycle = 'awaiting-disclosure-delivery'
          AND (
            disclosure_delivery_claim_id IS NULL
            OR (
              disclosure_delivery_started_at IS NULL
              AND disclosure_delivery_claim_expires_at <= ${request.claimedAt}
            )
          )
        RETURNING disclosure_delivery_claim_id AS "claimId"
      `,
    })({ exchangeId, claimId, claimedAt }).pipe(Effect.orDie);
  }
);

const ReleaseDisclosureDeliveryClaimRequest = Schema.Struct({
  exchangeId: PendingConsentExchangeId,
  claimId: DisclosureDeliveryClaimId,
});

/**
 * Marks that the disclosure provider call may have begun. Such a claim is never automatically
 * reclaimed, because its delivery result is ambiguous until reconciled.
 */
export const markConsentDisclosureDeliveryStarted = Effect.fn(
  "Consent.markDisclosureDeliveryStarted"
)(function* (input: typeof ReleaseDisclosureDeliveryClaimRequest.Type, startedAt: DateTime.Utc) {
  const sql = yield* SqlClient.SqlClient;
  return Option.isSome(
    yield* SqlSchema.findOneOption({
      Request: Schema.Struct({
        ...ReleaseDisclosureDeliveryClaimRequest.fields,
        startedAt: Schema.DateTimeUtcFromDate,
      }),
      Result: DisclosureDeliveryClaim,
      execute: (request) => sql`
        UPDATE pending_consent_exchanges
        SET disclosure_delivery_started_at = ${request.startedAt}
        WHERE id = ${request.exchangeId}
          AND disclosure_delivery_claim_id = ${request.claimId}
          AND lifecycle = 'awaiting-disclosure-delivery'
          AND disclosure_delivery_started_at IS NULL
        RETURNING disclosure_delivery_claim_id AS "claimId"
      `,
    })({ ...input, startedAt }).pipe(Effect.orDie)
  );
});

/** Releases exactly the current pre-delivery claim so another delivery may retry. */
export const releaseConsentDisclosureDelivery = Effect.fn("Consent.releaseDisclosureDelivery")(
  function* (input: typeof ReleaseDisclosureDeliveryClaimRequest.Type) {
    const sql = yield* SqlClient.SqlClient;
    yield* SqlSchema.void({
      Request: ReleaseDisclosureDeliveryClaimRequest,
      execute: (request) => sql`
        UPDATE pending_consent_exchanges
        SET disclosure_delivery_claim_id = NULL,
          disclosure_delivery_claim_expires_at = NULL
        WHERE id = ${request.exchangeId}
          AND disclosure_delivery_claim_id = ${request.claimId}
          AND lifecycle = 'awaiting-disclosure-delivery'
          AND disclosure_delivery_started_at IS NULL
      `,
    })(input).pipe(Effect.orDie);
  }
);

const DeliveredRequest = Schema.Struct({
  exchangeId: PendingConsentExchangeId,
  claimId: DisclosureDeliveryClaimId,
  message: ProviderMessageEvidence,
  deliveredAt: Schema.DateTimeUtcFromDate,
});

/**
 * Records one authoritative delivery occurrence for the current claim. A stale claim, unknown
 * exchange, or conflicting evidence returns None without changing the pending exchange.
 */
export const recordConsentDisclosureDelivery = Effect.fn("recordConsentDisclosureDelivery")(
  function* (input: typeof DeliveredRequest.Type) {
    const sql = yield* SqlClient.SqlClient;
    const row = yield* SqlSchema.findOneOption({
      Request: DeliveredRequest,
      Result: PendingFromRow,
      execute: ({ claimId, deliveredAt, exchangeId, message }) => sql`
      UPDATE pending_consent_exchanges
      SET lifecycle = 'awaiting-decision',
        disclosure_channel = ${message.channel},
        disclosure_provider = ${message.provider},
        disclosure_provider_message_id = ${message.providerMessageId},
        disclosed_at = ${deliveredAt},
        disclosure_delivery_claim_id = NULL,
        disclosure_delivery_claim_expires_at = NULL,
        disclosure_delivery_started_at = NULL
      WHERE id = ${exchangeId}
        AND lifecycle = 'awaiting-disclosure-delivery'
        AND disclosure_delivery_claim_id = ${claimId}
      RETURNING ${sql.literal(pendingColumns)}
    `,
    })(input).pipe(Effect.orDie);
    if (Option.isNone(row)) return Option.none();
    if (row.value._tag === "AwaitingDisclosureDelivery") {
      return yield* Effect.die("delivery update returned the previous lifecycle");
    }
    return Option.some(row.value);
  }
);

/** Deletes temporary state after accept, decline, or observed expiry. */
export const removePendingConsentExchange = (exchangeId: PendingConsentExchangeId) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
    DELETE FROM pending_consent_exchanges WHERE id = ${exchangeId}
  `
  ).pipe(Effect.asVoid, Effect.orDie);

/** Deletes abandoned pending exchanges whose 24-hour lifetime has ended. */
export const removeExpiredPendingConsentExchanges = (now: DateTime.Utc) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      DELETE FROM pending_consent_exchanges WHERE expires_at <= ${now}
    `
  ).pipe(Effect.asVoid, Effect.orDie);
