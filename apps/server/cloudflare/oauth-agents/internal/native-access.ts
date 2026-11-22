import type { UserStoreBindings } from "../../directory/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Redacted, Schema } from "effect";
import { Hex } from "effect/encoding";
import { type OAuthCaller, oauthResource } from "../../../src/shell/oauth-agents/contract";
import { OAuthClientId } from "../../../src/core/oauth-agents/contract";
import { PATScopes } from "../../../src/core/tokens/contract";
import { activeProUserCondition } from "../../../src/shell/access-tier/operations";
import { liveOAuthCommitAuthority } from "../../../src/shell/oauth-agents/operations";
import { secretDigest } from "../../secret-material/operations";
import { OAuthMcpCallerUnavailable } from "../contract";
import { Destination } from "./native-registration";

const accessRef = "fidy-internal-oauth-record",
  connectionRef = "fidy-internal-oauth-connection",
  userRef = "fidy-internal-oauth-user";

const bearer = Effect.fn(function* (request: Request) {
  const authorization = request.headers.get("authorization") ?? "";

  if (!/^Bearer [A-Za-z0-9_-]{43}$/u.test(authorization)) return Option.none<Uint8Array>();

  return Option.some(
    yield* secretDigest({
      purpose: "oauth-access",
      value: Redacted.make(authorization.slice("Bearer ".length)),
    })
  );
});

export const denied = (): Response =>
  new Response(null, {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate":
        'Bearer resource_metadata="https://api.fidyapp.com/.well-known/oauth-protected-resource/mcp", scope="read"',
    },
  });

export const forwardAccess = Effect.fn(function* (
  request: Request,
  users: UserStoreBindings["USER_STORE"]
) {
  const proof = yield* bearer(request);

  if (Option.isNone(proof)) return denied();
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT user_id,connection_id,record_id FROM oauth_routes WHERE kind='access' AND digest=${Hex.encode(proof.value)} AND expires_at_ms>${yield* Clock.currentTimeMillis}`;

  if (row === undefined) return denied();
  const route = yield* Schema.decodeUnknownEffect(Destination)(row);
  const headers = new Headers(request.headers);
  headers.set(accessRef, route.record_id);
  headers.set(connectionRef, route.connection_id);
  headers.set(userRef, route.user_id);

  return yield* Effect.tryPromise((signal) =>
    users.getByName(route.user_id).fetch(new Request(request, { headers, signal }))
  );
});

export const accessSubject = Effect.fn(function* (
  request: Request,
  owns: (user: string) => boolean
) {
  const bound = Schema.decodeUnknownOption(Destination)({
    record_id: request.headers.get(accessRef),
    connection_id: request.headers.get(connectionRef),
    user_id: request.headers.get(userRef),
  });

  const proof = yield* bearer(request);

  if (Option.isNone(bound) || Option.isNone(proof) || !owns(bound.value.user_id)) {
    return Option.none<OAuthCaller>();
  }

  const sql = yield* SqliteClient;

  const {
    user_id: userId,
    connection_id: oauthConnectionId,
    record_id: credentialId,
  } = bound.value;

  const [row] =
    yield* sql`SELECT g.client_id FROM oauth_credentials a JOIN oauth_connections g ON g.id=a.connection_id AND g.user_id=a.user_id WHERE a.kind='access' AND a.id=${credentialId} AND a.digest=${proof.value} AND a.user_id=${userId} AND a.connection_id=${oauthConnectionId}`;

  if (row === undefined) return Option.none<OAuthCaller>();

  const { client_id: clientId } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ client_id: OAuthClientId })
  )(row);

  return Option.some({
    userId,
    clientId,
    oauthConnectionId,
    credentialId,
    digest: proof.value,
    resource: oauthResource,
    requiredScope: Option.none(),
  } satisfies OAuthCaller);
});

export const nativeCaller = Effect.fn(
  function* (input: { subject: OAuthCaller; current: number }) {
    const authority = liveOAuthCommitAuthority(input),
      sql = yield* SqliteClient;

    const paid = activeProUserCondition({
      userId: input.subject.userId,
      nowEpochMs: input.current,
    });

    const [row] = yield* sql.unsafe(
      `SELECT scopes_json,expires_at_ms,(SELECT expires_at_ms FROM oauth_connections g WHERE g.id=oauth_credentials.connection_id) as grant_expiry,CASE WHEN ${paid.sql} THEN 1 ELSE 0 END AS pro FROM ${authority.table} WHERE ${authority.predicate}
       AND NOT EXISTS (SELECT value FROM json_each(oauth_credentials.scopes_json)
         EXCEPT SELECT value FROM oauth_connections g, json_each(g.scopes_json) WHERE g.id=oauth_credentials.connection_id AND g.user_id=oauth_credentials.user_id)`,
      [...paid.params, ...authority.bindings]
    );

    if (row === undefined) return Option.none();

    const value = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        scopes_json: Schema.fromJsonString(PATScopes),
        expires_at_ms: Schema.DateTimeUtcFromMillis,
        grant_expiry: Schema.DateTimeUtcFromMillis,
        pro: Schema.Literals([0, 1]),
      })
    )(row);

    return Option.some({
      scopes: value.scopes_json,
      tier: value.pro === 1 ? ("pro" as const) : ("free" as const),
      credentialExpiresAt: value.expires_at_ms,
      grantExpiresAt: value.grant_expiry,
    });
  },
  Effect.tapError(Effect.logDebug),
  Effect.mapError(() => new OAuthMcpCallerUnavailable())
);
