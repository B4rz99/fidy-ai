import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { type Config, ConfigProvider, Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { type SqlError, SqlSchema } from "effect/unstable/sql";
import { BrowserLoginPublicCode } from "~/core/browser-login/rules";
import { UserId } from "~/core/identity/reference";
import { seedOnboardingConsent } from "~/shell/db/development-seed";
import { MigrationSqlClient, PgLive } from "~/shell/db/client";
import { maximumPublicRequestBodySizeBytes } from "~/shell/runtime";

const acceptanceUserId = UserId.make("24000000-0000-4000-8000-000000000241");

const ApprovePairingRequest = Schema.Struct({ publicCode: BrowserLoginPublicCode });
const ApprovedPairing = Schema.Struct({ publicCode: BrowserLoginPublicCode });
const SessionObservation = Schema.Struct({
  sessionCount: Schema.Int,
  revoked: Schema.Boolean,
});

const noContentStatus = 204;
const conflictStatus = 409;

const reset = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`TRUNCATE web_sessions, browser_login_start_attempts, browser_login_pairings`;
  yield* sql`
    INSERT INTO users (
      id, service_market, locale, time_zone, created_at,
      paid_tier, trial_started_at, trial_ends_at
    )
    VALUES (
      ${acceptanceUserId}, 'CO', 'es-CO', 'America/Bogota', now(),
      'free', now(), now() + INTERVAL '168 hours'
    )
    ON CONFLICT (id) DO NOTHING
  `;
  yield* seedOnboardingConsent(acceptanceUserId);
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
  HttpRouter.add("POST", "/expire-session", expireSession),
  HttpRouter.add("GET", "/session-observation", observeSession)
);

/**
 * Loopback-only behavior control for the built-browser acceptance executable. This layer is never
 * composed into HttpLive and exposes no arbitrary User, proof, bearer, or SQL capability.
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
