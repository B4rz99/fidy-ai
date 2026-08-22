import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { type Config, Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { type SqlError, SqlSchema } from "effect/unstable/sql";
import { BrowserLoginPublicCode } from "~/core/browser-login/rules";
import { MigrationSqlClient, PgLive } from "~/shell/db/client";
import { maximumPublicRequestBodySizeBytes } from "~/shell/runtime";

const acceptanceUserId = "24000000-0000-4000-8000-000000000241";

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

const ControlRoutesLive = Layer.mergeAll(
  HttpRouter.add("POST", "/reset", reset),
  HttpRouter.add("POST", "/approve-pairing", approvePairing),
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
