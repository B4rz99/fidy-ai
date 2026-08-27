import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { type Config, ConfigProvider, DateTime, Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { type SqlError, SqlSchema } from "effect/unstable/sql";
import { BrowserLoginPublicCode } from "~/core/browser-login/rules";
import { categoryIds } from "~/core/categories/taxonomy";
import { UserId } from "~/core/identity/reference";
import { makeColombianUser } from "~/core/identity/rules";
import { MigrationSqlClient, PgLive } from "~/shell/db/client";
import { maximumPublicRequestBodySizeBytes } from "~/shell/runtime";
import { upsertStableUserFixture } from "./identity-fixtures";

const acceptanceUserId = UserId.make("24000000-0000-4000-8000-000000000241");

const ApprovePairingRequest = Schema.Struct({ publicCode: BrowserLoginPublicCode });
const ApprovedPairing = Schema.Struct({ publicCode: BrowserLoginPublicCode });
const SessionObservation = Schema.Struct({
  sessionCount: Schema.Int,
  revoked: Schema.Boolean,
});

const createdStatus = 201;
const noContentStatus = 204;
const conflictStatus = 409;

const reset = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`DELETE FROM consent_records
    WHERE subject_user_id = ${acceptanceUserId}
      AND revoked_grant_id IN (
        SELECT id FROM consent_records
        WHERE subject_user_id = ${acceptanceUserId} AND grant_type = 'pat'
      )`;
  yield* sql`DELETE FROM consent_records
    WHERE subject_user_id = ${acceptanceUserId} AND grant_type = 'pat'`;
  yield* sql`DELETE FROM audit_log_entries WHERE user_id = ${acceptanceUserId}`;
  yield* sql`DELETE FROM tokens WHERE user_id = ${acceptanceUserId}`;
  yield* sql`DELETE FROM pat_pairings WHERE user_id = ${acceptanceUserId}`;
  yield* sql`DELETE FROM web_sessions WHERE user_id = ${acceptanceUserId}`;
  yield* sql`TRUNCATE browser_login_start_attempts, browser_login_pairings`;
  yield* sql`DELETE FROM transactions WHERE user_id = ${acceptanceUserId}`;
  const user = yield* makeColombianUser(acceptanceUserId, {
    createdAt: yield* DateTime.now,
    paidTier: "free",
  });
  yield* upsertStableUserFixture(acceptanceUserId, user);
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

const seedCurrentMonthTransaction = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`
    INSERT INTO transactions (
      user_id, amount, currency, counterparty, direction, category_id, occurred_at
    )
    VALUES (
      ${acceptanceUserId}, 9007199254740993.12, 'USD', 'Exactitud S.A.', 'inflow',
      ${categoryIds.restaurantes}, now() - interval '1 minute'
    )
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
  HttpRouter.add("POST", "/expire-session", expireSession),
  HttpRouter.add("POST", "/seed-current-month-transaction", seedCurrentMonthTransaction),
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
