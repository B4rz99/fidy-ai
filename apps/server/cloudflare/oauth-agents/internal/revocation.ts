import { Clock, Effect, Option } from "effect";
import type { OAuthConnectionId } from "../../../src/core/oauth-agents/contract";
import type { FreshSessionSubject } from "../../../src/shell/web-session/contract";
import { freshSessionConditions } from "../../../src/shell/web-session/operations";
import {
  oauthUserRevocationProof,
  revokeOAuthUserConsent,
} from "../../../src/shell/consent/operations";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { type BootstrapUnavailable, dbWork, invalidRequest } from "./bootstrap";
import { oauthResponse } from "./response";

const maximumRevocations = 1024;
type RevocationInput = Readonly<{
  connectionId: Option.Option<OAuthConnectionId>;
  db: D1Database;
  current: number;
  session: FreshSessionSubject;
}>;
type RevocationPlan = RevocationInput &
  Readonly<{
    all: boolean;
    reason: "user_all" | "user_one";
    guard: OwnedStatement;
    owned: OwnedStatement;
    selection: OwnedStatement;
  }>;
const commitRevocation = (input: RevocationPlan): Effect.Effect<unknown, BootstrapUnavailable> => {
  const { all, reason, guard, owned, selection } = input;
  const evidence = revokeOAuthUserConsent({
    session: input.session,
    current: input.current,
    reason,
    selection,
  });
  const proof = oauthUserRevocationProof({
    session: input.session,
    current: input.current,
    reason,
  });
  return dbWork(() =>
    input.db.batch([
      input.db
        .prepare(
          `INSERT INTO oauth_atomic_assertion VALUES (1,CASE WHEN ${guard.sql} AND (SELECT count(*) FROM (${selection.sql})) <= ? AND (? = 1 OR EXISTS (${owned.sql})) THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`
        )
        .bind(
          ...guard.params,
          ...selection.params,
          maximumRevocations,
          all ? 1 : 0,
          ...owned.params
        ),
      input.db.prepare(evidence.sql).bind(...evidence.params),
      input.db
        .prepare(
          `UPDATE oauth_connections SET revoked_at_ms = ? WHERE id IN (${proof.sql}) AND user_id = ? AND revoked_at_ms IS NULL AND ${guard.sql}`
        )
        .bind(input.current, ...proof.params, input.session.user_id, ...guard.params),
      input.db
        .prepare(
          `INSERT INTO oauth_atomic_assertion VALUES (1,CASE WHEN NOT EXISTS (${selection.sql}) THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`
        )
        .bind(...selection.params),
    ])
  ).pipe(Effect.uninterruptible);
};
/** Rechecks browser authority, ownership and bounded selection with append-only evidence in one atomic D1 unit. A racing refresh can commit first, but every generation becomes unusable after this unit. */
export const revokeConnections = (
  admitted: RevocationInput
): Effect.Effect<Response, BootstrapUnavailable> =>
  Effect.gen(function* () {
    const connectionId = admitted.connectionId;
    const all = Option.isNone(connectionId);
    const input = { ...admitted, current: yield* Clock.currentTimeMillis };
    const reason = all ? "user_all" : "user_one";
    const guard = freshSessionConditions(input);
    const identity = Option.match(connectionId, {
      onNone: () => ({ sql: "1 = 1", params: [] }),
      onSome: (id) => ({ sql: "id = ?", params: [id] }),
    });
    const owned = {
      sql: `SELECT id AS connection_id,user_id FROM oauth_connections WHERE user_id = ? AND ${identity.sql}`,
      params: [input.session.user_id, ...identity.params],
    };
    const selection = {
      sql: `${owned.sql} AND revoked_at_ms IS NULL AND ${guard.sql} LIMIT ${maximumRevocations + 1}`,
      params: [...owned.params, ...guard.params],
    };
    const accepted = yield* Effect.option(
      commitRevocation({ ...input, all, reason, guard, owned, selection })
    );
    if (Option.isSome(accepted)) return oauthResponse({ body: { revoked: true }, status: 200 });
    // A missing owned identity is a refusal, not success or another User's metadata.
    const exists = yield* dbWork(() =>
      input.db
        .prepare(`SELECT 1 FROM (${owned.sql}) WHERE ${guard.sql}`)
        .bind(...owned.params, ...guard.params)
        .first()
    );
    return !all && exists === null
      ? invalidRequest()
      : oauthResponse({ body: { error: "temporarily_unavailable" }, status: 503 });
  });
