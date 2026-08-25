import {
  Config,
  Crypto,
  DateTime,
  Effect,
  Encoding,
  type FileSystem,
  Layer,
  Option,
  type Path,
} from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { Migrator, SqlClient, SqlError } from "effect/unstable/sql";
import { ConsentRecord, ConsentRecordId } from "~/core/consent/model";
import { EmailAddress } from "~/core/email-authentication/model";
import {
  E164PhoneNumber,
  UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "~/core/identity/reference";
import { PATId } from "~/core/tokens/reference";
import type { User } from "~/core/identity/model";
import { makeColombianUser } from "~/core/identity/rules";
import {
  type PATLifetimeDays,
  PATRecipientLabel,
  PATScopes,
  type TokenBearer,
  TokenSecret,
  TokenShortId,
  bearerSecretBytes,
  defaultPATLifetimeDays,
  getTokenShortId,
  makeTokenBearer,
} from "~/core/tokens/model";
import { computePATExpiration } from "~/core/tokens/rules";
import { hashTokenBearer } from "~/shell/_shared/token-digest";
import { currentDisclosure } from "~/shell/consent/current-disclosure";
import { appendConsentRecord, hasCurrentOnboardingConsent } from "~/shell/consent/repo";
import { associateWhatsAppIdentity, upsertDevelopmentUser } from "~/shell/identity/repo";
import { installVerifiedEmailCredentialInScope } from "~/shell/email-authentication/repo";
import { upsertDevelopmentBackupRecoveryCredentialInScope } from "~/shell/recovery/repo";
import { type TokenHash, upsertPAT } from "~/shell/tokens/repo";
import { withUserTransaction } from "./user-transaction";
import { MigrationPgLive, MigratorLive } from "./client";

/** The stable User used by the local development seed and API-seam tests. */
export const defaultUserId = UserId.make("f1d1a000-0000-4000-8000-000000000001");

/** The normalized WhatsApp identity associated with the development User. */
export const defaultWhatsAppPhone = E164PhoneNumber.make("+573001234567");

const defaultCreatedAt = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
/** Stable PAT id behind the local development and API-seam bearer. */
export const defaultPATId = PATId.make("f1d1a000-0000-4000-8000-000000000002");
const defaultPATScopes = PATScopes.make(["read", "write", "dashboard"]);

/**
 * Generates the one-time development bearer from platform cryptographic bytes.
 * The caller must disclose it only through the local seed command; this function
 * neither persists nor logs the bearer.
 */
export const generateDevelopmentPatBearer = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const shortId = Encoding.encodeHex(yield* crypto.randomBytes(4));
  const secret = Encoding.encodeHex(yield* crypto.randomBytes(bearerSecretBytes));

  return yield* makeTokenBearer({
    shortId: TokenShortId.make(shortId),
    secret: TokenSecret.make(secret),
  });
});

const uuidTimeLowEnd = 8;
const uuidTimeMidEnd = 12;
const uuidTimeHighEnd = 16;
const uuidClockSequenceEnd = 20;
const uuidNodeEnd = 32;
const uuidTimeHighStart = uuidTimeMidEnd + 1;
const uuidClockSequenceStart = uuidTimeHighEnd + 1;

/** Seeds one current onboarding grant so a fixture User can admit a Hosted Agent Session. */
export const seedOnboardingConsent = (
  userId: UserId
): Effect.Effect<void, Config.ConfigError, Crypto.Crypto | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const disclosure = yield* currentDisclosure;
    const recordId = ConsentRecordId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
    const seedMessageId = `development-seed:${recordId}`;
    yield* appendConsentRecord(
      ConsentRecord.make({
        id: recordId,
        subjectUserId: userId,
        event: { _tag: "Granted", grant: { _tag: "Onboarding" } },
        disclosure,
        occurredAt: defaultCreatedAt,
        evidence: {
          _tag: "ProviderQualifiedMessages",
          disclosureMessage: {
            channel: "development",
            provider: "development-seed",
            providerMessageId: `${seedMessageId}:disclosure`,
          },
          decisionMessage: {
            channel: "development",
            provider: "development-seed",
            providerMessageId: `${seedMessageId}:acceptance`,
          },
        },
      })
    );
  });

const tokenIdFromHash = (tokenHash: TokenHash): PATId =>
  PATId.make(
    `${tokenHash.slice(0, uuidTimeLowEnd)}-${tokenHash.slice(uuidTimeLowEnd, uuidTimeMidEnd)}-4${tokenHash.slice(uuidTimeHighStart, uuidTimeHighEnd)}-8${tokenHash.slice(uuidClockSequenceStart, uuidClockSequenceEnd)}-${tokenHash.slice(uuidClockSequenceEnd, uuidNodeEnd)}`
  );

type SeededPatIdentity = Readonly<{
  userId: UserId;
  tokenId: PATId;
  scopes: PATScopes;
  tokenCreatedAt: DateTime.Utc;
  lifetimeDays: PATLifetimeDays;
  expiresAt: DateTime.Utc;
  revokedAt: Option.Option<DateTime.Utc>;
}>;

type SeededPatIdentityOverrides = Readonly<{ bearer: TokenBearer }> & Partial<SeededPatIdentity>;

const resolveSeededPATLifetime = Effect.fn("resolveSeededPATLifetime")(function* (
  overrides: SeededPatIdentityOverrides,
  createdAt: DateTime.Utc
) {
  const lifetimeDays = overrides.lifetimeDays ?? defaultPATLifetimeDays;
  const expiresAt =
    overrides.expiresAt ?? (yield* computePATExpiration({ createdAt, lifetimeDays }));
  return { expiresAt, lifetimeDays };
});

const installDevelopmentIdentityState = Effect.fn("installDevelopmentIdentityState")(function* (
  userId: UserId
) {
  const isDefaultUser = userId === defaultUserId;
  yield* associateWhatsAppIdentity(userId, {
    businessPortfolioId: WhatsAppBusinessPortfolioId.make(
      isDefaultUser ? "portfolio-test" : "fidy-development"
    ),
    businessScopedUserId: WhatsAppBusinessScopedUserId.make(
      isDefaultUser ? "CO.573001234567" : `CO.${userId.replaceAll("-", "")}`
    ),
    parentBusinessScopedUserId: Option.none(),
    username: Option.none(),
    phoneNumber: isDefaultUser ? Option.some(defaultWhatsAppPhone) : Option.none(),
    verifiedAt: defaultCreatedAt,
  });
  const crypto = yield* Crypto.Crypto;
  const recoveryDigest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(`development-recovery:${userId}`))
    .pipe(Effect.orDie);
  yield* installVerifiedEmailCredentialInScope({
    userId,
    email: EmailAddress.make(`seed-${userId}@fidyapp.com`),
    verifiedAt: defaultCreatedAt,
  });
  yield* upsertDevelopmentBackupRecoveryCredentialInScope({
    userId,
    codeDigest: recoveryDigest,
    createdAt: defaultCreatedAt,
  });
});

/**
 * Seeds one stable User, current onboarding ConsentRecord, and hashed PAT bearer
 * through slice-owned persistence operations. When consent is absent, it adds
 * synthesized disclosure and decision evidence suitable only for development
 * and tests. The full bearer and secret never enter persistence; only its digest
 * and safe naming id cross that boundary.
 */
export const seedConsentedPatIdentity = (
  overrides: SeededPatIdentityOverrides
): Effect.Effect<
  { user: User; tokenHash: TokenHash },
  Config.ConfigError,
  Crypto.Crypto | SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const userId = overrides.userId ?? defaultUserId;
    return yield* withUserTransaction(
      userId,
      Effect.gen(function* () {
        const bearer = overrides.bearer;
        const scopes = overrides.scopes ?? defaultPATScopes;
        const tokenCreatedAt = overrides.tokenCreatedAt ?? (yield* DateTime.now);
        const { expiresAt, lifetimeDays } = yield* resolveSeededPATLifetime(
          overrides,
          tokenCreatedAt
        );
        const revokedAt = overrides.revokedAt ?? Option.none();
        const user = yield* makeColombianUser(userId, {
          createdAt: defaultCreatedAt,
          paidTier: "pro",
        });
        yield* upsertDevelopmentUser(userId, user);
        if (!(yield* hasCurrentOnboardingConsent(userId))) yield* seedOnboardingConsent(userId);
        yield* installDevelopmentIdentityState(userId);

        const tokenHash = yield* hashTokenBearer(bearer);
        yield* upsertPAT(userId, {
          id: overrides.tokenId ?? tokenIdFromHash(tokenHash),
          shortId: yield* getTokenShortId(bearer),
          recipientLabel: PATRecipientLabel.make("Development PAT"),
          tokenHash,
          scopes,
          lifetimeDays,
          expiresAt,
          revokedAt,
          createdAt: tokenCreatedAt,
        });
        return { user, tokenHash };
      })
    );
  });

/**
 * Seeds the complete local development identity and rotates its single all-scope PAT bearer to
 * the supplied one-time bearer. The WhatsApp association uses the required
 * `WHATSAPP_BUSINESS_PORTFOLIO_ID`; missing or invalid configuration fails the seed.
 */
export const seedDevelopmentIdentity = (
  bearer: TokenBearer
): Effect.Effect<
  { user: User; tokenHash: TokenHash },
  Config.ConfigError,
  Crypto.Crypto | SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const seeded = yield* seedConsentedPatIdentity({
      bearer,
      tokenId: defaultPATId,
    });
    const businessPortfolioId = yield* Config.schema(
      WhatsAppBusinessPortfolioId,
      "WHATSAPP_BUSINESS_PORTFOLIO_ID"
    );

    yield* associateWhatsAppIdentity(defaultUserId, {
      businessPortfolioId,
      businessScopedUserId: WhatsAppBusinessScopedUserId.make("CO.573001234567"),
      parentBusinessScopedUserId: Option.none(),
      username: Option.none(),
      phoneNumber: Option.some(defaultWhatsAppPhone),
      verifiedAt: defaultCreatedAt,
    });

    return seeded;
  });

/** Local development seeding ordered after the real migration log. */
export const makeDevelopmentSeedLive = (
  bearer: TokenBearer
): Layer.Layer<
  never,
  Config.ConfigError | Migrator.MigrationError | SqlError.SqlError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> =>
  Layer.effectDiscard(seedDevelopmentIdentity(bearer)).pipe(
    Layer.provide(MigratorLive),
    Layer.provide(MigrationPgLive)
  );
