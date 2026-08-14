import { Crypto, DateTime, Duration, Effect, Encoding } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { HostedTurnTokenId } from "~/core/tokens/reference";
import type { UserId } from "~/core/identity/reference";
import {
  HostedTurnScopes,
  PatIdleDuration,
  type TokenBearer,
  TokenSecret,
  TokenShortId,
  bearerSecretBytes,
  makeTokenBearer,
} from "~/core/tokens/model";
import { hashTokenBearer } from "~/shell/_shared/authz";
import {
  insertHostedTurnToken,
  revokeHostedTurnToken as persistHostedTurnTokenRevocation,
} from "./repo";

const hostedTokenBearerLifetimeMinutes = 15;

/** Absolute fallback lifetime if turn cleanup cannot revoke the internal bearer. */
export const HostedTurnTokenLifetime = Duration.minutes(hostedTokenBearerLifetimeMinutes);

type IssuedHostedTurnToken = {
  readonly tokenId: HostedTurnTokenId;
  readonly bearer: TokenBearer;
};

/**
 * Issues one all-scope internal TokenBearer for a hosted turn. The raw bearer is
 * returned only to the coordinating effect; persistence receives its digest.
 */
export const issueHostedTurnToken = Effect.fn("issueHostedTurnToken")(function* (
  subjectUserId: UserId,
  createdAt: DateTime.Utc
): Effect.fn.Return<IssuedHostedTurnToken, never, Crypto.Crypto | SqlClient.SqlClient> {
  const crypto = yield* Crypto.Crypto;
  const tokenId = HostedTurnTokenId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
  const shortId = TokenShortId.make(
    Encoding.encodeHex(yield* crypto.randomBytes(4).pipe(Effect.orDie))
  );
  const secret = TokenSecret.make(
    Encoding.encodeHex(yield* crypto.randomBytes(bearerSecretBytes).pipe(Effect.orDie))
  );
  const bearer = yield* makeTokenBearer({ shortId, secret });
  const tokenHash = yield* hashTokenBearer(bearer);
  const expiresAt = DateTime.addDuration(createdAt, HostedTurnTokenLifetime);
  // The shared table requires this PAT-only column; HostedTurnToken authorization ignores it.
  const storageIdleExpiresAt = DateTime.addDuration(createdAt, PatIdleDuration);

  yield* insertHostedTurnToken(subjectUserId, {
    tokenHash,
    storageIdleExpiresAt,
    id: tokenId,
    shortId,
    scopes: HostedTurnScopes.make(["read", "write", "dashboard"]),
    expiresAt,
    createdAt,
  });

  return { tokenId, bearer };
});

/** Revokes one turn-scoped HostedTurnToken through the token slice boundary. */
export const revokeHostedTurnToken = Effect.fn("revokeHostedTurnTokenOperation")(
  (subjectUserId: UserId, tokenId: HostedTurnTokenId, revokedAt: DateTime.Utc) =>
    persistHostedTurnTokenRevocation(subjectUserId, tokenId, revokedAt).pipe(Effect.asVoid)
);
