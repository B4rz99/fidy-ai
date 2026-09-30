import { BrowserLoginPairingId } from "../../src/core/browser-login/contract";
import {
  BrowserLoginPrivateVerifier,
  BrowserLoginPublicCodeSymbols,
} from "../../src/core/browser-login/contract";
import {
  decideBrowserLoginRedemption,
  decidePendingBrowserLoginProof,
  formatPublicCode,
  maximumWrongVerifierAttempts,
  selectPublicCodeSymbols,
} from "../../src/core/browser-login/operations";
import { prepareWebSessionIssuance } from "@fidy/server/web-session-runtime";
import { sessionPairingRetention } from "@fidy/server/web-session";
import { UserId } from "../../src/core/identity/contract";
import { Clock, DateTime, Effect, Encoding, Option, Schema } from "effect";
import { pairingId as newPairingId } from "./internal/worker-crypto";
import { RequestBodyPolicy, readBoundedRequestBody } from "../http/request-body";
import type { PairingEmailOwnership } from "../email-authentication/contract";

const Proof = Schema.Struct({
  pairingId: BrowserLoginPairingId,
  privateVerifier: BrowserLoginPrivateVerifier,
});
const Pairing = Schema.Struct({
  user_id: Schema.NullOr(UserId),
  verifier_digest: Schema.Array(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))
  ).check(Schema.isLengthBetween(32, 32)),
  expires_at_ms: Schema.Finite,
  wrong_attempts: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
  last_poll_at_ms: Schema.NullOr(Schema.Finite),
  minimum_poll_interval_seconds: Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 60 })),
  state: Schema.Literals(["pending_approval", "ready", "consumed", "invalidated"]),
});
const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 512,
  deadlineMilliseconds: 2_000,
});
const digestBytes = 32;
const pairingMs = 600_000;
const maximumPollSeconds = 60;
const publicSymbols = 8;
const randomSampleBytes = 16;
const httpPending = 202;
const httpLimited = 429;
const invalid = (): Response =>
  Response.json(
    {
      error: {
        code: "pairing_invalid",
        message: "Esta vinculación ya no es válida. Inicia de nuevo.",
      },
    },
    { status: 400, headers: { "cache-control": "no-store" } }
  );
const unavailable = (): Response =>
  Response.json(
    { status: "unavailable" },
    { status: 503, headers: { "cache-control": "no-store" } }
  );
const json = (body: object, status = 200, headers?: HeadersInit): Response => {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "no-store");
  return Response.json(body, { status, headers: responseHeaders });
};
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, void> =>
  Effect.tryPromise({ try: run, catch: () => undefined });
const digest = (value: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((bytes) => new Uint8Array(bytes));
const instant = (epochMs: number): string => DateTime.formatIso(DateTime.makeUnsafe(epochMs));
const sameDigest = (expected: ReadonlyArray<number>, received: Uint8Array): boolean => {
  if (expected.length !== digestBytes || received.length !== digestBytes) return false;
  let difference = 0;
  for (let index = 0; index < digestBytes; index++)
    difference |= (expected[index] ?? 0) ^ (received[index] ?? 0);
  return difference === 0;
};
const samplePublicCode = (): string => {
  let symbols = "";
  while (symbols.length < publicSymbols) {
    symbols += selectPublicCodeSymbols({
      bytes: Array.from(crypto.getRandomValues(new Uint8Array(randomSampleBytes))),
      maximum: publicSymbols - symbols.length,
    });
  }
  return formatPublicCode(Schema.decodeSync(BrowserLoginPublicCodeSymbols)(symbols));
};

/** Start an unbound ten-minute pairing. Only this direct HTTPS response discloses the browser's verifier. */
export const startBrowserPairing = (db: D1Database): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      yield* attempt(() =>
        db
          .prepare(`DELETE FROM browser_login_pairings WHERE id IN (
    SELECT id FROM browser_login_pairings WHERE expires_at_ms <= ? AND NOT (${sessionPairingRetention})
    ORDER BY expires_at_ms LIMIT 32)`)
          .bind(started)
          .run()
      );
      const publicCode = samplePublicCode();
      const privateVerifier = Encoding.encodeBase64Url(
        crypto.getRandomValues(new Uint8Array(digestBytes))
      );
      const pairingId = newPairingId();
      const proofDigest = yield* attempt(() => digest(privateVerifier));
      const result = yield* attempt(() =>
        db
          .prepare(`INSERT INTO browser_login_pairings
    (id, public_code, verifier_digest, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?)`)
          .bind(pairingId, publicCode, proofDigest, started, started + pairingMs)
          .run()
      );
      if (result.meta.changes !== 1) return unavailable();
      return json({
        pairingId,
        privateVerifier,
        publicCode,
        expiresAt: instant(started + pairingMs),
        pollingIntervalSeconds: 5,
      });
    })
  );

/** Signed WhatsApp evidence resolves its established stable User; no public locator is authority. */
export const approveBrowserPairing = ({
  db,
  input,
}: {
  db: D1Database;
  input: Readonly<{
    portfolioId: string;
    bsuid: string;
    messageId: string;
    publicCode: string;
    occurredAtMs: number;
    receivedAtMs: number;
  }>;
}): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* attempt(() =>
        db
          .prepare(`INSERT INTO browser_login_approvals (portfolio_id, message_id, pairing_id, user_id)
    SELECT ?, ?, p.id, w.user_id FROM browser_login_pairings AS p
    JOIN whatsapp_identities AS w ON w.portfolio_id = ? AND w.bsuid = ?
    JOIN onboarding_consent_records AS c ON c.user_id = w.user_id
    WHERE p.public_code = ? AND p.state = 'pending_approval'
      AND p.expires_at_ms > ? AND p.expires_at_ms > ? AND ? >= (p.created_at_ms / 1000) * 1000`)
          .bind(
            input.portfolioId,
            input.messageId,
            input.portfolioId,
            input.bsuid,
            input.publicCode,
            input.receivedAtMs,
            input.occurredAtMs,
            input.occurredAtMs
          )
          .run()
      );
      return result.meta.changes > 0 ? new Response(null, { status: 200 }) : invalid();
    }).pipe(Effect.catchCause(() => Effect.succeed(invalid())))
  );

const recordWrongVerifier = (db: D1Database, pairingId: string): Promise<D1Result> =>
  db
    .prepare(`UPDATE browser_login_pairings
  SET wrong_attempts = wrong_attempts + 1,
    state = CASE WHEN wrong_attempts + 1 >= ? THEN 'invalidated' ELSE state END,
    user_id = CASE WHEN wrong_attempts + 1 >= ? THEN NULL ELSE user_id END
  WHERE id = ? AND state IN ('pending_approval', 'ready') AND wrong_attempts < ?`)
    .bind(
      maximumWrongVerifierAttempts,
      maximumWrongVerifierAttempts,
      pairingId,
      maximumWrongVerifierAttempts
    )
    .run();

/** Validate an independent browser proof without polling or granting authority. Email may proceed only on Some(expiry). */
export const verifyPendingBrowserPairing = ({
  db,
  pairingId,
  privateVerifier,
}: {
  db: D1Database;
  pairingId: string;
  privateVerifier: string;
}): Promise<Option.Option<number>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const proof = Schema.decodeOption(Proof)({ pairingId, privateVerifier });
      if (Option.isNone(proof)) return Option.none();
      const raw = yield* attempt(() =>
        db
          .prepare(`SELECT user_id, verifier_digest, expires_at_ms, wrong_attempts,
    last_poll_at_ms, minimum_poll_interval_seconds, state FROM browser_login_pairings WHERE id = ?`)
          .bind(pairingId)
          .first()
      );
      const pairing = Schema.decodeUnknownOption(Pairing)(raw);
      if (Option.isNone(pairing)) return Option.none();
      const current = yield* Clock.currentTimeMillis;
      const decision = decidePendingBrowserLoginProof({
        lifecycle: pairing.value.state,
        verifierMatches: sameDigest(
          pairing.value.verifier_digest,
          yield* attempt(() => digest(privateVerifier))
        ),
        wrongVerifierAttempts: pairing.value.wrong_attempts,
        expiresAt: DateTime.makeUnsafe(pairing.value.expires_at_ms),
        attemptedAt: DateTime.makeUnsafe(current),
      });
      if (decision._tag === "WrongVerifier")
        yield* attempt(() => recordWrongVerifier(db, pairingId));
      return decision._tag === "Accept" ? Option.some(pairing.value.expires_at_ms) : Option.none();
    })
  );

/** Redeem an approved pairing once, with its browser-held verifier. Proof consumption and WebSession issuance commit together. */
export const redeemBrowserPairing = ({
  request,
  db,
}: {
  request: Request;
  db: D1Database;
}): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
        return invalid();
      const bytes = yield* readBoundedRequestBody(request, policy);
      const text = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: () => undefined,
      });
      const proof = Schema.decodeOption(Schema.fromJsonString(Proof))(text);
      if (Option.isNone(proof)) return invalid();
      const raw = yield* attempt(() =>
        db
          .prepare(`SELECT user_id, verifier_digest, expires_at_ms, wrong_attempts, state,
    last_poll_at_ms, minimum_poll_interval_seconds FROM browser_login_pairings WHERE id = ?`)
          .bind(proof.value.pairingId)
          .first()
      );
      if (raw === null) return invalid();
      const pairing = Schema.decodeUnknownOption(Pairing)(raw);
      if (Option.isNone(pairing)) return unavailable();
      const current = yield* Clock.currentTimeMillis;
      const decision = decideBrowserLoginRedemption({
        lifecycle: pairing.value.state,
        verifierMatches: sameDigest(
          pairing.value.verifier_digest,
          yield* attempt(() => digest(proof.value.privateVerifier))
        ),
        wrongVerifierAttempts: pairing.value.wrong_attempts,
        minimumPollIntervalSeconds: pairing.value.minimum_poll_interval_seconds,
        lastAcceptedPollAt: Option.map(
          Option.fromNullishOr(pairing.value.last_poll_at_ms),
          DateTime.makeUnsafe
        ),
        expiresAt: DateTime.makeUnsafe(pairing.value.expires_at_ms),
        attemptedAt: DateTime.makeUnsafe(current),
      });
      if (decision._tag === "WrongVerifier") {
        yield* attempt(() => recordWrongVerifier(db, proof.value.pairingId));
        return invalid();
      }
      if (decision._tag === "SlowDown") {
        yield* attempt(() =>
          db
            .prepare(
              `UPDATE browser_login_pairings SET minimum_poll_interval_seconds = ? WHERE id = ? AND state = ?`
            )
            .bind(
              Math.min(decision.minimumPollIntervalSeconds, maximumPollSeconds),
              proof.value.pairingId,
              pairing.value.state
            )
            .run()
        );
        return json(
          { error: { code: "rate_limited", retryAfterSeconds: decision.retryAfterSeconds } },
          httpLimited,
          { "retry-after": String(decision.retryAfterSeconds) }
        );
      }
      if (decision._tag === "Pending") {
        const accepted = yield* attempt(() =>
          db
            .prepare(`UPDATE browser_login_pairings SET last_poll_at_ms = ?
      WHERE id = ? AND state = 'pending_approval' AND last_poll_at_ms IS ? AND expires_at_ms > ?`)
            .bind(current, proof.value.pairingId, pairing.value.last_poll_at_ms, current)
            .run()
        );
        return accepted.meta.changes !== 1
          ? invalid()
          : json(
              {
                status: "pending_approval",
                expiresAt: instant(pairing.value.expires_at_ms),
                pollingIntervalSeconds: decision.minimumPollIntervalSeconds,
              },
              httpPending
            );
      }
      if (decision._tag !== "Consume") return invalid();
      if (pairing.value.user_id === null) return invalid();
      const issuance = yield* prepareWebSessionIssuance({
        db,
        pairingId: proof.value.pairingId,
        userId: pairing.value.user_id,
        current,
      });
      const committed = yield* attempt(() =>
        db.batch([
          db
            .prepare(
              `UPDATE browser_login_pairings SET state = 'consumed' WHERE id = ? AND state = 'ready' AND expires_at_ms > ? AND wrong_attempts < ?`
            )
            .bind(proof.value.pairingId, current, maximumWrongVerifierAttempts),
          issuance.statement,
        ])
      );
      const issued = committed[1];
      return issued === undefined ? invalid() : issuance.complete(issued);
    }).pipe(Effect.catchCause(() => Effect.succeed(invalid())))
  );

/** Recheck one known pending pairing inside a proof/outbox commit. This guard grants no User authority;
 * the caller must independently prove the browser verifier before preparing work. */
export const pendingPairingAuthority = ({
  pairingId,
  current,
}: {
  pairingId: BrowserLoginPairingId;
  current: number;
}): Readonly<{
  predicate: string;
  bindings: readonly [BrowserLoginPairingId, number, number];
}> => ({
  predicate: `EXISTS (SELECT 1 FROM browser_login_pairings WHERE id = ? AND state = 'pending_approval' AND expires_at_ms > ? AND wrong_attempts < ?)`,
  bindings: [pairingId, current, maximumWrongVerifierAttempts],
});

/** Compose immediately after Email Authentication consumes the matching current User-owned proof.
 * The caller must include its rollback fence after this statement: a lost pending/expiry race must
 * roll back proof consumption. This approval never issues a WebSession or changes User identity. */
export const prepareEmailPairingApproval = ({
  db,
  userId,
  pairingId,
  atMs,
}: {
  db: D1Database;
  userId: UserId;
  pairingId: BrowserLoginPairingId;
  atMs: number;
}): D1PreparedStatement =>
  db
    .prepare(`UPDATE browser_login_pairings SET state = 'ready', user_id = ?
  WHERE id = ? AND state = 'pending_approval' AND expires_at_ms > ? AND wrong_attempts < ? AND changes() = 1`)
    .bind(userId, pairingId, atMs, maximumWrongVerifierAttempts);

const RecoveryPairing = Schema.Struct({ id: BrowserLoginPairingId, expiresAtMs: Schema.Finite });
/** A Recovery-proven User may select only a pending, unexpired pairing without conflicting email ownership. */
export const findRecoveryPairing = ({
  db,
  userId,
  publicCode,
  atMs,
}: {
  db: D1Database;
  userId: UserId;
  publicCode: string;
  atMs: number;
}): Promise<Option.Option<typeof RecoveryPairing.Type>> =>
  db
    .prepare(`SELECT p.id, p.expires_at_ms AS expiresAtMs FROM browser_login_pairings AS p
  WHERE p.public_code = ? AND p.state = 'pending_approval' AND p.expires_at_ms > ?
    AND (p.user_id IS NULL OR p.user_id = ?)`)
    .bind(publicCode, atMs, userId)
    .first()
    .then(Schema.decodeUnknownOption(RecoveryPairing));

/** Compose in Recovery's credential-consumption batch, immediately after its successful consumption statement.
 * The changes() guard prevents approval without consumption; recheck ownership/expiry at commit, and require a
 * subsequent case/evidence statement that aborts the batch if this transition changes no row. Never grants a session. */
export const prepareRecoveryPairingApproval = ({
  db,
  userId,
  pairingId,
  atMs,
  emailOwnership,
}: {
  db: D1Database;
  userId: UserId;
  pairingId: BrowserLoginPairingId;
  atMs: number;
  emailOwnership: PairingEmailOwnership;
}): D1PreparedStatement =>
  db
    .prepare(`UPDATE browser_login_pairings SET state = 'ready', user_id = ?
  WHERE id = ? AND state = 'pending_approval' AND expires_at_ms > ? AND changes() = 1
    AND (${emailOwnership.predicate})`)
    .bind(userId, pairingId, atMs, ...emailOwnership.bindings);
