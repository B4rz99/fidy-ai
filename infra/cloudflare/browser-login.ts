import {
  BrowserLoginPairingId,
  BrowserLoginPublicCodeSymbols,
  User,
  UserId,
  calculateWebSessionDeadlines,
  decideBrowserLoginRedemption,
  formatPublicCode,
  getCurrentUser,
  maximumWrongVerifierAttempts,
  selectPublicCodeSymbols,
  webSessionIdleRenewalCandidate,
} from "@fidy/server/identity-runtime";
import * as D1Client from "@effect/sql-d1/D1Client";
import { BackupRecoveryCode } from "@fidy/server/client";
import {
  Clock,
  Context,
  DateTime,
  Effect,
  Encoding,
  Exit,
  Function,
  Layer,
  Option,
  Schema,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import { RequestBodyPolicy, readBoundedRequestBody } from "./request-body";

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
const Session = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  user_id: Schema.String.check(Schema.isUUID()),
});
const digestBytes = 32;
const codeSymbols = 8;
const sampleBytes = 16;
const pairingMs = 600_000;
const HTTP_OK = 200;
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
      error: { code: "unauthenticated", message: "Present a valid credential and retry." },
      next: [],
    },
    { status: 401 }
  );
export const sha256 = (value: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((digest) => new Uint8Array(digest));
const sameDigest = (expected: ReadonlyArray<number>, received: Uint8Array): boolean => {
  if (expected.length !== digestBytes || received.length !== digestBytes) return false;
  let difference = 0;
  for (let index = 0; index < digestBytes; index++) {
    difference |= (expected[index] ?? 0) ^ (received[index] ?? 0);
  }
  return difference === 0;
};
const now = (): number => Effect.runSync(Clock.currentTimeMillis);
// @effect-diagnostics-next-line cryptoRandomUUID:off
const uuid = (): string => crypto.randomUUID();
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
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const startBrowserPairing = async (db: D1Database): Promise<Response> => {
  const started = now();
  // Expiry is checked at every use; pruning is bounded and cannot change an active pairing.
  await db
    .prepare(`DELETE FROM browser_login_pairings WHERE id IN (
    SELECT id FROM browser_login_pairings WHERE expires_at_ms <= ? AND id NOT IN
    (SELECT pairing_id FROM web_sessions) ORDER BY expires_at_ms LIMIT 32)`)
    .bind(started)
    .run();
  const publicCode = samplePublicCode();
  const privateVerifier = Encoding.encodeBase64Url(
    crypto.getRandomValues(new Uint8Array(digestBytes))
  );
  const pairingId = uuid();
  const result = await db
    .prepare(`INSERT INTO browser_login_pairings
    (id, public_code, verifier_digest, created_at_ms, expires_at_ms)
    VALUES (?, ?, ?, ?, ?)`)
    .bind(pairingId, publicCode, await sha256(privateVerifier), started, started + pairingMs)
    .run();
  if (result.meta.changes !== 1) return unavailable();
  return json({
    pairingId,
    privateVerifier,
    publicCode,
    expiresAt: instant(started + pairingMs),
    pollingIntervalSeconds: 5,
  });
};

/** One signed WhatsApp message may bind one pending challenge to its established User. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const approveBrowserPairing = async (
  db: D1Database,
  input: Readonly<{
    portfolioId: string;
    bsuid: string;
    messageId: string;
    publicCode: string;
    occurredAtMs: number;
    receivedAtMs: number;
  }>
): Promise<Response> => {
  try {
    const result = await db
      .prepare(`INSERT INTO browser_login_approvals (portfolio_id, message_id, pairing_id, user_id)
      SELECT ?, ?, p.id, w.user_id FROM browser_login_pairings AS p
      JOIN whatsapp_identities AS w ON w.portfolio_id = ? AND w.bsuid = ?
      JOIN onboarding_consent_records AS c ON c.user_id = w.user_id
      WHERE p.public_code = ? AND p.state = 'pending_approval'
        AND p.expires_at_ms > ? AND p.expires_at_ms > ?
        AND ? >= (p.created_at_ms / 1000) * 1000`)
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
      .run();
    return result.meta.changes > 0 ? new Response(null, { status: 200 }) : invalid();
  } catch {
    return invalid();
  }
};

/** Redeem only an approved pairing with the browser's independent verifier. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const redeemBrowserPairing = async (request: Request, db: D1Database): Promise<Response> => {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") return invalid();
  try {
    const bytes = await Effect.runPromise(readBoundedRequestBody(request, policy));
    const candidate: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const proof = Schema.decodeUnknownOption(PairingProof)(candidate);
    if (Option.isNone(proof)) return invalid();
    const raw = await db
      .prepare(`SELECT verifier_digest, expires_at_ms, wrong_attempts, state,
        last_poll_at_ms, minimum_poll_interval_seconds
      FROM browser_login_pairings WHERE id = ?`)
      .bind(proof.value.pairingId)
      .first();
    if (raw === null) return invalid();
    const pairing = Schema.decodeUnknownOption(Pairing)(raw);
    if (Option.isNone(pairing)) return unavailable();
    return await redeemValidProof(db, proof.value, pairing.value);
  } catch {
    return invalid();
  }
};

// @effect-diagnostics-next-line asyncFunction:off
const redeemValidProof = async (
  db: D1Database,
  proof: typeof PairingProof.Type,
  pairing: typeof Pairing.Type
): Promise<Response> => {
  const current = now();
  const decision = decideBrowserLoginRedemption({
    lifecycle: pairing.state,
    verifierMatches: sameDigest(pairing.verifier_digest, await sha256(proof.privateVerifier)),
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
    return recordWrongVerifier({ db, pairingId: proof.pairingId, pairing, decision });
  }
  if (decision._tag === "SlowDown") {
    return delayPoll({ db, pairingId: proof.pairingId, state: pairing.state, decision });
  }
  if (decision._tag === "Pending") {
    return recordPoll({ db, pairingId: proof.pairingId, pairing, current, decision });
  }
  if (decision._tag !== "Consume") return invalid();
  return createWebSession(db, proof.pairingId, current);
};

// @effect-diagnostics-next-line asyncFunction:off
const recordWrongVerifier = async ({
  db,
  pairingId,
  pairing,
  decision,
}: {
  db: D1Database;
  pairingId: string;
  pairing: typeof Pairing.Type;
  decision: Extract<ReturnType<typeof decideBrowserLoginRedemption>, { _tag: "WrongVerifier" }>;
}): Promise<Response> => {
  await db
    .prepare(`UPDATE browser_login_pairings SET wrong_attempts = ?, state = ?,
      user_id = CASE WHEN ? = 'invalidated' THEN NULL ELSE user_id END
    WHERE id = ? AND state = ? AND wrong_attempts = ?`)
    .bind(
      decision.wrongVerifierAttempts,
      decision.lifecycle,
      decision.lifecycle,
      pairingId,
      pairing.state,
      pairing.wrong_attempts
    )
    .run();
  return invalid();
};

// @effect-diagnostics-next-line asyncFunction:off
const delayPoll = async ({
  db,
  pairingId,
  state,
  decision,
}: {
  db: D1Database;
  pairingId: string;
  state: string;
  decision: Extract<ReturnType<typeof decideBrowserLoginRedemption>, { _tag: "SlowDown" }>;
}): Promise<Response> => {
  await db
    .prepare(
      `UPDATE browser_login_pairings SET minimum_poll_interval_seconds = ? WHERE id = ? AND state = ?`
    )
    .bind(Math.min(decision.minimumPollIntervalSeconds, maximumPollSeconds), pairingId, state)
    .run();
  return json(
    { error: { code: "rate_limited", retryAfterSeconds: decision.retryAfterSeconds } },
    HTTP_RATE_LIMITED,
    { "retry-after": String(decision.retryAfterSeconds) }
  );
};

// @effect-diagnostics-next-line asyncFunction:off
const recordPoll = async ({
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
}): Promise<Response> => {
  const accepted = await db
    .prepare(`UPDATE browser_login_pairings SET last_poll_at_ms = ?
    WHERE id = ? AND state = 'pending_approval' AND last_poll_at_ms IS ? AND expires_at_ms > ?`)
    .bind(current, pairingId, pairing.last_poll_at_ms, current)
    .run();
  if (accepted.meta.changes !== 1) return invalid();
  return json(
    {
      status: "pending_approval",
      expiresAt: instant(pairing.expires_at_ms),
      pollingIntervalSeconds: decision.minimumPollIntervalSeconds,
    },
    HTTP_PENDING
  );
};

// @effect-diagnostics-next-line asyncFunction:off
const createWebSession = async (
  db: D1Database,
  pairingId: string,
  current: number
): Promise<Response> => {
  const token = Encoding.encodeBase64Url(crypto.getRandomValues(new Uint8Array(digestBytes)));
  const deadlines = calculateWebSessionDeadlines(DateTime.makeUnsafe(current));
  const committed = await db.batch([
    db
      .prepare(
        `UPDATE browser_login_pairings SET state = 'consumed' WHERE id = ? AND state = 'ready' AND expires_at_ms > ? AND wrong_attempts < ?`
      )
      .bind(pairingId, current, maximumWrongVerifierAttempts),
    db
      .prepare(`INSERT INTO web_sessions (id, pairing_id, user_id, token_digest, created_at_ms,
        fresh_until_ms, idle_expires_at_ms, hard_expires_at_ms)
      SELECT ?, p.id, p.user_id, ?, ?, ?, ?, ? FROM browser_login_pairings AS p
      WHERE p.id = ? AND p.state = 'consumed' AND p.user_id IS NOT NULL`)
      .bind(
        uuid(),
        await sha256(token),
        current,
        DateTime.toEpochMillis(deadlines.freshUntil),
        DateTime.toEpochMillis(deadlines.idleExpiresAt),
        DateTime.toEpochMillis(deadlines.hardExpiresAt),
        pairingId
      ),
  ]);
  if (committed[1]?.meta.changes !== 1) return invalid();
  return json({ status: "authenticated" }, HTTP_OK, {
    "set-cookie": sessionSetCookie(token),
  });
};

const sessionSetCookie = (token: string): string =>
  `__Host-fidy_session=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`;

export const sessionCookie = (request: Request): Option.Option<string> => {
  const cookies =
    request.headers
      .get("cookie")
      ?.split(";")
      .map((value) => value.trim()) ?? [];
  const selected = cookies.filter((cookie) => cookie.startsWith("__Host-fidy_session="));
  if (selected.length !== 1) return Option.none();
  const value = selected[0]?.slice("__Host-fidy_session=".length) ?? "";
  return /^[A-Za-z0-9_-]{43}$/u.test(value) ? Option.some(value) : Option.none();
};

/** Resolve a live WebSession; account-security actions additionally require a fresh decision. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const browserSession = async (
  request: Request,
  db: D1Database,
  input: Readonly<{ current: number; fresh: boolean }>
): Promise<Option.Option<typeof Session.Type>> => {
  const token = sessionCookie(request);
  if (Option.isNone(token)) return Option.none();
  const row = await db
    .prepare(`SELECT id, user_id FROM web_sessions
    WHERE token_digest = ? AND revoked_at_ms IS NULL AND (? = 0 OR fresh_until_ms > ?)
      AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?`)
    .bind(
      await sha256(token.value),
      input.fresh ? 1 : 0,
      input.current,
      input.current,
      input.current
    )
    .first();
  return Schema.decodeUnknownOption(Session)(row);
};

/** Resolve the exact still-fresh browser session for an account-security action. */
export const freshBrowserSession: {
  (request: Request, db: D1Database, current: number): Promise<Option.Option<typeof Session.Type>>;
  (
    db: D1Database,
    current: number
  ): (request: Request) => Promise<Option.Option<typeof Session.Type>>;
} = Function.dual(3, (request: Request, db: D1Database, current: number) =>
  browserSession(request, db, { current, fresh: true })
);

/** Return the canonical User projection only for a live, unrevoked WebSession. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const currentUser = async (request: Request, db: D1Database): Promise<Response> => {
  const token = sessionCookie(request);
  if (Option.isNone(token)) return noSession();
  try {
    const digest = await sha256(token.value);
    const usedAt = now();
    const candidate = webSessionIdleRenewalCandidate(DateTime.makeUnsafe(usedAt));
    const rawSession = await db
      .prepare(`UPDATE web_sessions SET idle_expires_at_ms = min(hard_expires_at_ms,
        max(idle_expires_at_ms, ?)) WHERE token_digest = ? AND revoked_at_ms IS NULL
        AND idle_expires_at_ms > ? AND hard_expires_at_ms > ? RETURNING id, user_id`)
      .bind(DateTime.toEpochMillis(candidate), digest, usedAt, usedAt)
      .first();
    if (rawSession === null) return noSession();
    const session = Schema.decodeUnknownOption(Session)(rawSession);
    if (Option.isNone(session)) return unavailable();
    const subject = Schema.decodeOption(UserId)(session.value.user_id);
    if (Option.isNone(subject)) return unavailable();
    const loaded = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const clients = yield* Layer.build(D1Client.layer({ db }));
          return yield* getCurrentUser(subject.value).pipe(
            Effect.withTracerEnabled(false),
            Effect.provideService(SqlClient.SqlClient, Context.get(clients, SqlClient.SqlClient))
          );
        })
      )
    );
    if (Exit.isFailure(loaded)) return unavailable();
    await db
      .prepare(
        `INSERT INTO canonical_user_reads (id, user_id, session_id, occurred_at_ms) VALUES (?, ?, ?, ?)`
      )
      .bind(uuid(), session.value.user_id, session.value.id, now())
      .run();
    return json(
      {
        data: Schema.encodeSync(Schema.toCodecJson(User))(loaded.value.data),
        next: loaded.value.next,
      },
      HTTP_OK,
      { "set-cookie": sessionSetCookie(token.value) }
    );
  } catch {
    return unavailable();
  }
};

/** Require a still-fresh browser session before rotating its User's emergency proof. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const rotateBackupRecoveryCode = async (
  request: Request,
  db: D1Database
): Promise<Response> => {
  const token = sessionCookie(request);
  if (Option.isNone(token)) return noSession();
  try {
    const usedAt = now();
    const session = await db
      .prepare(`SELECT id, user_id FROM web_sessions
      WHERE token_digest = ? AND revoked_at_ms IS NULL AND fresh_until_ms > ?
        AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?`)
      .bind(await sha256(token.value), usedAt, usedAt, usedAt)
      .first();
    if (session === null) return noSession();
    const decoded = Schema.decodeUnknownOption(Session)(session);
    if (Option.isNone(decoded)) return unavailable();
    return rotateFreshSessionProof(db, decoded.value, usedAt);
  } catch {
    return unavailable();
  }
};

// @effect-diagnostics-next-line asyncFunction:off
const rotateFreshSessionProof = async (
  db: D1Database,
  session: typeof Session.Type,
  usedAt: number
): Promise<Response> => {
  const code = Schema.decodeOption(BackupRecoveryCode)(sampleRecoveryCode());
  if (Option.isNone(code)) return unavailable();
  const rotated = await db.batch([
    db
      .prepare(`UPDATE backup_recovery_credentials SET code_digest = ?, created_at_ms = ?,
        consumed_at_ms = NULL, revision = revision + 1
        WHERE user_id = ? AND EXISTS (SELECT 1 FROM web_sessions
        WHERE id = ? AND user_id = ? AND revoked_at_ms IS NULL AND fresh_until_ms > ?
        AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?)`)
      .bind(
        await sha256(code.value),
        usedAt,
        session.user_id,
        session.id,
        session.user_id,
        usedAt,
        usedAt,
        usedAt
      ),
    db
      .prepare(`INSERT INTO canonical_security_mutations (id, user_id, session_id, operation, occurred_at_ms)
        SELECT ?, ?, ?, 'recovery.rotateBackupRecoveryCode', ? WHERE changes() = 1`)
      .bind(uuid(), session.user_id, session.id, usedAt),
  ]);
  if (rotated[0]?.meta.changes !== 1 || rotated[1]?.meta.changes !== 1) return noSession();
  return json({
    data: { status: "rotated", backupRecoveryCode: code.value, rotatedAt: instant(usedAt) },
    next: [],
  });
};

/** Revoke the exact cookie's session without disclosing whether it existed. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const logoutBrowser = async (request: Request, db: D1Database): Promise<Response> => {
  const token = sessionCookie(request);
  if (Option.isSome(token)) {
    await db
      .prepare(
        `UPDATE web_sessions SET revoked_at_ms = ? WHERE token_digest = ? AND revoked_at_ms IS NULL`
      )
      .bind(now(), await sha256(token.value))
      .run();
  }
  return new Response(null, {
    status: 204,
    headers: {
      "set-cookie": "__Host-fidy_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
      "cache-control": "no-store",
    },
  });
};
