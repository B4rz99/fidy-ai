import { Effect, Option, Schema } from "effect";
import type { OAuthCaller } from "../../../src/shell/oauth-agents/contract";
import { liveOAuthAuthority } from "../../../src/shell/oauth-agents/operations";
import { PATScopes } from "../../../src/core/tokens/contract";
import { type OAuthMcpCallerFacts, OAuthMcpCallerUnavailable } from "../contract";
import { activeProUserCondition } from "../../../src/shell/access-tier/operations";

const RetainedLifetime = Schema.Struct({
  scopes: Schema.fromJsonString(PATScopes),
  credentialExpiresAt: Schema.DateTimeUtcFromMillis,
  grantExpiresAt: Schema.DateTimeUtcFromMillis,
  pro: Schema.Literals([0, 1]),
});
/** Resolve current MCP admission and real retained expiry through the OAuth owner's live guard. */
export const mcpCallerSnapshot = (
  input: Readonly<{ db: D1Database; subject: OAuthCaller; current: number }>
): Effect.Effect<Option.Option<OAuthMcpCallerFacts>, OAuthMcpCallerUnavailable> =>
  Effect.gen(function* () {
    const authority = liveOAuthAuthority(input);
    const pro = activeProUserCondition({ userId: input.subject.userId, nowEpochMs: input.current });
    const row = yield* Effect.tryPromise(() =>
      input.db
        .prepare(`SELECT scopes_json AS scopes, expires_at_ms AS credentialExpiresAt,
          (SELECT g.expires_at_ms FROM oauth_connections g
            WHERE g.id = oauth_access_credentials.connection_id) AS grantExpiresAt,
          CASE WHEN ${pro.sql} THEN 1 ELSE 0 END AS pro
          FROM ${authority.table} WHERE ${authority.predicate}`)
        .bind(...pro.params, ...authority.bindings)
        .first()
    );
    if (row === null) return Option.none();
    const lifetime = yield* Schema.decodeUnknownEffect(RetainedLifetime)(row);
    return Option.some({
      scopes: lifetime.scopes,
      credentialExpiresAt: lifetime.credentialExpiresAt,
      grantExpiresAt: lifetime.grantExpiresAt,
      tier: lifetime.pro === 1 ? ("pro" as const) : ("free" as const),
    });
  }).pipe(Effect.mapError(() => new OAuthMcpCallerUnavailable()));
