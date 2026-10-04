import { Effect, Option, Schema } from "effect";
import { OAuthQueryCallerUnavailable } from "../contract";
import type { OAuthCaller } from "../../../src/shell/oauth-agents/contract";
import { liveOAuthAuthority } from "../../../src/shell/oauth-agents/operations";
import { activeProUserCondition } from "../../../src/shell/access-tier/operations";
import { PATScopes } from "../../../src/core/tokens/contract";
import type { SuggestedOperationCaller } from "../../../src/shell/canonical-operations/operations";

const Snapshot = Schema.Struct({
  scopes: Schema.fromJsonString(PATScopes),
  pro: Schema.Literals([0, 1]),
});
/** Current OAuth-owned capability and derived-tier facts, never a reusable authorization grant. */
export const queryCallerSnapshot = (
  input: Readonly<{ db: D1Database; subject: OAuthCaller; current: number }>
): Effect.Effect<Option.Option<SuggestedOperationCaller>, OAuthQueryCallerUnavailable> =>
  Effect.gen(function* () {
    const authority = liveOAuthAuthority(input);
    const pro = activeProUserCondition({ userId: input.subject.userId, nowEpochMs: input.current });
    const row = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          `SELECT scopes_json AS scopes, CASE WHEN ${pro.sql} THEN 1 ELSE 0 END AS pro FROM ${authority.table} WHERE ${authority.predicate}`
        )
        .bind(...pro.params, ...authority.bindings)
        .first()
    );
    if (row === null) return Option.none();
    const decoded = yield* Schema.decodeUnknownEffect(Snapshot)(row);
    return Option.some({
      accessCaller: { _tag: "OAuthAgent" as const, capabilities: decoded.scopes },
      tier: decoded.pro === 1 ? ("pro" as const) : ("free" as const),
    });
  }).pipe(Effect.mapError(() => new OAuthQueryCallerUnavailable()));
