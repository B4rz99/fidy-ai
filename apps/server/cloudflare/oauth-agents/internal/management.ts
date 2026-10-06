import { OAuthRevocationAdmission } from "../contract";
import { DateTime, Effect, Option, Schema } from "effect";
import { OAuthConnectionId } from "../../../src/core/oauth-agents/contract";
import { PATScopes } from "../../../src/core/tokens/contract";
import { oauthScopeCopy } from "../../../src/core/oauth-agents/operations";
import {
  OAuthConnectionList,
  OAuthConnectionListQuery,
  OAuthConnectionMetadata,
  OAuthConnectionRevoke,
  OAuthConnectionRevokeAll,
  OAuthRegistration,
  oauthConnectionPageSize,
  oauthPaths,
} from "../../../src/shell/oauth-agents/contract";
import type { AuditUnavailable } from "../../../src/shell/audit/contract";
import { readOAuthActivity } from "../../../src/shell/audit/operations";
import { freshSessionConditions } from "../../../src/shell/web-session/operations";
import type { FreshSessionSubject } from "../../../src/shell/web-session/contract";
import { freshBrowserSession } from "../../web-session/operations";
import { type BootstrapInvalid, BootstrapUnavailable, dbWork, decodePayload } from "./bootstrap";
import { oauthResponse } from "./response";

type ManagementInput = Readonly<{
  request: Request;
  db: D1Database;
  browserOrigin: string;
  current: number;
  coordinator: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
  admitUser: (userId: string) => Effect.Effect<void, BootstrapUnavailable>;
}>;
type AuthorizedInput = ManagementInput & Readonly<{ session: FreshSessionSubject }>;
const ConnectionRow = Schema.Struct({
  id: OAuthConnectionId,
  claimed_client_name: OAuthRegistration.fields.client_name,
  scopes_json: Schema.String,
  expires_at_ms: Schema.DateTimeUtcFromMillis,
  revoked_at_ms: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
});
const permissionCopy = (
  scope: PATScopes[number]
): OAuthConnectionMetadata["permissions"][number] => ({
  scope,
  ...oauthScopeCopy[scope],
});
const connectionState = (
  row: typeof ConnectionRow.Type,
  current: number
): "revoked" | "expired" | "active" => {
  if (Option.isSome(row.revoked_at_ms)) return "revoked";
  return DateTime.toEpochMillis(row.expires_at_ms) <= current ? "expired" : "active";
};
const projectConnection = (
  input: AuthorizedInput,
  row: typeof ConnectionRow.Type
): Effect.Effect<OAuthConnectionMetadata, AuditUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    const scopes = yield* Schema.decodeEffect(Schema.fromJsonString(PATScopes))(row.scopes_json);
    const recentActivity = yield* readOAuthActivity({
      db: input.db,
      userId: input.session.user_id,
      connectionId: row.id,
      guard: freshSessionConditions(input),
    });
    return yield* Schema.decodeUnknownEffect(Schema.toType(OAuthConnectionMetadata))({
      connectionId: row.id,
      claimedClientName: row.claimed_client_name,
      scopes,
      permissions: scopes.map(permissionCopy),
      expiresAt: row.expires_at_ms,
      state: connectionState(row, input.current),
      recentActivity,
    });
  });
const listConnections = (
  input: AuthorizedInput
): Effect.Effect<Response, BootstrapUnavailable | AuditUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    const query = new URL(input.request.url).searchParams;
    if (new Set(query.keys()).size !== Array.from(query.keys()).length) {
      return oauthResponse({ body: { error: "invalid_request" }, status: 400 });
    }
    const decoded = yield* Schema.decodeEffect(OAuthConnectionListQuery, {
      onExcessProperty: "error",
    })(Object.fromEntries(query));
    const guard = freshSessionConditions(input);
    const results = yield* dbWork(() =>
      input.db.batch([
        input.db.prepare(`SELECT 1 AS live WHERE ${guard.sql}`).bind(...guard.params),
        input.db
          .prepare(`SELECT id,claimed_client_name,scopes_json,expires_at_ms,revoked_at_ms FROM oauth_connections
      WHERE user_id = ? AND id > ? AND ${guard.sql} ORDER BY id LIMIT 26`)
          .bind(
            input.session.user_id,
            Option.getOrElse(decoded.after, () => ""),
            ...guard.params
          ),
      ])
    );
    if (results[0]?.results.length !== 1) {
      return oauthResponse({ body: { error: "unauthenticated" }, status: 401 });
    }
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(ConnectionRow).check(Schema.isMaxLength(oauthConnectionPageSize + 1))
    )(results[1]?.results).pipe(Effect.mapError(() => new BootstrapUnavailable()));
    const page = rows.slice(0, oauthConnectionPageSize);
    const connections = yield* Effect.forEach(page, (row) => projectConnection(input, row));
    const body = yield* Schema.decodeEffect(Schema.toType(OAuthConnectionList))({
      connections,
      nextCursor:
        rows.length > oauthConnectionPageSize
          ? Option.fromUndefinedOr(page.at(-1)?.id)
          : Option.none(),
    });
    return oauthResponse({
      body: yield* Schema.encodeEffect(OAuthConnectionList)(body),
      status: 200,
    });
  });
const managementDeadlineMs = 5000;
const requestRevocation = (
  input: AuthorizedInput
): Effect.Effect<Response, BootstrapInvalid | BootstrapUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    const all = new URL(input.request.url).pathname === oauthPaths.revokeAll;
    const connectionId = all
      ? yield* decodePayload({ request: input.request, schema: OAuthConnectionRevokeAll }).pipe(
          Effect.as(Option.none<OAuthConnectionId>())
        )
      : Option.some(
          (yield* decodePayload({
            request: input.request,
            schema: OAuthConnectionRevoke,
          })).connectionId
        );
    const admission = yield* Schema.decodeUnknownEffect(Schema.toType(OAuthRevocationAdmission))({
      userId: input.session.user_id,
      sessionId: input.session.id,
      connectionId,
      deadlineAtMs: input.current + managementDeadlineMs,
    });
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(OAuthRevocationAdmission))(
      admission
    );
    return yield* Effect.tryPromise({
      try: (signal) =>
        input.coordinator.getByName(admission.userId).fetch(
          new Request("https://coordinator.internal/oauth-revoke", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            signal,
          })
        ),
      catch: () => new BootstrapUnavailable(),
    });
  });
/** Browser management never accepts agent authority, even for an otherwise valid OAuth bearer. */
export const manageConnections = (
  input: ManagementInput
): Effect.Effect<Response, BootstrapUnavailable | AuditUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    if (input.request.headers.get("origin") !== input.browserOrigin) {
      return oauthResponse({ body: { error: "forbidden_origin" }, status: 403 });
    }
    const session = yield* dbWork(() => freshBrowserSession(input));
    if (Option.isNone(session)) {
      return oauthResponse({ body: { error: "unauthenticated" }, status: 401 });
    }
    yield* input.admitUser(session.value.user_id);
    if (new URL(input.request.url).pathname !== oauthPaths.connections) {
      return yield* requestRevocation({ ...input, session: session.value }).pipe(
        Effect.catchTag("BootstrapInvalid", () =>
          Effect.succeed(oauthResponse({ body: { error: "invalid_request" }, status: 400 }))
        )
      );
    }
    return yield* listConnections({ ...input, session: session.value });
  });
