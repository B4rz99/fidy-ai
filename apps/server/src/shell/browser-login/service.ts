import { Crypto, DateTime, Effect, Encoding, Option, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  BrowserLoginPrivateVerifier,
  type StartedBrowserLoginPairing,
} from "~/core/browser-login/model";
import type { BrowserLoginPairingId } from "~/core/browser-login/reference";
import {
  type BrowserLoginPublicCode,
  BrowserLoginPublicCodeSymbols,
  browserLoginPairingExpiry,
  browserLoginPollingIntervalSeconds,
  formatPublicCode,
  selectPublicCodeSymbols,
} from "~/core/browser-login/rules";
import type { BrowserLoginCapacityExceeded, BrowserLoginStartRateLimited } from "./errors";
import {
  type StartPairingWrite,
  insertPendingBrowserLoginPairing,
  purgeExpiredAnonymousEvidence,
} from "./repo";

const verifierOctets = 32;
const publicCodeSymbols = 8;
const randomCodeBatchOctets = 16;

const sha256 = (bytes: Uint8Array): Effect.Effect<Uint8Array, never, Crypto.Crypto> =>
  Effect.flatMap(Crypto.Crypto, (crypto) => crypto.digest("SHA-256", bytes)).pipe(Effect.orDie);

/** Selects uniform alphabet indexes by rejection sampling rather than modulo bias. */
const generatePublicCodeSymbols = Effect.fn("BrowserLogin.generatePublicCodeSymbols")(
  function* (): Effect.fn.Return<string, never, Crypto.Crypto> {
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
  }
);

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
