import { DateTime, Effect, Option, Schema, type SchemaIssue, SchemaTransformation } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import {
  DisclosureDeliveryCorrelationToken,
  ProviderMessageEvidence,
} from "~/core/_shared/provider-message-evidence";
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
import { PATId } from "~/core/tokens/reference";
import { WebSessionId } from "~/core/web-session/reference";
import {
  advisoryLockKey,
  withConsentExternalEffectLock,
  withUserLock,
  withUserLockInScope,
} from "~/shell/db/advisory-lock";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { revokePendingForwardedEmailsForConsentInScope } from "~/shell/ingestion/email-consent-revocation";
import { currentDisclosure } from "./current-disclosure";

const OptionalPATId = Schema.OptionFromNullOr(Schema.toEncoded(PATId));
const OptionalConsentRecordId = Schema.OptionFromNullOr(Schema.toEncoded(ConsentRecordId));
const OptionalInsightKind = Schema.OptionFromNullOr(InsightKind);
const OptionalMessageChannel = Schema.OptionFromNullOr(ProviderMessageEvidence.fields.channel);
const OptionalMessageProvider = Schema.OptionFromNullOr(ProviderMessageEvidence.fields.provider);
const OptionalMessageId = Schema.OptionFromNullOr(ProviderMessageEvidence.fields.providerMessageId);
const OptionalWebSessionId = Schema.OptionFromNullOr(Schema.toEncoded(WebSessionId));
const OptionalAutomaticPolicy = Schema.OptionFromNullOr(
  Schema.Literals(["pat-approved-unclaimed-expiry", "pat-fixed-lifetime-expiry"])
);
const OptionalUtcDate = Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate);
const StoredGrantType = Schema.Literals(["onboarding", "pat", "insight-delivery"]);
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
  patId: OptionalPATId,
  insightKind: OptionalInsightKind,
  revokedGrantId: OptionalConsentRecordId,
  ...DisclosureRowFields,
  decisionOrigin: Schema.Literals([
    "provider-qualified-messages",
    "authenticated-web",
    "automatic-policy",
  ]),
  disclosureChannel: OptionalMessageChannel,
  disclosureProvider: OptionalMessageProvider,
  disclosureProviderMessageId: OptionalMessageId,
  decisionChannel: OptionalMessageChannel,
  decisionProvider: OptionalMessageProvider,
  decisionProviderMessageId: OptionalMessageId,
  webSessionId: OptionalWebSessionId,
  automaticPolicy: OptionalAutomaticPolicy,
  occurredAt: Schema.DateTimeUtcFromDate,
});
type ConsentRecordRow = typeof ConsentRecordRow.Type;

const consentColumns = `id, subject_user_id AS "subjectUserId", event_type AS "eventType",
  grant_type AS "grantType", pat_id AS "patId", insight_kind AS "insightKind",
  revoked_grant_id AS "revokedGrantId", service_market AS "serviceMarket", locale,
  disclosure_revision AS "disclosureRevision", disclosure_sha256 AS "disclosureSha256",
  disclosure_text AS "disclosureText", policy_url AS "policyUrl",
  policy_revision AS "policyRevision", policy_sha256 AS "policySha256", purposes,
  data_categories AS "dataCategories", duration, revocation_method AS "revocationMethod",
  decision_origin AS "decisionOrigin", disclosure_channel AS "disclosureChannel",
  disclosure_provider AS "disclosureProvider",
  disclosure_provider_message_id AS "disclosureProviderMessageId",
  decision_channel AS "decisionChannel", decision_provider AS "decisionProvider",
  decision_provider_message_id AS "decisionProviderMessageId",
  web_session_id AS "webSessionId", automatic_policy AS "automaticPolicy",
  occurred_at AS "occurredAt"`;

const disclosureFromRow = (row: DisclosureRow): typeof DisclosureSnapshot.Encoded => ({
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

const disclosureToRow = (disclosure: typeof DisclosureSnapshot.Encoded): DisclosureRow => ({
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

const decodeConsentEvent = Schema.decodeUnknownEffect(Schema.toEncoded(ConsentEvent));
const decodeConsentRecord = Schema.decodeUnknownEffect(Schema.toEncoded(ConsentRecord));
const decodePendingExchange = Schema.decodeUnknownEffect(Schema.toEncoded(PendingConsentExchange));

/** A row that does not reassemble into its model is a decode failure, not a defect. */
const asIssue = function <A>(
  decoded: Effect.Effect<A, Schema.SchemaError>
): Effect.Effect<A, SchemaIssue.Issue> {
  return Effect.mapError(decoded, (error) => error.issue);
};

const utcFromIso = (value: string): DateTime.Utc => DateTime.toUtc(DateTime.makeUnsafe(value));

const grantsFromRow: Record<StoredGrantType, (row: ConsentRecordRow) => unknown> = {
  onboarding: () => ({ _tag: "Onboarding" }),
  pat: (row) =>
    Option.match(row.patId, {
      onNone: () => ({ _tag: "PAT" }),
      onSome: (tokenId) => ({ _tag: "PAT", tokenId }),
    }),
  "insight-delivery": (row) =>
    Option.match(row.insightKind, {
      onNone: () => ({ _tag: "InsightDelivery" }),
      onSome: (insightKind) => ({ _tag: "InsightDelivery", insightKind }),
    }),
};

const eventFromRow = (
  row: ConsentRecordRow
): Effect.Effect<typeof ConsentEvent.Encoded, Schema.SchemaError> => {
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

const eventToRow = (
  event: typeof ConsentEvent.Encoded
): Pick<
  ConsentRecordRow,
  "eventType" | "grantType" | "patId" | "insightKind" | "revokedGrantId"
> => {
  if (event._tag === "Revoked") {
    return {
      eventType: "revoked" as const,
      grantType: Option.none(),
      patId: Option.none(),
      insightKind: Option.none(),
      revokedGrantId: Option.some(event.grantId),
    };
  }
  if (event.grant._tag === "Onboarding") {
    return {
      eventType: "granted" as const,
      grantType: Option.some("onboarding" as const),
      patId: Option.none(),
      insightKind: Option.none(),
      revokedGrantId: Option.none(),
    };
  }
  if (event.grant._tag === "PAT") {
    return {
      eventType: "granted" as const,
      grantType: Option.some("pat" as const),
      patId: Option.some(event.grant.tokenId),
      insightKind: Option.none(),
      revokedGrantId: Option.none(),
    };
  }
  return {
    eventType: "granted" as const,
    grantType: Option.some("insight-delivery" as const),
    patId: Option.none(),
    insightKind: Option.some(event.grant.insightKind),
    revokedGrantId: Option.none(),
  };
};

type EvidenceRow = Pick<
  ConsentRecordRow,
  | "decisionOrigin"
  | "disclosureChannel"
  | "disclosureProvider"
  | "disclosureProviderMessageId"
  | "decisionChannel"
  | "decisionProvider"
  | "decisionProviderMessageId"
  | "webSessionId"
  | "automaticPolicy"
>;

const evidenceFromRow = (row: EvidenceRow): unknown => {
  if (row.decisionOrigin === "authenticated-web") {
    return { _tag: "AuthenticatedWeb", webSessionId: Option.getOrUndefined(row.webSessionId) };
  }
  if (row.decisionOrigin === "automatic-policy") {
    return { _tag: "AutomaticPolicy", policy: Option.getOrUndefined(row.automaticPolicy) };
  }
  return {
    _tag: "ProviderQualifiedMessages",
    disclosureMessage: {
      channel: Option.getOrUndefined(row.disclosureChannel),
      provider: Option.getOrUndefined(row.disclosureProvider),
      providerMessageId: Option.getOrUndefined(row.disclosureProviderMessageId),
    },
    decisionMessage: {
      channel: Option.getOrUndefined(row.decisionChannel),
      provider: Option.getOrUndefined(row.decisionProvider),
      providerMessageId: Option.getOrUndefined(row.decisionProviderMessageId),
    },
  };
};

const emptyEvidenceRow = {
  disclosureChannel: Option.none(),
  disclosureProvider: Option.none(),
  disclosureProviderMessageId: Option.none(),
  decisionChannel: Option.none(),
  decisionProvider: Option.none(),
  decisionProviderMessageId: Option.none(),
  webSessionId: Option.none(),
  automaticPolicy: Option.none(),
} as const;

const evidenceToRow = (evidence: (typeof ConsentRecord.Encoded)["evidence"]): EvidenceRow => {
  if (evidence._tag === "AuthenticatedWeb") {
    return {
      ...emptyEvidenceRow,
      decisionOrigin: "authenticated-web",
      webSessionId: Option.some(evidence.webSessionId),
    };
  }
  if (evidence._tag === "AutomaticPolicy") {
    return {
      ...emptyEvidenceRow,
      decisionOrigin: "automatic-policy",
      automaticPolicy: Option.some(evidence.policy),
    };
  }
  return {
    ...emptyEvidenceRow,
    decisionOrigin: "provider-qualified-messages",
    disclosureChannel: Option.some(evidence.disclosureMessage.channel),
    disclosureProvider: Option.some(evidence.disclosureMessage.provider),
    disclosureProviderMessageId: Option.some(evidence.disclosureMessage.providerMessageId),
    decisionChannel: Option.some(evidence.decisionMessage.channel),
    decisionProvider: Option.some(evidence.decisionMessage.provider),
    decisionProviderMessageId: Option.some(evidence.decisionMessage.providerMessageId),
  };
};

const ConsentRecordFromRow = ConsentRecordRow.pipe(
  Schema.decodeTo(
    ConsentRecord,
    SchemaTransformation.transformOrFail({
      decode: (row) =>
        asIssue(
          Effect.flatMap(eventFromRow(row), (event) =>
            decodeConsentRecord({
              id: row.id,
              subjectUserId: row.subjectUserId,
              event,
              disclosure: disclosureFromRow(row),
              evidence: evidenceFromRow(row),
              occurredAt: DateTime.formatIso(row.occurredAt),
            })
          )
        ),
      encode: (input) =>
        asIssue(
          Effect.map(decodeConsentRecord(input), (record) => ({
            id: record.id,
            subjectUserId: record.subjectUserId,
            ...eventToRow(record.event),
            ...disclosureToRow(record.disclosure),
            ...evidenceToRow(record.evidence),
            occurredAt: utcFromIso(record.occurredAt),
          }))
        ),
    })
  )
);

/** Runs one Consent-dependent unit under the subject lock in the caller-owned transaction. */
export const withSubjectLockInScope = Effect.fn("withSubjectLockInScope")(function* <A, E, R>(
  subjectUserId: UserId,
  body: Effect.Effect<A, E, R>
) {
  return yield* withUserLockInScope(advisoryLockKey.consentSubject(subjectUserId), body);
});

/** Opens one User transaction and serializes a Consent-dependent unit by stable subject. */
export const withSubjectLock = Effect.fn("withSubjectLock")(function* <A, E, R>(
  subjectUserId: UserId,
  body: Effect.Effect<A, E, R>
) {
  return yield* withUserLock(subjectUserId, advisoryLockKey.consentSubject(subjectUserId), body);
});

/**
 * Runs one consent-dependent unit after serializing it with revocation and
 * confirming an unrevoked onboarding grant. `onMissing` decides the boundary-specific failure;
 * the supplied use runs in the same transaction that holds the subject lock.
 */
export const useCurrentConsent = Effect.fn("useCurrentConsent")(function* <A, E, R, E2, R2>(
  subjectUserId: UserId,
  onMissing: () => Effect.Effect<never, E2, R2>,
  use: Effect.Effect<A, E, R>
) {
  return yield* withSubjectLock(
    subjectUserId,
    Effect.gen(function* () {
      if (!(yield* hasCurrentOnboardingConsent(subjectUserId))) return yield* onMissing();
      return yield* use;
    })
  );
});

const revokesOnboardingGrant = Effect.fn("revokesOnboardingGrant")(function* (
  record: ConsentRecord
) {
  if (record.event._tag !== "Revoked") return false;
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: Schema.Struct({ grantId: ConsentRecordId, subjectUserId: UserId }),
    Result: Schema.Struct({ matches: Schema.Boolean }),
    execute: (input) => sql`
      SELECT EXISTS (
        SELECT 1 FROM consent_records
        WHERE id = ${input.grantId}
          AND subject_user_id = ${input.subjectUserId}
          AND event_type = 'granted' AND grant_type = 'onboarding'
      ) AS matches
    `,
  })({ grantId: record.event.grantId, subjectUserId: record.subjectUserId }).pipe(
    Effect.map((row) => row.matches),
    Effect.orDie
  );
});

/**
 * Appends one immutable grant or revocation after serializing changes for its
 * subject. A revocation must reference that subject's existing grant, and an
 * token grant must reference that subject's existing token. Violating
 * either ownership prerequisite or any persistence invariant is a defect.
 */
export const appendConsentRecordInScope = Effect.fn("appendConsentRecordInScope")(function* (
  record: ConsentRecord
) {
  const sql = yield* SqlClient.SqlClient;
  const revokesOnboarding = yield* revokesOnboardingGrant(record);
  const appended = yield* SqlSchema.findOne({
    Request: ConsentRecordFromRow,
    Result: ConsentRecordFromRow,
    execute: (input) => sql`
      INSERT INTO consent_records (
        id, subject_user_id, event_type, grant_type, pat_id, insight_kind,
        revoked_grant_id, service_market, locale, disclosure_revision,
        disclosure_sha256, disclosure_text, policy_url, policy_revision, policy_sha256,
        purposes, data_categories, duration, revocation_method, decision_origin,
        disclosure_channel, disclosure_provider, disclosure_provider_message_id,
        decision_channel, decision_provider, decision_provider_message_id,
        web_session_id, automatic_policy, occurred_at
      ) SELECT
        ${input.id}, ${input.subjectUserId}, ${input.eventType}, ${input.grantType},
        ${input.patId}, ${input.insightKind}, ${input.revokedGrantId},
        ${input.serviceMarket}, ${input.locale}, ${input.disclosureRevision},
        ${input.disclosureSha256}, ${input.disclosureText}, ${input.policyUrl},
        ${input.policyRevision}, ${input.policySha256}, ${input.purposes},
        ${input.dataCategories}, ${input.duration}, ${input.revocationMethod},
        ${input.decisionOrigin}, ${input.disclosureChannel}, ${input.disclosureProvider},
        ${input.disclosureProviderMessageId}, ${input.decisionChannel},
        ${input.decisionProvider}, ${input.decisionProviderMessageId},
        ${input.webSessionId}, ${input.automaticPolicy}, ${input.occurredAt}
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
          ${input.grantType} <> 'pat'
          OR EXISTS (
            SELECT 1 FROM tokens AS granted_token
            WHERE granted_token.id = ${input.patId}
              AND granted_token.user_id = ${input.subjectUserId}
          )
        )
      )
          RETURNING ${sql.literal(consentColumns)}
        `,
  })(record).pipe(Effect.orDie);
  if (revokesOnboarding) {
    yield* revokePendingForwardedEmailsForConsentInScope({
      userId: record.subjectUserId,
      revokedAt: record.occurredAt,
    });
  }
  return appended;
});

/** Opens the transaction and subject lock before appending one immutable Consent record. */
export const appendConsentRecord = Effect.fn("appendConsentRecord")(function* (
  record: ConsentRecord
) {
  const append = withSubjectLock(record.subjectUserId, appendConsentRecordInScope(record));
  return yield* record.event._tag === "Revoked"
    ? withConsentExternalEffectLock(record.subjectUserId, append)
    : append;
});

/** Marks one delivered pending exchange accepted while the Consent caller lock is held. */
export const markPendingConsentAcceptedInScope = Effect.fn(
  "Consent.markPendingConsentAcceptedInScope"
)(function* (
  input: Readonly<{
    pendingExchangeId: PendingConsentExchangeId;
    decisionMessage: ProviderMessageEvidence;
    acceptedAt: DateTime.Utc;
  }>
) {
  const sql = yield* SqlClient.SqlClient;
  yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ id: PendingConsentExchangeId }),
    execute: () => sql`
      UPDATE pending_consent_exchanges SET
        decision_channel = ${input.decisionMessage.channel},
        decision_provider = ${input.decisionMessage.provider},
        decision_provider_message_id = ${input.decisionMessage.providerMessageId},
        accepted_at = ${input.acceptedAt}
      WHERE id = ${input.pendingExchangeId}
        AND lifecycle = 'awaiting-decision'
        AND decision_channel IS NULL
      RETURNING id
    `,
  })(undefined).pipe(Effect.orDie);
});

/** Consent-owned append from bounded accepted evidence inside onboarding's open transaction. */
export const appendVerifiedOnboardingConsentInScope = Effect.fn(
  "Consent.appendVerifiedOnboardingConsentInScope"
)(function* (
  input: Readonly<{
    recordId: ConsentRecordId;
    subjectUserId: UserId;
    pendingExchangeId: PendingConsentExchangeId;
  }>
) {
  const sql = yield* SqlClient.SqlClient;
  yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ id: ConsentRecordId }),
    execute: () => sql`
      INSERT INTO consent_records (
        id, subject_user_id, event_type, grant_type, service_market, locale,
        disclosure_revision, disclosure_sha256, disclosure_text, policy_url,
        policy_revision, policy_sha256, purposes, data_categories, duration,
        revocation_method, decision_origin, disclosure_channel, disclosure_provider,
        disclosure_provider_message_id, decision_channel, decision_provider,
        decision_provider_message_id, occurred_at
      ) SELECT
        ${input.recordId}, ${input.subjectUserId}, 'granted', 'onboarding',
        service_market, locale, disclosure_revision, disclosure_sha256, disclosure_text,
        policy_url, policy_revision, policy_sha256, purposes, data_categories, duration,
        revocation_method, 'provider-qualified-messages', disclosure_channel, disclosure_provider,
        disclosure_provider_message_id, decision_channel,
        decision_provider, decision_provider_message_id, accepted_at
      FROM pending_consent_exchanges
      WHERE id = ${input.pendingExchangeId} AND accepted_at IS NOT NULL
      RETURNING id
    `,
  })(undefined).pipe(Effect.orDie);
}, Effect.orDie);

const ResolvedConsentSubject = Schema.Struct({ subjectUserId: UserId });

/** Finds the immutable decision already associated with one provider-qualified replay key. */
export const findConsentRecordByDecisionMessage = (
  message: ProviderMessageEvidence
): Effect.Effect<Option.Option<ConsentRecord>, never, SqlClient.SqlClient> =>
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

/** Finds the immutable grant record for one User-owned PAT inside its current transaction. */
export const findPATGrantInScope = Effect.fn("Consent.findPATGrantInScope")(function* (
  subjectUserId: UserId,
  patId: PATId
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Struct({ subjectUserId: UserId, patId: PATId }),
    Result: ConsentRecordFromRow,
    execute: (request) => sql`
      SELECT ${sql.literal(consentColumns)} FROM consent_records
      WHERE subject_user_id = ${request.subjectUserId}
        AND event_type = 'granted' AND grant_type = 'pat' AND pat_id = ${request.patId}
      ORDER BY occurred_at, id LIMIT 1
    `,
  })({ subjectUserId, patId }).pipe(Effect.orDie);
});

export const currentOnboardingGrantInScope = Effect.fn("Consent.currentOnboardingGrantInScope")(
  function* (subjectUserId: UserId) {
    const sql = yield* SqlClient.SqlClient;
    const disclosure = yield* currentDisclosure;
    return yield* SqlSchema.findOneOption({
      Request: UserId,
      Result: ConsentRecordFromRow,
      execute: (userId) => sql`
        SELECT ${sql.literal(consentColumns)} FROM consent_records AS grant_record
        WHERE grant_record.subject_user_id = ${userId}
          AND grant_record.event_type = 'granted'
          AND grant_record.grant_type = 'onboarding'
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
        ORDER BY grant_record.occurred_at DESC, grant_record.id DESC
        LIMIT 1
      `,
    })(subjectUserId).pipe(Effect.orDie);
  }
);

/** Reports whether one captured onboarding grant remains explicitly unrevoked. */
export const isOnboardingGrantUnrevokedInScope = Effect.fn(
  "Consent.isOnboardingGrantUnrevokedInScope"
)(function* (subjectUserId: UserId, grantId: ConsentRecordId) {
  const sql = yield* SqlClient.SqlClient;
  const result = yield* SqlSchema.findOne({
    Request: Schema.Struct({ subjectUserId: UserId, grantId: ConsentRecordId }),
    Result: Schema.Struct({ unrevoked: Schema.Boolean }),
    execute: (input) => sql`
      SELECT EXISTS (
        SELECT 1 FROM consent_records AS grant_record
        WHERE grant_record.subject_user_id = ${input.subjectUserId}
          AND grant_record.id = ${input.grantId}
          AND grant_record.event_type = 'granted'
          AND grant_record.grant_type = 'onboarding'
          AND NOT EXISTS (
            SELECT 1 FROM consent_records AS revocation
            WHERE revocation.event_type = 'revoked'
              AND revocation.subject_user_id = grant_record.subject_user_id
              AND revocation.revoked_grant_id = grant_record.id
          )
      ) AS unrevoked
    `,
  })({ subjectUserId, grantId }).pipe(Effect.orDie);
  return result.unrevoked;
});

/**
 * Why a User's onboarding Consent stands or does not. A User who never accepted onboarding must be
 * told to accept it; a User whose grant was revoked must act on a Fidy-owned surface instead.
 */
export type OnboardingConsentStanding = "granted" | "never-granted" | "revoked";

/**
 * The one revocation predicate every credential shares. It ignores later terms revisions but closes
 * after explicit revocation of the latest onboarding grant, so a hosted session and a PAT answer
 * "is this User's Consent revoked" identically. A later Fidy-owned acceptance opens access again;
 * absent and revoked Consent stay distinct so each boundary reports the action the User must take.
 */
export const onboardingConsentStandingInScope = Effect.fn(
  "Consent.onboardingConsentStandingInScope"
)(function* (subjectUserId: UserId) {
  const sql = yield* SqlClient.SqlClient;
  const latest = yield* SqlSchema.findOneOption({
    Request: UserId,
    Result: Schema.Struct({ unrevoked: Schema.Boolean }),
    execute: (userId) => sql`
      SELECT NOT EXISTS (
        SELECT 1 FROM consent_records AS revocation
        WHERE revocation.event_type = 'revoked'
          AND revocation.subject_user_id = grant_record.subject_user_id
          AND revocation.revoked_grant_id = grant_record.id
      ) AS unrevoked
      FROM consent_records AS grant_record
      WHERE grant_record.subject_user_id = ${userId}
        AND grant_record.event_type = 'granted'
        AND grant_record.grant_type = 'onboarding'
      ORDER BY grant_record.occurred_at DESC, grant_record.id DESC
      LIMIT 1
    `,
  })(subjectUserId).pipe(Effect.orDie);
  if (Option.isNone(latest)) return "never-granted" satisfies OnboardingConsentStanding;
  return latest.value.unrevoked
    ? ("granted" satisfies OnboardingConsentStanding)
    : ("revoked" satisfies OnboardingConsentStanding);
});

/** Reports whether an unrevoked onboarding grant matches the complete current consent basis. */
export const hasCurrentOnboardingConsent = (
  subjectUserId: UserId
): Effect.Effect<boolean, never, SqlClient.SqlClient> =>
  withUserTransaction(
    subjectUserId,
    queryCurrentOnboardingConsent(subjectUserId, Option.none()).pipe(Effect.orDie)
  );

/** Test observer for the append-only ledger in deterministic occurrence order. */
export const observeConsentRecords = (
  subjectUserId: UserId
): Effect.Effect<ReadonlyArray<ConsentRecord>, never, SqlClient.SqlClient> =>
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
    SchemaTransformation.transformOrFail({
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
        return asIssue(
          decodePendingExchange(
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
          )
        );
      },
      encode: (input) =>
        asIssue(
          Effect.map(decodePendingExchange(input), (pending) => {
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
          })
        ),
    })
  )
);

/**
 * Runs one pre-subject Consent decision under its portfolio-scoped BSUID lock. The lock covers the
 * supplied body and cannot be acquired independently of its transaction.
 */
export const withConsentLock = Effect.fn("withConsentLock")(function* <A, E, R>(
  caller: WhatsAppCallerReference,
  body: Effect.Effect<A, E, R>
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const lockKey = advisoryLockKey.consentGate(caller);
      yield* sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${lockKey.value}, ${lockKey.seed}))
      `.pipe(Effect.orDie);
      return yield* body;
    })
  );
});

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

const LocalDeliveredRequest = Schema.Struct({
  exchangeId: PendingConsentExchangeId,
  message: ProviderMessageEvidence,
  deliveredAt: Schema.DateTimeUtcFromDate,
});
const CorrelatedDeliveredRequest = LocalDeliveredRequest.pipe(
  Schema.fieldsAssign({ correlationToken: DisclosureDeliveryCorrelationToken })
);
const AdvanceDeliveredRequest = LocalDeliveredRequest.pipe(
  Schema.fieldsAssign({
    correlationToken: Schema.OptionFromNullOr(DisclosureDeliveryCorrelationToken),
  })
);
const AppliedDelivery = Schema.Struct({ applied: Schema.Boolean });

const advancePendingConsentDisclosureDelivery = Effect.fn(
  "Consent.advancePendingDisclosureDelivery"
)(function* (input: typeof AdvanceDeliveredRequest.Type) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const result = yield* SqlSchema.findOne({
          Request: AdvanceDeliveredRequest,
          Result: AppliedDelivery,
          execute: ({ deliveredAt, exchangeId, message }) => sql`
          SELECT fidy_record_pending_consent_disclosure_delivery(
            ${exchangeId}, ${Option.getOrNull(input.correlationToken)}, ${message.channel}, ${message.provider},
            ${message.providerMessageId}, ${deliveredAt}
          ) AS applied
        `,
        })(input);
        if (!result.applied) return Option.none();
        return yield* SqlSchema.findOneOption({
          Request: PendingConsentExchangeId,
          Result: PendingFromRow,
          execute: (id) => sql`
          SELECT ${sql.literal(pendingColumns)} FROM pending_consent_exchanges WHERE id = ${id}
        `,
        })(input.exchangeId);
      }).pipe(Effect.orDie)
    )
    .pipe(Effect.orDie);
});

/**
 * Records synchronous non-provider disclosure evidence without entering WhatsApp delivery state.
 * Returns None when the exchange is absent, no longer awaits delivery, or conflicts with retained
 * evidence; Some is the resulting awaiting-decision exchange.
 */
export const recordLocalConsentDisclosureDelivery = Effect.fn(
  "Consent.recordLocalDisclosureDelivery"
)(function* (input: typeof LocalDeliveredRequest.Type) {
  return yield* advancePendingConsentDisclosureDelivery({
    ...input,
    correlationToken: Option.none(),
  });
});

/** Finds the sole minimal pending exchange for one portfolio-scoped BSUID. */
export const findPendingConsentExchange = (
  caller: WhatsAppCallerReference
): Effect.Effect<Option.Option<PendingConsentExchange>, never, SqlClient.SqlClient> =>
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

const ConsentDisclosureRetry = Schema.Struct({
  businessScopedUserId: WhatsAppBusinessScopedUserId,
  disclosureText: DisclosureSnapshot.fields.text,
});

/** Publishes the Consent-owned routing snapshot needed for one already-claimed retry. */
export const findPendingConsentDisclosureRetry = Effect.fn("Consent.findPendingDisclosureRetry")(
  function* (exchangeId: PendingConsentExchangeId) {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOneOption({
      Request: PendingConsentExchangeId,
      Result: ConsentDisclosureRetry,
      execute: (id) => sql`
        SELECT business_scoped_user_id AS "businessScopedUserId",
          disclosure_text AS "disclosureText"
        FROM pending_consent_exchanges
        WHERE id = ${id} AND lifecycle = 'awaiting-disclosure-delivery'
      `,
    })(exchangeId).pipe(Effect.orDie);
  }
);

/**
 * Atomically advances Consent only after the correlated WhatsApp attempt retains exact delivered
 * provider evidence. Returns None for an absent, stale, or conflicting exchange; Some is the
 * resulting awaiting-decision exchange.
 */
export const recordConsentDisclosureDelivery = Effect.fn("Consent.recordDisclosureDelivery")(
  function* (input: typeof CorrelatedDeliveredRequest.Type) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const changed = yield* advancePendingConsentDisclosureDelivery({
            ...input,
            correlationToken: Option.some(input.correlationToken),
          });
          if (Option.isNone(changed)) return Option.none();
          if (changed.value._tag === "AwaitingDisclosureDelivery") {
            return yield* Effect.die(
              new Error("Consent delivery update returned the previous lifecycle")
            );
          }
          return Option.some(changed.value);
        }).pipe(Effect.orDie)
      )
      .pipe(Effect.orDie);
  }
);

/** Deletes temporary state after accept, decline, or observed expiry. */
export const removePendingConsentExchange = (
  exchangeId: PendingConsentExchangeId
): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
    DELETE FROM pending_consent_exchanges WHERE id = ${exchangeId}
  `
  ).pipe(Effect.asVoid, Effect.orDie);

const retentionBatchSize = 100;

/** Deletes one fixed-size indexed batch of expired Consent-owned pending exchanges. */
export const removeExpiredPendingConsentExchanges = (
  now: DateTime.Utc
): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      WITH expired AS (
        SELECT id
        FROM pending_consent_exchanges
        WHERE expires_at <= ${now}
          AND accepted_at IS NULL
        ORDER BY expires_at, id
        LIMIT ${retentionBatchSize}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM pending_consent_exchanges AS pending
      USING expired
      WHERE pending.id = expired.id
    `
  ).pipe(Effect.asVoid, Effect.orDie);
