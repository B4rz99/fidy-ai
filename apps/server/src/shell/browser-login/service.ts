import { timingSafeEqual } from "node:crypto";
import { Crypto, DateTime, Effect, Encoding, Option, Predicate, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { normalizeOpaqueProof32 } from "~/core/_shared/opaque-proof";
import {
  BrowserLoginPrivateVerifier,
  type StartedBrowserLoginPairing,
} from "~/core/browser-login/model";
import { BrowserLoginPairingId } from "~/core/browser-login/reference";
import type { UserId } from "~/core/identity/reference";
import {
  type BrowserLoginPublicCode,
  BrowserLoginPublicCodeSymbols,
  type BrowserLoginRedemptionDecision,
  browserLoginPairingExpiry,
  browserLoginPollingIntervalSeconds,
  decideBrowserLoginRedemption,
  decidePendingBrowserLoginProof,
  formatPublicCode,
  selectPublicCodeSymbols,
} from "~/core/browser-login/rules";
import { WebSessionBearer, WebSessionId } from "~/core/web-session/reference";
import { calculateWebSessionDeadlines } from "~/core/web-session/rules";
import { redeemPairingToWebSession } from "~/shell/web-auth/repo";
import {
  type BrowserLoginCapacityExceeded,
  BrowserLoginPairingInvalid,
  BrowserLoginPollingRateLimited,
  type BrowserLoginStartRateLimited,
} from "./errors";
import type { PendingBrowserLoginPairing, RedeemBrowserLoginPairingPayload } from "~/web-auth-api";
import {
  type LockedRedemptionCandidate,
  type StartPairingWrite,
  acceptBrowserLoginPoll,
  approveBrowserLoginPairingIdInScope,
  expireBrowserLoginPairing,
  findBrowserLoginApprovalCandidateInScope,
  insertPendingBrowserLoginPairing,
  lockBrowserLoginRedemptionCandidate,
  purgeExpiredAnonymousEvidence,
  rejectBrowserLoginVerifier,
  slowBrowserLoginPoll,
} from "./repo";

const verifierOctets = 32;
const publicCodeSymbols = 8;
const randomCodeBatchOctets = 16;

const sha256 = (bytes: Uint8Array): Effect.Effect<Uint8Array, never, Crypto.Crypto> =>
  Effect.flatMap(Crypto.Crypto, (crypto) => crypto.digest("SHA-256", bytes)).pipe(Effect.orDie);

/** Selects uniform alphabet indexes by rejection sampling rather than modulo bias. */
const generatePublicCodeSymbols = Effect.fn(function* (): Effect.fn.Return<
  string,
  never,
  Crypto.Crypto
> {
  const crypto = yield* Crypto.Crypto;
  let symbols = "";
  while (symbols.length < publicCodeSymbols) {
    const bytes = yield* crypto.randomBytes(randomCodeBatchOctets).pipe(Effect.orDie);
    symbols += selectPublicCodeSymbols({
      bytes: Array.from(bytes),
      maximum: publicCodeSymbols - symbols.length,
    });
  }
  return symbols;
});

type PairingWriteWithoutPublicCode = Omit<StartPairingWrite, "publicCode">;

type InsertedPairing = Readonly<{
  pairingId: BrowserLoginPairingId;
  publicCode: BrowserLoginPublicCode;
}>;

const insertWithUniquePublicCode = (
  input: PairingWriteWithoutPublicCode
): Effect.Effect<
  InsertedPairing,
  BrowserLoginStartRateLimited | BrowserLoginCapacityExceeded,
  Crypto.Crypto | SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const symbols = BrowserLoginPublicCodeSymbols.make(yield* generatePublicCodeSymbols());
    const publicCode = formatPublicCode(symbols);
    const pairingId = yield* insertPendingBrowserLoginPairing({ ...input, publicCode });
    return yield* Option.match(pairingId, {
      onNone: () => insertWithUniquePublicCode(input),
      onSome: (row) => Effect.succeed({ pairingId: row.id, publicCode }),
    });
  }).pipe(Effect.withSpan("BrowserLogin.insertWithUniquePublicCode"));

/** Purges anonymous source evidence independently of new pairing traffic. */
export const purgeBrowserLoginAnonymousEvidence = Effect.fn("BrowserLogin.purgeAnonymousEvidence")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* purgeExpiredAnonymousEvidence(sql, yield* DateTime.now);
  }
);

/**
 * Creates one browser-owned proof and persists only its digest and safe pairing metadata.
 * `sourceAddress` is transport-observed abuse evidence: it is digested before persistence and is
 * never identity or authorization authority. Callers handle rate-limit and live-capacity failures.
 * HTTP span telemetry already records latency and status; no custom values are emitted here so a
 * verifier or source address cannot enter logs or diagnostics.
 */
export const startBrowserLoginPairing = Effect.fn("BrowserLogin.startPairing")(function* (
  sourceAddress: string
) {
  const crypto = yield* Crypto.Crypto;
  const createdAt = yield* DateTime.now;
  const expiresAt = browserLoginPairingExpiry(createdAt);
  const verifierBytes = yield* crypto.randomBytes(verifierOctets).pipe(Effect.orDie);
  const privateVerifier = BrowserLoginPrivateVerifier.make(Encoding.encodeBase64Url(verifierBytes));
  const redactedVerifier = Redacted.make(privateVerifier);
  const verifierDigest = yield* sha256(new TextEncoder().encode(Redacted.value(redactedVerifier)));
  const sourceDigest = yield* sha256(new TextEncoder().encode(sourceAddress));
  const { pairingId, publicCode } = yield* insertWithUniquePublicCode({
    verifierDigest,
    sourceDigest,
    createdAt,
    expiresAt,
  });
  return {
    pairingId,
    privateVerifier: redactedVerifier,
    publicCode,
    expiresAt,
    pollingIntervalSeconds: browserLoginPollingIntervalSeconds,
  } satisfies StartedBrowserLoginPairing;
});

const dummyPairingId = BrowserLoginPairingId.make("00000000-0000-4000-8000-000000000000");
const stringOrEmpty = (input: unknown): string => (Predicate.isString(input) ? input : "");

/** Live pairing identity returned only after constant-time private-verifier validation. */
export type CheckedBrowserLoginPrivateVerifier = Readonly<{
  pairingId: BrowserLoginPairingId;
  expiresAt: DateTime.Utc;
}>;

const digestBrowserLoginVerifierInput = Effect.fn((input: unknown) =>
  sha256(new TextEncoder().encode(normalizeOpaqueProof32(stringOrEmpty(input))))
);

/**
 * Checks one private verifier while holding the target pairing row. It deliberately does not apply
 * poll cadence, but it shares BrowserLogin's expiry and five-wrong-verifier lifecycle.
 */
export const checkBrowserLoginPrivateVerifierInScope = Effect.fn(
  "BrowserLogin.checkPrivateVerifierInScope"
)(function* (
  input: Readonly<{ pairingId: unknown; privateVerifier: unknown; attemptedAt: DateTime.Utc }>
) {
  const parsedPairingId = Schema.decodeUnknownOption(BrowserLoginPairingId)(input.pairingId);
  const pairingId = Option.getOrElse(parsedPairingId, () => dummyPairingId);
  const attemptedDigest = yield* digestBrowserLoginVerifierInput(input.privateVerifier);
  const candidate = yield* lockBrowserLoginRedemptionCandidate(pairingId);
  const expectedDigest = Option.match(candidate, {
    onNone: () => new Uint8Array(verifierOctets),
    onSome: ({ verifierDigest }) => verifierDigest,
  });
  const verifierMatches = timingSafeEqual(attemptedDigest, expectedDigest);
  if (Option.isNone(parsedPairingId) || Option.isNone(candidate)) return Option.none();
  const pairing = candidate.value;
  const decision = decidePendingBrowserLoginProof({
    lifecycle: pairing.lifecycle,
    verifierMatches,
    wrongVerifierAttempts: pairing.wrongVerifierAttempts,
    expiresAt: pairing.expiresAt,
    attemptedAt: input.attemptedAt,
  });
  if (decision._tag === "Invalid") return Option.none();
  if (decision._tag === "Expired") {
    yield* expireBrowserLoginPairing(pairing.pairingId, input.attemptedAt);
    return Option.none();
  }
  if (decision._tag === "WrongVerifier") {
    yield* rejectBrowserLoginVerifier({
      pairingId: pairing.pairingId,
      wrongVerifierAttempts: decision.wrongVerifierAttempts,
      lifecycle: decision.lifecycle,
      rejectedAt: input.attemptedAt,
    });
    return Option.none();
  }
  return Option.some({ pairingId: pairing.pairingId, expiresAt: pairing.expiresAt });
});

/** Locks and rechecks a pairing after an earlier browser-proof check in an ordered approval scope. */
export const lockPendingBrowserLoginPairingInScope = Effect.fn(
  "BrowserLogin.lockPendingPairingInScope"
)(function* (pairingId: BrowserLoginPairingId, attemptedAt: DateTime.Utc) {
  const candidate = yield* lockBrowserLoginRedemptionCandidate(pairingId);
  if (Option.isNone(candidate)) return Option.none<CheckedBrowserLoginPrivateVerifier>();
  const pairing = candidate.value;
  if (pairing.lifecycle !== "pending_approval") return Option.none();
  if (DateTime.isGreaterThanOrEqualTo(attemptedAt, pairing.expiresAt)) {
    yield* expireBrowserLoginPairing(pairing.pairingId, attemptedAt);
    return Option.none();
  }
  return Option.some({ pairingId: pairing.pairingId, expiresAt: pairing.expiresAt });
});

/** Opens the short anonymous transaction used before any credential lookup or User lock. */
export const checkBrowserLoginPrivateVerifier = Effect.fn("BrowserLogin.checkPrivateVerifier")(
  function* (
    input: Readonly<{ pairingId: unknown; privateVerifier: unknown; attemptedAt: DateTime.Utc }>
  ) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql
      .withTransaction(checkBrowserLoginPrivateVerifierInScope(input))
      .pipe(Effect.catchTag("SqlError", Effect.die));
  }
);

/**
 * Observes whether an existing pairing can enter an ordered cross-owner approval transaction.
 * This intentionally retains no row lock; the owner transition rechecks after the coordinator's
 * own locks have been acquired.
 */
export const isBrowserLoginPairingApprovableInScope = Effect.fn(
  "BrowserLogin.isPairingApprovableInScope"
)(function* (pairingId: BrowserLoginPairingId, attemptedAt: DateTime.Utc) {
  const sql = yield* SqlClient.SqlClient;
  return Option.isSome(
    yield* findBrowserLoginApprovalCandidateInScope(sql, pairingId, attemptedAt)
  );
});

/**
 * Locks, rechecks, and binds one pairing to an existing User inside the caller's transaction.
 * BrowserLogin remains the sole owner; absence is claimant-neutral and success carries commit time.
 */
export const approveBrowserLoginPairingForExistingUserInScope = Effect.fn(
  "BrowserLogin.approvePairingForExistingUserInScope"
)(function* (input: {
  userId: UserId;
  pairingId: BrowserLoginPairingId;
  attemptedAt: DateTime.Utc;
}) {
  return yield* approveBrowserLoginPairingIdInScope(input).pipe(
    Effect.catchTag("BrowserLoginPairingApprovalRejected", () =>
      Effect.succeed(Option.none<DateTime.Utc>())
    )
  );
});

/** Rechecks browser proof and lets BrowserLogin alone bind the supplied existing User. */
export const approveBrowserLoginPairingWithPrivateVerifierInScope = Effect.fn(
  "BrowserLogin.approveWithPrivateVerifierInScope"
)(function* (
  input: Readonly<{
    pairingId: unknown;
    privateVerifier: unknown;
    userId: UserId;
    attemptedAt: DateTime.Utc;
  }>
) {
  const checked = yield* checkBrowserLoginPrivateVerifierInScope(input);
  if (Option.isNone(checked)) return false;
  return Option.isSome(
    yield* approveBrowserLoginPairingIdInScope({
      userId: input.userId,
      pairingId: checked.value.pairingId,
      attemptedAt: input.attemptedAt,
    })
  );
});

export type RedeemedBrowserLoginPairing =
  | PendingBrowserLoginPairing
  | Readonly<{
      status: "authenticated";
      sessionBearer: Redacted.Redacted<WebSessionBearer>;
    }>;

type RedemptionTransactionOutcome =
  | Readonly<{ _tag: "Invalid" }>
  | Readonly<{ _tag: "RateLimited"; retryAfterSeconds: number }>
  | Readonly<{ _tag: "Redeemed"; value: RedeemedBrowserLoginPairing }>;

const changedRateLimitOutcome = (
  changed: boolean,
  retryAfterSeconds: number
): RedemptionTransactionOutcome =>
  changed ? { _tag: "RateLimited", retryAfterSeconds } : { _tag: "Invalid" };

const changedRedemptionOutcome = (
  changed: boolean,
  value: RedeemedBrowserLoginPairing
): RedemptionTransactionOutcome => (changed ? { _tag: "Redeemed", value } : { _tag: "Invalid" });

const applyRedemptionDecision = Effect.fn("BrowserLogin.applyRedemptionDecision")(function* (
  candidate: LockedRedemptionCandidate,
  decision: BrowserLoginRedemptionDecision,
  attemptedAt: DateTime.Utc
): Effect.fn.Return<RedemptionTransactionOutcome, never, Crypto.Crypto | SqlClient.SqlClient> {
  switch (decision._tag) {
    case "Invalid":
      return { _tag: "Invalid" };
    case "Expired":
      yield* expireBrowserLoginPairing(candidate.pairingId, attemptedAt);
      return { _tag: "Invalid" };
    case "WrongVerifier":
      yield* rejectBrowserLoginVerifier({
        pairingId: candidate.pairingId,
        wrongVerifierAttempts: decision.wrongVerifierAttempts,
        lifecycle: decision.lifecycle,
        rejectedAt: attemptedAt,
      });
      return { _tag: "Invalid" };
    case "SlowDown": {
      const changed = yield* slowBrowserLoginPoll(
        candidate.pairingId,
        decision.minimumPollIntervalSeconds
      );
      return changedRateLimitOutcome(changed, decision.retryAfterSeconds);
    }
    case "Pending": {
      const changed = yield* acceptBrowserLoginPoll(candidate.pairingId, decision.acceptedAt);
      return changedRedemptionOutcome(changed, {
        status: "pending_approval",
        expiresAt: candidate.expiresAt,
        pollingIntervalSeconds: decision.minimumPollIntervalSeconds,
      });
    }
    case "Consume": {
      if (Option.isNone(candidate.userId)) return { _tag: "Invalid" };
      const crypto = yield* Crypto.Crypto;
      const sessionId = WebSessionId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
      const bearerBytes = yield* crypto.randomBytes(verifierOctets).pipe(Effect.orDie);
      const sessionBearer = WebSessionBearer.make(Encoding.encodeBase64Url(bearerBytes));
      const bearerDigest = yield* sha256(new TextEncoder().encode(sessionBearer));
      const redeemed = yield* redeemPairingToWebSession({
        pairingId: candidate.pairingId,
        sessionId,
        bearerDigest,
        pairedAt: attemptedAt,
        ...calculateWebSessionDeadlines(attemptedAt),
      });
      return changedRedemptionOutcome(redeemed, {
        status: "authenticated",
        sessionBearer: Redacted.make(sessionBearer),
      });
    }
  }
});

const redeemLockedCandidate = Effect.fn("BrowserLogin.redeemLockedCandidate")(function* (input: {
  pairingId: BrowserLoginPairingId;
  parsedPairingId: Option.Option<BrowserLoginPairingId>;
  attemptedDigest: Uint8Array;
  attemptedAt: DateTime.Utc;
}): Effect.fn.Return<RedemptionTransactionOutcome, never, Crypto.Crypto | SqlClient.SqlClient> {
  const candidate = yield* lockBrowserLoginRedemptionCandidate(input.pairingId);
  const expectedDigest = Option.match(candidate, {
    onNone: () => new Uint8Array(verifierOctets),
    onSome: ({ verifierDigest }) => verifierDigest,
  });
  const verifierMatches = timingSafeEqual(input.attemptedDigest, expectedDigest);
  if (Option.isNone(candidate) || Option.isNone(input.parsedPairingId)) return { _tag: "Invalid" };
  const decision = decideBrowserLoginRedemption({
    lifecycle: candidate.value.lifecycle,
    verifierMatches,
    wrongVerifierAttempts: candidate.value.wrongVerifierAttempts,
    minimumPollIntervalSeconds: candidate.value.minimumPollIntervalSeconds,
    lastAcceptedPollAt: candidate.value.lastAcceptedPollAt,
    expiresAt: candidate.value.expiresAt,
    attemptedAt: input.attemptedAt,
  });
  return yield* applyRedemptionDecision(candidate.value, decision, input.attemptedAt);
});

/**
 * Polls or redeems one pairing inside a row-locking transaction. Every input hashes one bounded
 * verifier and performs one constant-time digest comparison before a public decision is made.
 * HTTP span telemetry records latency and the bounded response status; custom values are omitted
 * so pairing ids, verifier material, and lifecycle details cannot enter diagnostics.
 */
export const redeemBrowserLoginPairing = Effect.fn("BrowserLogin.redeemPairing")(function* (
  input: RedeemBrowserLoginPairingPayload
) {
  const sql = yield* SqlClient.SqlClient;
  const attemptedAt = yield* DateTime.now;
  const parsedPairingId = Schema.decodeUnknownOption(BrowserLoginPairingId)(input.pairingId);
  const pairingId = Option.getOrElse(parsedPairingId, () => dummyPairingId);
  const attemptedDigest = yield* sha256(
    new TextEncoder().encode(normalizeOpaqueProof32(stringOrEmpty(input.privateVerifier)))
  );

  const outcome = yield* sql
    .withTransaction(
      redeemLockedCandidate({ pairingId, parsedPairingId, attemptedDigest, attemptedAt })
    )
    .pipe(Effect.catchTag("SqlError", Effect.die));

  switch (outcome._tag) {
    case "Invalid":
      return yield* new BrowserLoginPairingInvalid();
    case "RateLimited":
      return yield* new BrowserLoginPollingRateLimited({
        retryAfterSeconds: outcome.retryAfterSeconds,
      });
    case "Redeemed":
      return outcome.value;
  }
});
