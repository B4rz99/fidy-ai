import { forwardAccess } from "./native-access";
import { forwardToken } from "./native-token";

import type { UserStoreBindings } from "../../directory/contract";
import { BootstrapUnavailable, oauthClientIdleMs } from "../contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Schema } from "effect";
import {
  OAuthAuthorization,
  OAuthRegistration,
  OAuthSource,
  oauthPaths,
} from "../../../src/shell/oauth-agents/contract";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { newId } from "../../secret-material/operations";
import {
  attemptLifetimeMs,
  invalidRequest,
  registerWithStore,
  registeredRedirect,
  requestedScopes,
} from "./bootstrap";
import { oauthResponse } from "./response";
import { discoveryResponse } from "./discovery";

const maximumBootstrapBytes = 16_384;

const minute = 60_000,
  leaseMs = 10_000;

const limits = {
  source: 60,
  global: 600,
  registrationSource: 10,
  registrationGlobal: 100,
  concurrent: 32,
  concurrentSource: 8,
} as const;

const begin = Effect.fn(function* (source: string, registration: boolean) {
  const sql = yield* SqliteClient;

  return yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`DELETE FROM oauth_leases WHERE expires_at_ms<=${now}`;
    const leases = yield* sql`SELECT 1 FROM oauth_leases LIMIT 1 OFFSET ${limits.concurrent - 1}`;

    if (leases.length !== 0) return Option.none<string>();

    const sourceLeases =
      yield* sql`SELECT 1 FROM oauth_leases WHERE source=${source} LIMIT 1 OFFSET ${
        limits.concurrentSource - 1
      }`;

    if (sourceLeases.length !== 0) return Option.none<string>();

    const sourceWindows = [
      { key: "oauth/source/" + source, limit: limits.source },
      { key: "oauth/global", limit: limits.global },
    ];

    const windows = registration
      ? [
          ...sourceWindows,
          { key: "oauth/reg/" + source, limit: limits.registrationSource },
          { key: "oauth/registration", limit: limits.registrationGlobal },
        ]
      : sourceWindows;

    const saturated = yield* Effect.forEach(
      windows,
      ({ key, limit }) =>
        sql`SELECT 1 FROM bootstrap_admissions WHERE scope=${key} AND expires_at_ms>${now} LIMIT 1 OFFSET ${limit - 1}`
    );

    if (saturated.some((full) => full.length !== 0)) return Option.none<string>();

    yield* Effect.forEach(
      windows,
      ({ key }) =>
        sql`INSERT INTO bootstrap_admissions(scope,expires_at_ms) VALUES(${key},${now + minute})`,
      { discard: true }
    );

    const id = newId();
    yield* sql`INSERT INTO oauth_leases(id,expires_at_ms,source) VALUES(${id},${now + leaseMs},${source})`;

    return Option.some(id);
  }).pipe(withStoreCapacity("required"));
});

const authorize = Effect.fn(function* (request: Request, source: string, browserOrigin: string) {
  const sql = yield* SqliteClient;
  const query = new URL(request.url).searchParams;

  if (new Set(query.keys()).size !== Array.from(query.keys()).length) return invalidRequest();

  const decoded = Schema.decodeUnknownOption(OAuthAuthorization, { onExcessProperty: "error" })(
    Object.fromEntries(query)
  );

  if (
    Option.isNone(decoded) ||
    Option.isNone(requestedScopes(Option.fromUndefinedOr(decoded.value.scope)))
  ) {
    return invalidRequest();
  }

  const attempt = decoded.value;

  return yield* Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;

    const [row] =
      yield* sql`SELECT metadata_json FROM oauth_public_clients WHERE id=${attempt.client_id} AND last_used_at_ms>${current - oauthClientIdleMs}`;

    if (row === undefined) return invalidRequest();

    const { metadata_json: client } = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ metadata_json: Schema.fromJsonString(OAuthRegistration) })
    )(row);

    if (
      !client.redirect_uris.some((uri) =>
        registeredRedirect({ registered: uri, requested: attempt.redirect_uri })
      )
    ) {
      return invalidRequest();
    }

    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(OAuthAuthorization))(attempt);
    const id = newId();

    const inserted =
      yield* sql`INSERT INTO oauth_review_requests(id,client_id,request_json,source_digest,created_at_ms,expires_at_ms) VALUES(${id},${attempt.client_id},${encoded},${source},${current},${current + attemptLifetimeMs}) RETURNING id`;

    if (inserted.length !== 1) return yield* new BootstrapUnavailable({ cause: Option.none() });
    yield* sql`UPDATE oauth_public_clients SET last_used_at_ms=${current} WHERE id=${attempt.client_id}`;

    return new Response(null, {
      status: 302,
      headers: {
        location: browserOrigin + "/oauth/review/" + id,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }).pipe(withStoreCapacity("growth"));
});

const registerPublic = Effect.fn(function* (request: Request) {
  const sql = yield* SqliteClient;
  const current = yield* Clock.currentTimeMillis;

  return yield* registerWithStore({
    request,
    current,
    persist: (id, encoded) =>
      sql`INSERT INTO oauth_public_clients VALUES(${id},${encoded},${current},${current}) RETURNING id`.pipe(
        Effect.flatMap((rows) =>
          rows.length === 1
            ? Effect.void
            : Effect.fail(new BootstrapUnavailable({ cause: Option.none() }))
        ),
        withStoreCapacity("growth"),
        Effect.mapError((cause) => new BootstrapUnavailable({ cause: Option.some(cause) }))
      ),
  });
});

export const nativePublicOAuth = Effect.fn(
  function* (input: {
    request: Request;
    browserOrigin: string;
    environment: UserStoreBindings;
    routeBrowser: () => Effect.Effect<Response>;
  }) {
    const { request } = input,
      path = new URL(request.url).pathname;

    if (new TextEncoder().encode(request.url).length > maximumBootstrapBytes) {
      return invalidRequest();
    }

    const source = Schema.decodeUnknownOption(OAuthSource)(request.headers.get("x-oauth-source"));

    if (Option.isNone(source)) {
      return oauthResponse({ body: { error: "temporarily_unavailable" }, status: 503 });
    }

    const sql = yield* SqliteClient;

    return yield* Effect.acquireUseRelease(
      begin(source.value, path === oauthPaths.register),
      (lease) =>
        Effect.gen(function* () {
          if (Option.isNone(lease)) {
            return oauthResponse({ body: { error: "slow_down" }, status: 429 });
          }

          if (path === oauthPaths.register) {
            return yield* registerPublic(request);
          }

          if (path === oauthPaths.authorize) {
            return yield* authorize(request, source.value, input.browserOrigin);
          }

          if (path === oauthPaths.mcp) {
            return yield* forwardAccess(request, input.environment.USER_STORE);
          }

          if (path === oauthPaths.token) {
            return yield* forwardToken(request, input.environment.USER_STORE);
          }

          if (path.startsWith("/web/oauth/")) {
            return yield* input.routeBrowser();
          }

          return discoveryResponse(path);
        }),
      (lease) =>
        Effect.forEach(
          Option.toArray(lease),
          (id) => sql`DELETE FROM oauth_leases WHERE id=${id}`
        ).pipe(Effect.tapError(Effect.logDebug), Effect.ignore)
    );
  },
  Effect.tapCause(Effect.logDebug),
  Effect.catchCause(() =>
    Effect.succeed(oauthResponse({ body: { error: "temporarily_unavailable" }, status: 503 }))
  )
);
