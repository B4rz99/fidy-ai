import {
  BrowserLoginPairingId,
  BrowserLoginPublicCodeSymbols,
  browserLoginPollingIntervalSeconds,
} from "../../src/core/browser-login/contract";
import {
  decidePendingBrowserLoginProof,
  formatPublicCode,
  maximumWrongVerifierAttempts,
  selectPublicCodeSymbols,
} from "../../src/core/browser-login/operations";
import { sessionPairingRetention } from "@fidy/server/web-session";
import type { UserId } from "../../src/core/identity/contract";
import { Clock, DateTime, Effect, Encoding, Option, Schema } from "effect";
import { pairingId as newPairingId } from "./internal/worker-crypto";
import {
  Pairing,
  Proof,
  digest,
  digestBytes,
  recordWrongVerifier,
  sameDigest,
} from "./internal/pairing-proof";
import { redeemKnownProof } from "./internal/redemption";
import { RequestBodyPolicy, readBoundedRequestBody } from "../http/request-body";
import type { PairingEmailOwnership } from "../email-authentication/contract";

const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 512,
  deadlineMilliseconds: 2_000,
});
const pairingMs = 600_000;
const publicSymbols = 8;
const randomSampleBytes = 16;
const httpOk = 200;
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
const json = (body: object): Response =>
  Response.json(body, { headers: { "cache-control": "no-store" } });
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, void> =>
  Effect.tryPromise({ try: run, catch: () => undefined });
const instant = (epochMs: number): string => DateTime.formatIso(DateTime.makeUnsafe(epochMs));
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
    SELECT id FROM browser_login_pairings WHERE expires_at_ms <= ? AND NOT (${sessionPairingRetention}) ORDER BY expires_at_ms LIMIT 32)`)
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
        pollingIntervalSeconds: browserLoginPollingIntervalSeconds,
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
      return result.meta.changes > 0 ? new Response(null, { status: httpOk }) : invalid();
    }).pipe(Effect.catchCause(() => Effect.succeed(invalid())))
  );

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
      if (decision._tag === "WrongVerifier") {
        yield* attempt(() => recordWrongVerifier(db, pairingId));
      }
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
      if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
        return invalid();
      }
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
      return Option.isNone(pairing)
        ? unavailable()
        : yield* redeemKnownProof(db, proof.value, pairing.value);
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

/** Filter Email Authentication's bounded due-work scan before its ORDER/LIMIT. The caller's owned
 * proof relation must use alias e with pairing_id; no caller-selected SQL expression is accepted. */
export const pendingEmailPairingAuthority = ({
  current,
}: {
  current: number;
}): Readonly<{
  predicate: string;
  bindings: readonly [number, number];
}> => ({
  predicate: `EXISTS (SELECT 1 FROM browser_login_pairings AS p WHERE p.id = e.pairing_id AND p.state = 'pending_approval' AND p.expires_at_ms > ? AND p.wrong_attempts < ?)`,
  bindings: [current, maximumWrongVerifierAttempts],
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
/** Resolve one unexpired pending locator for a Recovery-proven User. The caller must additionally
 * reject conflicting Email Authentication ownership before consuming a recovery credential. */
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
  WHERE p.public_code = ? AND p.state = 'pending_approval' AND p.expires_at_ms > ? AND (p.user_id IS NULL OR p.user_id = ?)`)
    .bind(publicCode, atMs, userId)
    .first()
    .then(Schema.decodeUnknownOption(RecoveryPairing));

/** Compose in Recovery's consumption batch immediately after its successful credential statement.
 * Recheck expiry and Email Authentication's ownership guard, then require subsequent case/evidence
 * statements to abort the batch if this transition changes no row. Never grants a session. */
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
  WHERE id = ? AND state = 'pending_approval' AND expires_at_ms > ? AND changes() = 1 AND (${emailOwnership.predicate})`)
    .bind(userId, pairingId, atMs, ...emailOwnership.bindings);
