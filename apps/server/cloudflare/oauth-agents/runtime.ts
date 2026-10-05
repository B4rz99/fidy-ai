import { Clock, Effect, Option, type PlatformError, Schema } from "effect";
import {
  OAuthSource,
  oauthIssuer,
  oauthPaths,
  oauthResource,
} from "../../src/shell/oauth-agents/contract";
import {
  type ResourceAdmissionAuthorityConfig,
  ResourceAdmissionCharges,
  ResourceAdmissionEpochMs,
  type ResourceAdmissionGrant,
  ResourceAdmissionGrantId,
  ResourceAdmissionPolicies,
  type ResourceAdmissionRefused,
  type ResourceAdmissionUnavailable,
} from "../resource-admission/contract";
import { admitResource, releaseOutstandingResource } from "../resource-admission/operations";
import { awaitRequestAbort } from "../http/operations";
import { newId } from "../secret-material/operations";
import { oauthResponse as response } from "./internal/response";
import { manageConnections } from "./internal/management";
import { reviewRequest } from "./internal/review";
import { handleMcpRequest } from "../mcp/runtime";
import { exchangeToken } from "./internal/exchange";
import {
  type BootstrapInvalid,
  BootstrapUnavailable,
  invalidRequest,
  registerClient,
  startAuthorization,
} from "./internal/bootstrap";

type BootstrapInput = Readonly<{
  request: Request;
  db: D1Database;
  browserOrigin: string;
  coordinator: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
}>;
type AdmissionFailure =
  | ResourceAdmissionRefused
  | ResourceAdmissionUnavailable
  | Schema.SchemaError;
type BootstrapFailure =
  | AdmissionFailure
  | BootstrapInvalid
  | BootstrapUnavailable
  | PlatformError.PlatformError;
const successStatus = 200;
const maximumBootstrapBytes = 16384;
const unavailableStatus = 503;
const rateLimitedStatus = 429;
const policies = Schema.decodeSync(ResourceAdmissionPolicies)([
  {
    key: "oauth.source.v1",
    kind: "rolling_window",
    dimension: "source",
    durationMs: 60000,
    limit: 60,
  },
  {
    key: "oauth.global.v1",
    kind: "rolling_window",
    dimension: "operation",
    durationMs: 60000,
    limit: 600,
  },
  {
    key: "oauth.registration-source.v1",
    kind: "rolling_window",
    dimension: "source",
    durationMs: 60000,
    limit: 10,
  },
  {
    key: "oauth.registration-global.v1",
    kind: "rolling_window",
    dimension: "operation",
    durationMs: 60000,
    limit: 100,
  },
  {
    key: "oauth.user.v1",
    kind: "rolling_window",
    dimension: "stable_user",
    durationMs: 60000,
    limit: 60,
  },
  {
    key: "oauth.concurrent.v1",
    kind: "outstanding",
    dimension: "outstanding_work",
    leaseMs: 10000,
    limit: 32,
  },
]);
const authority = (db: D1Database, clock: Clock.Clock): ResourceAdmissionAuthorityConfig => ({
  database: db,
  policies,
  nowEpochMs: () => ResourceAdmissionEpochMs.make(clock.currentTimeMillisUnsafe()),
});
const charge = (
  input: Readonly<{ db: D1Database; source: string; kind: "bootstrap" | "registration" | "user" }>
): Effect.Effect<ResourceAdmissionGrant, AdmissionFailure> =>
  Effect.gen(function* () {
    const keys =
      input.kind === "registration"
        ? ["oauth.registration-source.v1", "oauth.registration-global.v1"]
        : ["oauth.source.v1", "oauth.global.v1", "oauth.concurrent.v1"];
    const claims =
      input.kind === "user"
        ? [{ policyKey: "oauth.user.v1", scopeKey: input.source, units: 1 }]
        : keys.map((policyKey, index) => ({
            policyKey,
            scopeKey: index === 0 ? input.source : "oauth",
            units: 1,
          }));
    return yield* admitResource(authority(input.db, yield* Clock.Clock), {
      grantId: ResourceAdmissionGrantId.make(newId()),
      charges: yield* Schema.decodeUnknownEffect(ResourceAdmissionCharges)(claims),
      statements: [],
    });
  });
const discoveryResponse = (path: string): Response => {
  if (path === oauthPaths.resource) {
    return response({
      status: successStatus,
      body: {
        resource: oauthResource,
        authorization_servers: [oauthIssuer],
        scopes_supported: ["read"],
        bearer_methods_supported: ["header"],
      },
    });
  }
  if (path === oauthPaths.issuer) {
    return response({
      status: successStatus,
      body: {
        issuer: oauthIssuer,
        authorization_endpoint: `${oauthIssuer}${oauthPaths.authorize}`,
        token_endpoint: `${oauthIssuer}${oauthPaths.token}`,
        registration_endpoint: `${oauthIssuer}${oauthPaths.register}`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["read", "write", "dashboard"],
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: false,
      },
    });
  }
  if (path === oauthPaths.mcp) {
    return new Response(null, {
      status: 401,
      headers: {
        "www-authenticate": `Bearer resource_metadata="${oauthIssuer}${oauthPaths.resource}", scope="read"`,
      },
    });
  }
  return response({ body: { error: "temporarily_unavailable" }, status: unavailableStatus });
};
const executeManagement = (
  input: BootstrapInput,
  current: number
): Effect.Effect<Response, BootstrapUnavailable> =>
  manageConnections({
    ...input,
    current,
    admitUser: (userId) =>
      charge({ db: input.db, source: userId, kind: "user" }).pipe(
        Effect.asVoid,
        Effect.mapError(() => new BootstrapUnavailable())
      ),
  }).pipe(
    Effect.raceFirst(awaitRequestAbort(input.request)),
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(new BootstrapUnavailable()),
    }),
    Effect.mapError(() => new BootstrapUnavailable())
  );
const executeBootstrap = (
  input: BootstrapInput & Readonly<{ source: string }>
): Effect.Effect<Response, BootstrapFailure> =>
  Effect.gen(function* () {
    const path = new URL(input.request.url).pathname;
    const current = yield* Clock.currentTimeMillis;
    if (path === oauthPaths.register) {
      yield* charge({ ...input, kind: "registration" });
      return yield* registerClient({ ...input, current });
    }
    if (
      [oauthPaths.review, oauthPaths.cancel, oauthPaths.connect].some((owned) => owned === path)
    ) {
      return yield* reviewRequest({
        ...input,
        current,
        admitUser: (userId) =>
          charge({ db: input.db, source: userId, kind: "user" }).pipe(Effect.asVoid),
      });
    }
    if (
      [oauthPaths.connections, oauthPaths.revoke, oauthPaths.revokeAll].some(
        (owned) => owned === path
      )
    ) {
      return yield* executeManagement(input, current);
    }
    if (path === oauthPaths.authorize) return yield* startAuthorization({ ...input, current });
    if (path === oauthPaths.token) {
      if (input.request.signal.aborted) return invalidRequest();
      return yield* exchangeToken({
        ...input,
        current,
        admitUser: (userId) =>
          charge({ db: input.db, source: userId, kind: "user" }).pipe(
            Effect.asVoid,
            Effect.mapError(() => new BootstrapUnavailable())
          ),
      }).pipe(
        Effect.raceFirst(awaitRequestAbort(input.request)),
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail(new BootstrapUnavailable()),
        }),
        Effect.mapError(() => new BootstrapUnavailable())
      );
    }
    if (path === oauthPaths.mcp) return yield* handleMcpRequest(input);
    return discoveryResponse(path);
  });
/** Bounds OAuth/MCP ingress before resolving authority; canonical work admits its own shared User budget. */
export const handleOAuthRequest = (input: BootstrapInput): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (new TextEncoder().encode(input.request.url).length > maximumBootstrapBytes) {
      return invalidRequest();
    }
    const source = Schema.decodeUnknownOption(OAuthSource)(
      input.request.headers.get("x-oauth-source")
    );
    if (Option.isNone(source)) {
      return response({ body: { error: "temporarily_unavailable" }, status: unavailableStatus });
    }
    const clock = yield* Clock.Clock;
    return yield* Effect.acquireUseRelease(
      charge({ db: input.db, source: source.value, kind: "bootstrap" }),
      () => executeBootstrap({ ...input, source: source.value }),
      (grant) =>
        releaseOutstandingResource(authority(input.db, clock), {
          grantId: grant.grantId,
          statements: [],
        }).pipe(Effect.ignore)
    );
  }).pipe(
    Effect.catchTags({
      SchemaError: () => Effect.succeed(invalidRequest()),
      BootstrapInvalid: () => Effect.succeed(invalidRequest()),
      ResourceAdmissionRefused: () =>
        Effect.succeed(response({ body: { error: "slow_down" }, status: rateLimitedStatus })),
    }),
    Effect.catchCause(() =>
      Effect.succeed(
        response({ body: { error: "temporarily_unavailable" }, status: unavailableStatus })
      )
    )
  );
