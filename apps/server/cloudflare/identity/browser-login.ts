import { BrowserLoginPairingId } from "../../src/core/browser-login/reference";
import { browserSession, createWebSession } from "../web-session/operations";
import {
  BrowserLoginPublicCodeSymbols,
  decideBrowserLoginRedemption,
  formatPublicCode,
  selectPublicCodeSymbols,
} from "../../src/core/browser-login/rules";
import { BackupRecoveryCode } from "@fidy/server/client";
import { Clock, Crypto, DateTime, Effect, Encoding, Option, PlatformError, Schema } from "effect";
import { RequestBodyPolicy, readBoundedRequestBody } from "../http/request-body";

const PairingProof = Schema.Struct({
  pairingId: BrowserLoginPairingId,
  privateVerifier: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
});
const Pairing = Schema.Struct({
  verifier_digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
  expires_at_ms: Schema.Finite,
  wrong_attempts: Schema.Int,
  last_poll_at_ms: Schema.NullOr(Schema.Finite),
  minimum_poll_interval_seconds: Schema.Int,
  state: Schema.Literals(["pending_approval", "ready", "consumed", "invalidated"]),
});
const digestBytes = 32;
const codeSymbols = 8;
const sampleBytes = 16;
const pairingMs = 600_000;
const HTTP_PENDING = 202;
const HTTP_RATE_LIMITED = 429;
const maximumPollSeconds = 60;
const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 512,
  deadlineMilliseconds: 2_000,
});
const invalid = (): Response =>
  Response.json(
    {
      error: {
        code: "pairing_invalid",
        message: "Esta vinculación ya no es válida. Inicia de nuevo.",
      },
    },
    { status: 400 }
  );
const unavailable = (): Response => Response.json({ status: "unavailable" }, { status: 503 });
const noSession = (): Response =>
  Response.json(
    {
      error: {
        code: "unauthenticated",
        message: "Present a valid credential and retry.",
      },
      next: [],
    },
    { status: 401 }
  );
export const sha256 = (value: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((digest) => new Uint8Array(digest));
const sameDigest = (expected: ReadonlyArray<number>, received: Uint8Array): boolean => {
  if (expected.length !== digestBytes || received.length !== digestBytes) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < digestBytes; index++) {
    difference |= (expected[index] ?? 0) ^ (received[index] ?? 0);
  }
  return difference === 0;
};
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, void> =>
  Effect.tryPromise({ try: run, catch: () => undefined });
const workerCrypto = Crypto.make({
  randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.tryPromise({
      try: () =>
        crypto.subtle
          .digest(algorithm, Uint8Array.from(data))
          .then((bytes) => new Uint8Array(bytes)),
      catch: (cause) =>
        PlatformError.systemError({
          _tag: "Unknown",
          module: "WorkerCrypto",
          method: "digest",
          cause,
        }),
    }),
});
const uuid = (): string => Effect.runSync(workerCrypto.randomUUIDv4.pipe(Effect.orDie));
const instant = (epochMs: number): string => DateTime.formatIso(DateTime.makeUnsafe(epochMs));
const json = (body: object, status = 200, headers?: HeadersInit): Response => {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "no-store");
  return Response.json(body, { status, headers: responseHeaders });
};

const recoveryAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const recoverySymbolCount = 25;
const sampleRecoveryCode = (): string =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(recoverySymbolCount)),
    (byte) => recoveryAlphabet[byte % recoveryAlphabet.length]
  )
    .join("")
    .match(/.{5}/gu)
    ?.join("-") ?? "";

const samplePublicCode = (): string => {
  let symbols = "";
  while (symbols.length < codeSymbols) {
    symbols += selectPublicCodeSymbols({
      bytes: Array.from(crypto.getRandomValues(new Uint8Array(sampleBytes))),
      maximum: codeSymbols - symbols.length,
    });
  }
  return formatPublicCode(Schema.decodeSync(BrowserLoginPublicCodeSymbols)(symbols));
};

/** Start an unbound browser challenge. Only the browser receives its private verifier. */
export const startBrowserPairing = (db: D1Database): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      // Expiry is checked at every use; pruning is bounded and cannot change an active pairing.
      yield* attempt(() =>
        db
          .prepare(
            `DELETE FROM browser_login_pairings WHERE id IN (
    SELECT id FROM browser_login_pairings WHERE expires_at_ms <= ? AND id NOT IN
    (SELECT pairing_id FROM web_sessions) ORDER BY expires_at_ms LIMIT 32)`
          )
          .bind(started)
          .run()
      );
      const publicCode = samplePublicCode();
      const privateVerifier = Encoding.encodeBase64Url(
        crypto.getRandomValues(new Uint8Array(digestBytes))
      );
      const pairingId = uuid();
      const proofDigest = yield* attempt(() => sha256(privateVerifier));
      const result = yield* attempt(() =>
        db
          .prepare(
            `INSERT INTO browser_login_pairings
    (id, public_code, verifier_digest, created_at_ms, expires_at_ms)
    VALUES (?, ?, ?, ?, ?)`
          )
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

/** One signed WhatsApp message may bind one pending challenge to its established User. */
type ApprovalInput = Readonly<{
  portfolioId: string;
  bsuid: string;
  messageId: string;
  publicCode: string;
  occurredAtMs: number;
  receivedAtMs: number;
}>;
export const approveBrowserPairing = ({
  db,
  input,
}: {
  db: D1Database;
  input: ApprovalInput;
}): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* attempt(() =>
        db
          .prepare(
            `INSERT INTO browser_login_approvals (portfolio_id, message_id, pairing_id, user_id)
      SELECT ?, ?, p.id, w.user_id FROM browser_login_pairings AS p
      JOIN whatsapp_identities AS w ON w.portfolio_id = ? AND w.bsuid = ?
      JOIN onboarding_consent_records AS c ON c.user_id = w.user_id
      WHERE p.public_code = ? AND p.state = 'pending_approval'
        AND p.expires_at_ms > ? AND p.expires_at_ms > ?
        AND ? >= (p.created_at_ms / 1000) * 1000`
          )
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

/** Redeem only an approved pairing with the browser's independent verifier. */
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
      {
        const bytes = yield* readBoundedRequestBody(request, policy);
        const text = yield* Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          catch: () => undefined,
        });
        const proof = Schema.decodeOption(Schema.fromJsonString(PairingProof))(text);
        if (Option.isNone(proof)) return invalid();
        const raw = yield* attempt(() =>
          db
            .prepare(
              `SELECT verifier_digest, expires_at_ms, wrong_attempts, state,
        last_poll_at_ms, minimum_poll_interval_seconds
      FROM browser_login_pairings WHERE id = ?`
            )
            .bind(proof.value.pairingId)
            .first()
        );
        if (raw === null) return invalid();
        const pairing = Schema.decodeUnknownOption(Pairing)(raw);
        if (Option.isNone(pairing)) return unavailable();
        return yield* redeemValidProof(db, proof.value, pairing.value);
      }
    }).pipe(Effect.catchCause(() => Effect.succeed(invalid())))
  );

const redeemValidProof = (
  db: D1Database,
  proof: typeof PairingProof.Type,
  pairing: typeof Pairing.Type
): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const decision = decideBrowserLoginRedemption({
      lifecycle: pairing.state,
      verifierMatches: sameDigest(
        pairing.verifier_digest,
        yield* attempt(() => sha256(proof.privateVerifier))
      ),
      wrongVerifierAttempts: pairing.wrong_attempts,
      minimumPollIntervalSeconds: pairing.minimum_poll_interval_seconds,
      lastAcceptedPollAt: Option.map(
        Option.fromNullishOr(pairing.last_poll_at_ms),
        DateTime.makeUnsafe
      ),
      expiresAt: DateTime.makeUnsafe(pairing.expires_at_ms),
      attemptedAt: DateTime.makeUnsafe(current),
    });
    if (decision._tag === "WrongVerifier") {
      return yield* recordWrongVerifier({
        db,
        pairingId: proof.pairingId,
        pairing,
        decision,
      });
    }
    if (decision._tag === "SlowDown") {
      return yield* delayPoll({
        db,
        pairingId: proof.pairingId,
        state: pairing.state,
        decision,
      });
    }
    if (decision._tag === "Pending") {
      return yield* recordPoll({
        db,
        pairingId: proof.pairingId,
        pairing,
        current,
        decision,
      });
    }
    if (decision._tag !== "Consume") return invalid();
    return yield* createWebSession({ db, pairingId: proof.pairingId, current });
  });

const recordWrongVerifier = ({
  db,
  pairingId,
  pairing,
  decision,
}: {
  db: D1Database;
  pairingId: string;
  pairing: typeof Pairing.Type;
  decision: Extract<ReturnType<typeof decideBrowserLoginRedemption>, { _tag: "WrongVerifier" }>;
}): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    yield* attempt(() =>
      db
        .prepare(
          `UPDATE browser_login_pairings SET wrong_attempts = ?, state = ?,
      user_id = CASE WHEN ? = 'invalidated' THEN NULL ELSE user_id END
    WHERE id = ? AND state = ? AND wrong_attempts = ?`
        )
        .bind(
          decision.wrongVerifierAttempts,
          decision.lifecycle,
          decision.lifecycle,
          pairingId,
          pairing.state,
          pairing.wrong_attempts
        )
        .run()
    );
    return invalid();
  });

const delayPoll = ({
  db,
  pairingId,
  state,
  decision,
}: {
  db: D1Database;
  pairingId: string;
  state: string;
  decision: Extract<ReturnType<typeof decideBrowserLoginRedemption>, { _tag: "SlowDown" }>;
}): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    yield* attempt(() =>
      db
        .prepare(
          `UPDATE browser_login_pairings SET minimum_poll_interval_seconds = ? WHERE id = ? AND state = ?`
        )
        .bind(Math.min(decision.minimumPollIntervalSeconds, maximumPollSeconds), pairingId, state)
        .run()
    );
    return json(
      {
        error: {
          code: "rate_limited",
          retryAfterSeconds: decision.retryAfterSeconds,
        },
      },
      HTTP_RATE_LIMITED,
      { "retry-after": String(decision.retryAfterSeconds) }
    );
  });

const recordPoll = ({
  db,
  pairingId,
  pairing,
  current,
  decision,
}: {
  db: D1Database;
  pairingId: string;
  pairing: typeof Pairing.Type;
  current: number;
  decision: Extract<ReturnType<typeof decideBrowserLoginRedemption>, { _tag: "Pending" }>;
}): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    const accepted = yield* attempt(() =>
      db
        .prepare(
          `UPDATE browser_login_pairings SET last_poll_at_ms = ?
    WHERE id = ? AND state = 'pending_approval' AND last_poll_at_ms IS ? AND expires_at_ms > ?`
        )
        .bind(current, pairingId, pairing.last_poll_at_ms, current)
        .run()
    );
    if (accepted.meta.changes !== 1) return invalid();
    return json(
      {
        status: "pending_approval",
        expiresAt: instant(pairing.expires_at_ms),
        pollingIntervalSeconds: decision.minimumPollIntervalSeconds,
      },
      HTTP_PENDING
    );
  });

/** Require a still-fresh browser session before rotating its User's emergency proof. */
export const rotateBackupRecoveryCode = ({
  request,
  db,
}: {
  request: Request;
  db: D1Database;
}): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const usedAt = yield* Clock.currentTimeMillis;
      const session = yield* attempt(() =>
        browserSession({ request, db, input: { current: usedAt, fresh: true } })
      );
      if (Option.isNone(session)) return noSession();
      return yield* rotateFreshSessionProof(db, session.value, usedAt);
    }).pipe(Effect.catchCause(() => Effect.succeed(unavailable())))
  );

const rotateFreshSessionProof = (
  db: D1Database,
  session: Readonly<{ id: string; userId: string }>,
  usedAt: number
): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    const code = Schema.decodeOption(BackupRecoveryCode)(sampleRecoveryCode());
    if (Option.isNone(code)) return unavailable();
    const codeDigest = yield* attempt(() => sha256(code.value));
    const rotated = yield* attempt(() =>
      db.batch([
        db
          .prepare(
            `UPDATE backup_recovery_credentials SET code_digest = ?, created_at_ms = ?,
        consumed_at_ms = NULL, revision = revision + 1
        WHERE user_id = ? AND EXISTS (SELECT 1 FROM web_sessions
        WHERE id = ? AND user_id = ? AND revoked_at_ms IS NULL AND fresh_until_ms > ?
        AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?)`
          )
          .bind(
            codeDigest,
            usedAt,
            session.userId,
            session.id,
            session.userId,
            usedAt,
            usedAt,
            usedAt
          ),
        db
          .prepare(
            `INSERT INTO canonical_security_mutations (id, user_id, session_id, operation, occurred_at_ms)
        SELECT ?, ?, ?, 'recovery.rotateBackupRecoveryCode', ? WHERE changes() = 1`
          )
          .bind(uuid(), session.userId, session.id, usedAt),
      ])
    );
    if (rotated[0]?.meta.changes !== 1 || rotated[1]?.meta.changes !== 1) {
      return noSession();
    }
    return json({
      data: {
        status: "rotated",
        backupRecoveryCode: code.value,
        rotatedAt: instant(usedAt),
      },
      next: [],
    });
  });
