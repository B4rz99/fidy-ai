import { Crypto, DateTime, Duration, Effect, Encoding } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { AgentTokenId } from "~/core/_shared/agent-token";
import type { UserId } from "~/core/_shared/user";
import {
  AgentBearerSecret,
  type AgentBearerToken,
  HostedAgentScopes,
  AgentTokenShortId,
  makeAgentBearerToken,
} from "~/core/tokens/model";
import { renewAgentTokenIdleExpiry } from "~/core/tokens/rules";
import { hashAgentBearer } from "~/shell/_shared/authz";
import {
  insertHostedAgentToken,
  revokeHostedAgentToken as persistHostedAgentTokenRevocation,
} from "./repo";

/** Absolute fallback lifetime if turn cleanup cannot revoke the internal bearer. */
export const HostedAgentTokenLifetime = Duration.minutes(15);

type IssuedHostedAgentToken = {
  readonly tokenId: AgentTokenId;
  readonly bearer: AgentBearerToken;
};

/**
 * Issues one all-scope internal AgentToken for a hosted turn. The raw bearer is
 * returned only to the coordinating effect; persistence receives its digest.
 */
export const issueHostedAgentToken = Effect.fn("issueHostedAgentToken")(function* (
  subjectUserId: UserId,
  createdAt: DateTime.Utc
): Effect.fn.Return<IssuedHostedAgentToken, never, Crypto.Crypto | SqlClient.SqlClient> {
  const crypto = yield* Crypto.Crypto;
  const tokenId = AgentTokenId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
  const shortId = AgentTokenShortId.make(
    Encoding.encodeHex(yield* crypto.randomBytes(4).pipe(Effect.orDie))
  );
  const secret = AgentBearerSecret.make(
    Encoding.encodeHex(yield* crypto.randomBytes(32).pipe(Effect.orDie))
  );
  const bearer = yield* makeAgentBearerToken({ shortId, secret });
  const tokenHash = yield* hashAgentBearer(bearer);
  const expiresAt = DateTime.addDuration(createdAt, HostedAgentTokenLifetime);
  const storageIdleExpiresAt = yield* renewAgentTokenIdleExpiry(createdAt);

  yield* insertHostedAgentToken(subjectUserId, {
    tokenHash,
    storageIdleExpiresAt,
    id: tokenId,
    shortId,
    scopes: HostedAgentScopes.make(["read", "write", "dashboard"]),
    expiresAt,
    createdAt,
  });

  return { tokenId, bearer };
});

/** Revokes one turn-scoped hosted bearer through the token slice boundary. */
export const revokeHostedAgentToken = Effect.fn("revokeHostedAgentTokenOperation")(
  (subjectUserId: UserId, tokenId: AgentTokenId, revokedAt: DateTime.Utc) =>
    persistHostedAgentTokenRevocation(subjectUserId, tokenId, revokedAt).pipe(Effect.asVoid)
);
