import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { type Config, ConfigProvider, DateTime, Effect, Layer, Option, Ref, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { type SqlError, SqlSchema } from "effect/unstable/sql";
import { BrowserLoginPublicCode } from "~/core/browser-login/rules";
import { EmailAddress, type EmailVerificationCode } from "~/core/email-authentication/model";
import { categoryIds } from "~/core/categories/taxonomy";
import { UserId } from "~/core/identity/reference";
import { makeColombianUser } from "~/core/identity/rules";
import { MigrationSqlClient, PgLive } from "~/shell/db/client";
import { emailCredentialLookupKey } from "~/shell/email-authentication/admission";
import { browserPairingEmailAuthentication } from "~/shell/email-authentication/pairing-authentication";
import { EmailDeliveryPort } from "~/shell/email-authentication/delivery";
import { maximumPublicRequestBodySizeBytes } from "~/shell/runtime";
import { upsertStableUserFixture } from "./identity-fixtures";

const acceptanceUserId = UserId.make("24000000-0000-4000-8000-000000000241");
const acceptanceEmail = "browser-pairing-acceptance@fidyapp.com";
const acceptanceRevocationId = "24000000-0000-4000-8000-000000000326";

const ApprovePairingRequest = Schema.Struct({ publicCode: BrowserLoginPublicCode });
const ApprovedPairing = Schema.Struct({ publicCode: BrowserLoginPublicCode });
const IdentityObservation = Schema.Struct({
  userCount: Schema.Int,
  verifiedEmailCount: Schema.Int,
  verifiedEmailAddress: Schema.NullOr(Schema.String),
  verifiedEmailRevision: Schema.NullOr(Schema.String),
  whatsAppIdentityCount: Schema.Int,
  transactionCount: Schema.Int,
  userRecordSha256: Schema.String,
  verifiedEmailRecordSha256: Schema.String,
  whatsAppIdentityRecordsSha256: Schema.String,
  transactionRecordsSha256: Schema.String,
});
const SessionObservation = Schema.Struct({
  sessionCount: Schema.Int,
  revoked: Schema.Boolean,
});

const createdStatus = 201;
const noContentStatus = 204;
const conflictStatus = 409;

const reset = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`DELETE FROM consent_records WHERE id = ${acceptanceRevocationId}`;
  yield* sql`DELETE FROM consent_records
    WHERE subject_user_id = ${acceptanceUserId}
      AND revoked_grant_id IN (
        SELECT id FROM consent_records
        WHERE subject_user_id = ${acceptanceUserId} AND grant_type = 'pat'
      )`;
  yield* sql`DELETE FROM consent_records
    WHERE subject_user_id = ${acceptanceUserId} AND revoked_grant_id IS NOT NULL`;
  yield* sql`DELETE FROM consent_records
    WHERE subject_user_id = ${acceptanceUserId} AND grant_type = 'pat'`;
  yield* sql`DELETE FROM audit_log_entries WHERE user_id = ${acceptanceUserId}`;
  yield* sql`DELETE FROM dashboards WHERE user_id = ${acceptanceUserId}`;
  yield* sql`DELETE FROM tokens WHERE user_id = ${acceptanceUserId}`;
  yield* sql`DELETE FROM pat_pairings WHERE user_id = ${acceptanceUserId}`;
  yield* sql`DELETE FROM web_sessions WHERE user_id = ${acceptanceUserId}`;
  yield* sql`
    TRUNCATE browser_pairing_email_start_requests, browser_pairing_email_delivery_intents,
      browser_pairing_email_workflows, browser_login_start_attempts
  `;
  yield* sql`DELETE FROM browser_login_pairings`;
  yield* sql`DELETE FROM email_pairing_login_admission_scopes`;
  yield* sql`DELETE FROM email_delivery_admission_budgets`;
  yield* sql`DELETE FROM transactions WHERE user_id = ${acceptanceUserId}`;
  yield* sql`DELETE FROM budgets WHERE user_id = ${acceptanceUserId}`;
  const user = yield* makeColombianUser(acceptanceUserId, {
    createdAt: yield* DateTime.now,
    paidTier: "free",
  });
  yield* upsertStableUserFixture(acceptanceUserId, user);
  const lookupKey = yield* emailCredentialLookupKey(EmailAddress.make(acceptanceEmail)).pipe(
    Effect.orDie
  );
  yield* sql`
    INSERT INTO verified_email_credentials (user_id, email_address, verified_at)
    VALUES (${acceptanceUserId}, ${acceptanceEmail}, ${yield* DateTime.now})
    ON CONFLICT (user_id) DO UPDATE SET email_address = EXCLUDED.email_address,
      verified_at = EXCLUDED.verified_at
  `;
  yield* sql`
    INSERT INTO verified_email_credential_authentication_lookups (
      user_id, authentication_lookup_key
    ) VALUES (${acceptanceUserId}, ${lookupKey})
    ON CONFLICT (user_id) DO UPDATE
      SET authentication_lookup_key = EXCLUDED.authentication_lookup_key
  `;
  return HttpServerResponse.empty({ status: noContentStatus });
});

const revokeConsent = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`
    INSERT INTO consent_records (
      id, subject_user_id, event_type, revoked_grant_id, service_market, locale,
      disclosure_revision, disclosure_sha256, disclosure_text, policy_url, policy_revision,
      policy_sha256, purposes, data_categories, duration, revocation_method, decision_origin,
      disclosure_channel, disclosure_provider, disclosure_provider_message_id, decision_channel,
      decision_provider, decision_provider_message_id, occurred_at
    ) SELECT ${acceptanceRevocationId}, subject_user_id, 'revoked', id, service_market, locale,
      disclosure_revision, disclosure_sha256, disclosure_text, policy_url, policy_revision,
      policy_sha256, purposes, data_categories, duration, revocation_method,
      'provider-qualified-messages', disclosure_channel, disclosure_provider,
      disclosure_provider_message_id, decision_channel, decision_provider,
      'browser-pairing-acceptance-revocation', now()
    FROM consent_records WHERE subject_user_id = ${acceptanceUserId} AND event_type = 'granted'
      AND grant_type = 'onboarding' ORDER BY occurred_at DESC LIMIT 1
    ON CONFLICT (id) DO NOTHING
  `;
  return HttpServerResponse.empty({ status: noContentStatus });
});

const approvePairing = Effect.gen(function* () {
  const { publicCode } = yield* HttpServerRequest.schemaBodyJson(ApprovePairingRequest);
  const sql = yield* MigrationSqlClient;
  const approved = yield* SqlSchema.findAll({
    Request: BrowserLoginPublicCode,
    Result: ApprovedPairing,
    execute: (code) => sql`
      UPDATE browser_login_pairings
      SET user_id = ${acceptanceUserId}, lifecycle = 'ready', approved_at = now()
      WHERE public_code = ${code} AND lifecycle = 'pending_approval'
      RETURNING public_code AS "publicCode"
    `,
  })(publicCode);
  return HttpServerResponse.empty({
    status: approved.length === 1 ? noContentStatus : conflictStatus,
  });
});

const processEmailDelivery = Effect.gen(function* () {
  const delivered = yield* Ref.make(Option.none<EmailVerificationCode>());
  const processed = yield* browserPairingEmailAuthentication.processNextBackgroundStep().pipe(
    Effect.provideService(
      EmailDeliveryPort,
      EmailDeliveryPort.of({
        send: ({ combinedCode }) => Ref.set(delivered, Option.some(combinedCode)),
      })
    )
  );
  const combinedCode = yield* Ref.get(delivered);
  if (processed._tag === "Idle" || Option.isNone(combinedCode)) {
    return HttpServerResponse.empty({ status: conflictStatus });
  }
  return yield* HttpServerResponse.json({ combinedCode: combinedCode.value });
});

const observeIdentity = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  const observations = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: IdentityObservation,
    execute: () => sql`
      SELECT
        (SELECT count(*)::int FROM users) AS "userCount",
        (SELECT count(*)::int FROM verified_email_credentials
          WHERE user_id = ${acceptanceUserId}) AS "verifiedEmailCount",
        (SELECT email_address FROM verified_email_credentials
          WHERE user_id = ${acceptanceUserId}) AS "verifiedEmailAddress",
        (SELECT verified_at::text FROM verified_email_credentials
          WHERE user_id = ${acceptanceUserId}) AS "verifiedEmailRevision",
        (SELECT count(*)::int FROM whatsapp_identities
          WHERE user_id = ${acceptanceUserId}) AS "whatsAppIdentityCount",
        (SELECT count(*)::int FROM transactions
          WHERE user_id = ${acceptanceUserId}) AS "transactionCount",
        (SELECT encode(sha256(to_jsonb(user_record)::text::bytea), 'hex') FROM users user_record
          WHERE id = ${acceptanceUserId}) AS "userRecordSha256",
        (SELECT encode(sha256(to_jsonb(credential)::text::bytea), 'hex')
          FROM verified_email_credentials credential
          WHERE user_id = ${acceptanceUserId}) AS "verifiedEmailRecordSha256",
        (SELECT encode(sha256(COALESCE(
          jsonb_agg(to_jsonb(identity) ORDER BY identity.phone_number), '[]'::jsonb
        )::text::bytea), 'hex') FROM whatsapp_identities identity
          WHERE user_id = ${acceptanceUserId}) AS "whatsAppIdentityRecordsSha256",
        (SELECT encode(sha256(COALESCE(
          jsonb_agg(to_jsonb(transaction_record) ORDER BY transaction_record.id), '[]'::jsonb
        )::text::bytea), 'hex') FROM transactions transaction_record
          WHERE user_id = ${acceptanceUserId}) AS "transactionRecordsSha256"
    `,
  })(undefined);
  return yield* HttpServerResponse.json(Option.getOrThrow(Option.fromNullishOr(observations[0])));
});

const observeSession = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  const observations = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: SessionObservation,
    execute: () => sql`
      SELECT
        count(*)::int AS "sessionCount",
        COALESCE(bool_and(revoked_at IS NOT NULL), false) AS revoked
      FROM web_sessions
      WHERE user_id = ${acceptanceUserId}
    `,
  })(undefined);
  return yield* HttpServerResponse.json(Option.getOrThrow(Option.fromNullishOr(observations[0])));
});

const expireSession = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`
    UPDATE web_sessions SET idle_expires_at = paired_at + interval '1 millisecond'
    WHERE user_id = ${acceptanceUserId} AND revoked_at IS NULL
  `;
  return HttpServerResponse.empty({ status: noContentStatus });
});

const seedCurrentMonthTransaction = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`
    INSERT INTO transactions (
      user_id, amount, currency, counterparty, direction, category_id, occurred_at
    )
    VALUES
      (${acceptanceUserId}, 9007199254740993.12, 'USD', 'Exactitud S.A.', 'inflow',
        ${categoryIds.restaurantes}, now() - interval '1 minute'),
      (${acceptanceUserId}, 85000, 'COP', 'Bistró Central', 'outflow',
        ${categoryIds.restaurantes}, now() - interval '2 hours'),
      (${acceptanceUserId}, 230000, 'COP', 'Mercado Local', 'outflow',
        ${categoryIds.mercado}, now() - interval '1 day'),
      (${acceptanceUserId}, 42000, 'COP', 'Transporte Urbano', 'outflow',
        ${categoryIds.transporte}, now() - interval '2 days'),
      (${acceptanceUserId}, 125000, 'COP', 'Servicios del hogar', 'outflow',
        ${categoryIds.servicios}, now() - interval '3 days')
  `;
  yield* sql`
    INSERT INTO budgets (user_id, category_id, cap_amount, cap_currency)
    VALUES (${acceptanceUserId}, ${categoryIds.restaurantes}, 600000, 'COP')
  `;
  return yield* HttpServerResponse.json(
    { categoryLabel: "Restaurantes" },
    { status: createdStatus }
  );
});

const AcceptanceControlConfig = ConfigProvider.layer(
  ConfigProvider.fromEnv({
    env: {
      PUBLIC_WEB_ORIGIN: "https://127.0.0.1:4173",
      PUBLIC_API_ORIGIN: "https://127.0.0.1:4174",
      INGEST_EMAIL_DOMAIN: "ingest.fidyapp.com",
      KAPSO_WEBHOOK_SECRET: "test-webhook-secret-32-characters",
      WHATSAPP_BUSINESS_PORTFOLIO_ID: "portfolio-test",
    },
  })
);

const ControlRoutesLive = Layer.mergeAll(
  HttpRouter.add("POST", "/reset", reset),
  HttpRouter.add("POST", "/approve-pairing", approvePairing),
  HttpRouter.add("POST", "/revoke-consent", revokeConsent),
  HttpRouter.add("POST", "/process-email-delivery", processEmailDelivery),
  HttpRouter.add("POST", "/expire-session", expireSession),
  HttpRouter.add("POST", "/seed-current-month-transaction", seedCurrentMonthTransaction),
  HttpRouter.add("GET", "/session-observation", observeSession),
  HttpRouter.add("GET", "/identity-observation", observeIdentity)
);

/**
 * Loopback-only behavior control for the built-browser acceptance executable. This layer is never
 * composed into HttpLive. Its fixed-fixture delivery route returns only the ephemeral code needed
 * by the browser acceptance test and exposes no arbitrary User, bearer, or SQL capability.
 */
export const makeBrowserLoginPairingAcceptanceControlServer = ({
  certificate,
  privateKey,
}: {
  readonly certificate: Bun.BunFile;
  readonly privateKey: Bun.BunFile;
}): Layer.Layer<never, Config.ConfigError | SqlError.SqlError> =>
  HttpRouter.serve(ControlRoutesLive).pipe(
    Layer.provide(AcceptanceControlConfig),
    Layer.provide(
      BunHttpServer.layer({
        hostname: "127.0.0.1",
        port: 4175,
        maxRequestBodySize: maximumPublicRequestBodySizeBytes,
        tls: { cert: certificate, key: privateKey },
      })
    ),
    Layer.provide(BunServices.layer),
    Layer.provide(MigrationSqlClient.layer),
    Layer.provide(PgLive)
  );
