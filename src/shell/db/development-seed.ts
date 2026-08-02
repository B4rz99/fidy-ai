import { Crypto, DateTime, Effect, Encoding, Layer, Option } from "effect";
import { E164PhoneNumber, UserId } from "~/core/identity/reference";
import { AgentTokenId } from "~/core/tokens/reference";
import { makeColombianUser } from "~/core/identity/rules";
import {
  AgentBearerSecret,
  type AgentBearerToken,
  AgentTokenScopes,
  AgentTokenShortId,
  getAgentTokenShortId,
  makeAgentBearerToken,
} from "~/core/tokens/model";
import { renewAgentTokenIdleExpiry } from "~/core/tokens/rules";
import { hashAgentBearer } from "~/shell/_shared/authz";
import { associateWhatsAppIdentity, upsertUser } from "~/shell/identity/repo";
import { type AgentTokenHash, upsertAgentToken } from "~/shell/tokens/repo";
import { MigrationPgLive, MigratorLive } from "./client";

/** The stable User used by the local development seed and API-seam tests. */
export const defaultUserId = UserId.make("f1d1a000-0000-4000-8000-000000000001");

/** The normalized WhatsApp identity associated with the development User. */
export const defaultWhatsAppPhone = E164PhoneNumber.make("+573001234567");

const defaultCreatedAt = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
/** Stable AgentToken id behind the local development and API-seam bearer. */
export const defaultAgentTokenId = AgentTokenId.make("f1d1a000-0000-4000-8000-000000000002");
const defaultAgentScopes = AgentTokenScopes.make(["read", "write", "dashboard"]);

/**
 * Generates the one-time development bearer from platform cryptographic bytes.
 * The caller must disclose it only through the local seed command; this function
 * neither persists nor logs the bearer.
 */
export const generateDevelopmentAgentBearer = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const shortId = Encoding.encodeHex(yield* crypto.randomBytes(4));
  const secret = Encoding.encodeHex(yield* crypto.randomBytes(32));

  return yield* makeAgentBearerToken({
    shortId: AgentTokenShortId.make(shortId),
    secret: AgentBearerSecret.make(secret),
  });
});

const tokenIdFromHash = (tokenHash: AgentTokenHash) =>
  AgentTokenId.make(
    `${tokenHash.slice(0, 8)}-${tokenHash.slice(8, 12)}-4${tokenHash.slice(13, 16)}-8${tokenHash.slice(17, 20)}-${tokenHash.slice(20, 32)}`
  );

/**
 * Seeds one stable User and one hashed AgentToken through slice-owned
 * persistence operations. The full bearer and secret never enter persistence;
 * only its digest and safe naming id cross that boundary. Tests override only
 * the grant facts they need.
 */
export const seedAgentIdentity = (
  overrides: Readonly<{
    readonly bearer: AgentBearerToken;
    readonly userId?: UserId;
    readonly tokenId?: AgentTokenId;
    readonly scopes?: AgentTokenScopes;
    readonly tokenCreatedAt?: DateTime.Utc;
    readonly idleExpiresAt?: DateTime.Utc;
    readonly revokedAt?: Option.Option<DateTime.Utc>;
  }>
) =>
  Effect.gen(function* () {
    const userId = overrides.userId ?? defaultUserId;
    const bearer = overrides.bearer;
    const scopes = overrides.scopes ?? defaultAgentScopes;
    const tokenCreatedAt = overrides.tokenCreatedAt ?? (yield* DateTime.now);
    const idleExpiresAt =
      overrides.idleExpiresAt ?? (yield* renewAgentTokenIdleExpiry(tokenCreatedAt));
    const revokedAt = overrides.revokedAt ?? Option.none();
    const user = yield* makeColombianUser(userId, { createdAt: defaultCreatedAt });
    yield* upsertUser(userId, user);

    const tokenHash = yield* hashAgentBearer(bearer);
    yield* upsertAgentToken(userId, {
      id: overrides.tokenId ?? tokenIdFromHash(tokenHash),
      shortId: yield* getAgentTokenShortId(bearer),
      tokenHash,
      scopes,
      idleExpiresAt,
      revokedAt,
      createdAt: tokenCreatedAt,
    });

    return { user, tokenHash };
  });

/**
 * Seeds the complete local development identity and rotates its single
 * all-scopes AgentToken to the supplied one-time bearer.
 */
export const seedDevelopmentIdentity = (bearer: AgentBearerToken) =>
  Effect.gen(function* () {
    const seeded = yield* seedAgentIdentity({
      bearer,
      tokenId: defaultAgentTokenId,
    });

    yield* associateWhatsAppIdentity(defaultUserId, {
      phoneNumber: defaultWhatsAppPhone,
      verifiedAt: defaultCreatedAt,
    });

    return seeded;
  });

/** Local development seeding ordered after the real migration log. */
export const makeDevelopmentSeedLive = (bearer: AgentBearerToken) =>
  Layer.effectDiscard(seedDevelopmentIdentity(bearer)).pipe(
    Layer.provide(MigratorLive),
    Layer.provide(MigrationPgLive)
  );
