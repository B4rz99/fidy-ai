import { type Cause, Effect, Option, Schema } from "effect";
import { DisclosureSnapshot } from "@fidy/server/consent-contract";
import {
  HostedAgentSessionConsentBasis,
  IanaTimeZone,
  Locale,
  ServiceMarket,
} from "@fidy/server/agent-runtime";
import { consentRevocationQuery } from "@fidy/server/consent-runtime";
import { recordOnboardingConsent } from "@fidy/server/consent-operations";
import type { UserId } from "@fidy/server/identity-runtime";

/** Prepare exact accepted pending evidence for the caller's atomic stable-User onboarding unit. */
export const prepareOnboardingConsent = ({
  db,
  userId,
  exchangeId,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  exchangeId: string;
}>): D1PreparedStatement => {
  const statement = recordOnboardingConsent({ userId, exchangeId });
  return db.prepare(statement.sql).bind(...statement.params);
};

const HostedConsentRow = Schema.Struct({
  service_market: ServiceMarket,
  locale: Locale,
  time_zone: IanaTimeZone,
  id: Schema.String,
  disclosure_json: Schema.String,
  revoked: Schema.Int,
});

/** Current User context and original grant basis; revoked standing remains visible for hosted refusal. */
export type HostedConsentStanding = Readonly<{
  user: Readonly<{ serviceMarket: ServiceMarket; locale: Locale; timeZone: IanaTimeZone }>;
  consentBasis: HostedAgentSessionConsentBasis;
  revoked: boolean;
}>;

/** Recheck established channel authority and return only this User's decoded Consent basis.
 * Call under the existing per-User hosted coordinator. This read classifies standing; admission and
 * every provider/model egress retain their existing in-unit Consent guards and Turn timing.
 */
export const readHostedConsent = ({
  db,
  userId,
  authority,
}: Readonly<{
  db: D1Database;
  userId: string;
  authority: Readonly<{
    table: "web_sessions" | "whatsapp_identities";
    predicate: string;
    bindings: ReadonlyArray<string | number | Uint8Array>;
  }>;
}>): Effect.Effect<Option.Option<HostedConsentStanding>, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT u.service_market, u.locale, u.time_zone, c.id, c.disclosure_json,
      EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = u.id) AS revoked
      FROM users AS u JOIN onboarding_consent_records AS c ON c.user_id = u.id
      WHERE u.id = ? AND EXISTS (SELECT 1 FROM ${authority.table} WHERE user_id = ? AND ${authority.predicate})`)
        .bind(userId, userId, ...authority.bindings)
        .first()
    );
    if (raw === null) return Option.none();
    const row = yield* Schema.decodeUnknownEffect(HostedConsentRow)(raw);
    const disclosure = yield* Schema.decodeEffect(Schema.fromJsonString(DisclosureSnapshot))(
      row.disclosure_json
    );
    const consentBasis = yield* Schema.decodeEffect(HostedAgentSessionConsentBasis)({
      grantId: row.id,
      disclosureRevision: disclosure.revision,
      disclosureSha256: disclosure.contentSha256,
      policyRevision: disclosure.policy.revision,
      policySha256: disclosure.policy.contentSha256,
    });
    return Option.some({
      user: { serviceMarket: row.service_market, locale: row.locale, timeZone: row.time_zone },
      consentBasis,
      revoked: row.revoked === 1,
    });
  });

/** Refusal classification only. Protected actions must recheck Consent inside their D1 unit. */
export const isConsentRevoked = ({
  db,
  userId,
}: Readonly<{
  db: D1Database;
  userId: string;
}>): Effect.Effect<boolean, Cause.UnknownError> => {
  const query = consentRevocationQuery(userId);
  return Effect.tryPromise(() =>
    db
      .prepare(query.sql)
      .bind(...query.params)
      .first()
  ).pipe(Effect.map((row) => row !== null));
};
