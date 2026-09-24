import { BackupRecoveryCode } from "@fidy/server/client";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { Clock, Data, Effect, Option, Schema } from "effect";
import { newId } from "../pats/pat-shared";
import { RequestBodyPolicy, readBoundedRequestBody } from "../http/request-body";

const Payload = Schema.Struct({
  pairingCode: Schema.String.check(Schema.isPattern(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u)),
  backupRecoveryCode: BackupRecoveryCode,
});
const Claims = Schema.Struct({
  sub: Schema.String.check(Schema.isNonEmpty()),
  iat: Schema.Int.check(Schema.isGreaterThan(0)),
  exp: Schema.Int.check(Schema.isGreaterThan(0)),
});
const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 256,
  deadlineMilliseconds: 2_000,
});
const keys = new Map<string, JWTVerifyGetKey>();
const httpBadRequest = 400;
const httpUnauthorized = 401;
const httpTooManyRequests = 429;
const httpServiceUnavailable = 503;
const httpOk = 200;
const maximumAssertionLength = 8192;
const maximumAssertionLifetimeSeconds = 900;
const millisecondsPerSecond = 1_000;
const operatorWindowMilliseconds = 3_600_000;
const maximumOperatorAttempts = 10;
const digestBytes = 32;
const response = (status: number, body: object): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
const notApproved = (): Response => response(httpBadRequest, { status: "not_approved" });
const unavailable = (): Response => response(httpServiceUnavailable, { status: "unavailable" });
const digest = (value: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((bytes) => new Uint8Array(bytes));

const eligibleAssertion = (
  assertion: Option.Option<string>,
  issuer: string,
  audience: string
): boolean =>
  Option.isSome(assertion) &&
  assertion.value.length > 0 &&
  assertion.value.length <= maximumAssertionLength &&
  /^https:\/\/[^/]+\.cloudflareaccess\.com$/u.test(issuer) &&
  audience.length > 0;
const currentClaims = (claims: Option.Option<typeof Claims.Type>, now: number): boolean =>
  Option.isSome(claims) &&
  claims.value.iat <= now &&
  claims.value.exp > claims.value.iat &&
  claims.value.exp - claims.value.iat <= maximumAssertionLifetimeSeconds &&
  claims.value.exp - now <= maximumAssertionLifetimeSeconds;

/** Origin-side Access JWT validation, including signed issuer, audience and short lived identity. */
export const verifySupportAccess = ({
  assertion,
  issuer,
  audience,
}: {
  assertion: Option.Option<string>;
  issuer: string;
  audience: string;
}): Promise<Option.Option<{ issuer: string; subject: string }>> => {
  if (!eligibleAssertion(assertion, issuer, audience) || Option.isNone(assertion)) {
    return Promise.resolve(Option.none());
  }
  return Promise.resolve()
    .then(() => {
      let jwks = keys.get(issuer);
      if (jwks === undefined) {
        jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
        keys.set(issuer, jwks);
      }
      return jwtVerify(assertion.value, jwks, {
        issuer,
        audience,
        algorithms: ["RS256"],
      });
    })
    .then(({ payload }) => {
      const claims = Schema.decodeUnknownOption(Claims)(payload);
      const now = Math.floor(Effect.runSync(Clock.currentTimeMillis) / millisecondsPerSecond);
      if (!currentClaims(claims, now) || Option.isNone(claims)) {
        return Option.none<{ issuer: string; subject: string }>();
      }
      return Option.some({ issuer, subject: claims.value.sub });
    })
    .catch(() => Option.none());
};

const readPayload = (request: Request): Promise<Option.Option<typeof Payload.Type>> => {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    return Promise.resolve(Option.none());
  }
  return Effect.runPromise(readBoundedRequestBody(request, policy))
    .then((bytes) =>
      Schema.decodeUnknownOption(Payload)(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
      )
    )
    .catch(() => Option.none());
};

const admitOperator = (
  db: D1Database,
  operator: { issuer: string; subject: string },
  now: number
): Promise<"allowed" | "limited" | "unavailable"> =>
  db
    .prepare(`INSERT INTO support_recovery_operator_limits
    (operator_issuer, operator_subject, window_started_at_ms, attempts) VALUES (?, ?, ?, 1)
    ON CONFLICT (operator_issuer, operator_subject) DO UPDATE SET
      window_started_at_ms = CASE WHEN window_started_at_ms <= ? THEN excluded.window_started_at_ms
        ELSE window_started_at_ms END,
      attempts = CASE WHEN window_started_at_ms <= ? THEN 1 ELSE min(attempts + 1, 10) END
    RETURNING attempts`)
    .bind(
      operator.issuer,
      operator.subject,
      now,
      now - operatorWindowMilliseconds,
      now - operatorWindowMilliseconds
    )
    .first()
    .then((limit) => {
      const attempts = Schema.decodeUnknownOption(Schema.Struct({ attempts: Schema.Int }))(limit);
      if (Option.isNone(attempts)) return "unavailable";
      return attempts.value.attempts >= maximumOperatorAttempts ? "limited" : "allowed";
    });

const matchingRecoveryCandidate = (
  db: D1Database,
  input: { codeDigest: Uint8Array; publicCode: string; now: number }
): Promise<boolean> => {
  const { codeDigest, publicCode, now } = input;
  return db
    .prepare(`SELECT p.id FROM browser_login_pairings AS p
    JOIN backup_recovery_credentials AS b ON b.code_digest = ? AND b.consumed_at_ms IS NULL
    WHERE p.public_code = ? AND p.state = 'pending_approval' AND p.expires_at_ms > ?
      AND NOT EXISTS (SELECT 1 FROM browser_pairing_email_proofs AS e
        WHERE e.pairing_id = p.id AND e.user_id <> b.user_id)
      AND NOT EXISTS (SELECT 1 FROM support_recovery_cases WHERE pairing_id = p.id)`)
    .bind(codeDigest, publicCode, now)
    .first()
    .then((candidate) => candidate !== null);
};

const supportPairingUpdate = `UPDATE browser_login_pairings SET state = 'ready', user_id = (
  SELECT b.user_id FROM backup_recovery_credentials AS b
  WHERE b.code_digest = ? AND b.consumed_at_ms IS NULL)
  WHERE public_code = ? AND state = 'pending_approval' AND expires_at_ms > ?
    AND NOT EXISTS (SELECT 1 FROM support_recovery_cases WHERE pairing_id = browser_login_pairings.id)
    AND EXISTS (SELECT 1 FROM backup_recovery_credentials AS b
      WHERE b.code_digest = ? AND b.consumed_at_ms IS NULL
        AND NOT EXISTS (SELECT 1 FROM browser_pairing_email_proofs AS e
          WHERE e.pairing_id = browser_login_pairings.id AND e.user_id <> b.user_id))`;
const recoveryCredentialConsume = `UPDATE backup_recovery_credentials SET code_digest = ?,
  consumed_at_ms = ? WHERE code_digest = ? AND consumed_at_ms IS NULL
  AND EXISTS (SELECT 1 FROM browser_login_pairings AS p
    WHERE p.public_code = ? AND p.user_id = backup_recovery_credentials.user_id
      AND p.state = 'ready' AND p.expires_at_ms > ?) AND changes() = 1`;
const supportCaseInsert = `INSERT INTO support_recovery_cases (id, user_id, pairing_id,
  operator_issuer, operator_subject, credential_revision, opened_at_ms, expires_at_ms,
  state, closed_at_ms) SELECT ?, p.user_id, p.id, ?, ?, b.revision, ?, p.expires_at_ms,
  'approved', ? FROM browser_login_pairings AS p
  JOIN backup_recovery_credentials AS b ON b.user_id = p.user_id
  WHERE p.public_code = ? AND p.state = 'ready' AND p.expires_at_ms > ?
    AND b.consumed_at_ms = ? AND changes() = 1`;
const supportCaseOpened = `INSERT INTO support_recovery_events
  (id, case_id, user_id, operator_issuer, operator_subject, action, at_ms)
  SELECT ?, id, user_id, operator_issuer, operator_subject, 'opened', ?
  FROM support_recovery_cases WHERE id = ? AND changes() = 1`;
const supportCaseApproved = `INSERT INTO support_recovery_events
  (id, case_id, user_id, operator_issuer, operator_subject, action, at_ms)
  VALUES (?, ?, (SELECT user_id FROM support_recovery_cases WHERE id = ?),
    ?, ?, 'approved', ?)`;

type CaseDecision = Readonly<{
  operator: { issuer: string; subject: string };
  codeDigest: Uint8Array;
  publicCode: string;
  now: number;
}>;

const approveCase = (db: D1Database, input: CaseDecision): Promise<boolean> => {
  const caseId = newId();
  const openedId = newId();
  const approvedId = newId();
  const { operator, codeDigest, publicCode, now } = input;
  return db
    .batch([
      db.prepare(supportPairingUpdate).bind(codeDigest, publicCode, now, codeDigest),
      db
        .prepare(recoveryCredentialConsume)
        .bind(
          crypto.getRandomValues(new Uint8Array(digestBytes)),
          now,
          codeDigest,
          publicCode,
          now
        ),
      db
        .prepare(supportCaseInsert)
        .bind(caseId, operator.issuer, operator.subject, now, now, publicCode, now, now),
      db.prepare(supportCaseOpened).bind(openedId, now, caseId),
      // If any conditional transition did not create its case, the final FK aborts the D1 batch.
      db
        .prepare(supportCaseApproved)
        .bind(approvedId, caseId, caseId, operator.issuer, operator.subject, now),
    ])
    .then((pairing) => pairing.every((entry) => entry.meta.changes === 1));
};

const configuredAccess = (config: {
  CLOUDFLARE_ACCESS_ISSUER: string;
  CLOUDFLARE_ACCESS_AUDIENCE: string;
}): boolean =>
  config.CLOUDFLARE_ACCESS_ISSUER.length > 0 && config.CLOUDFLARE_ACCESS_AUDIENCE.length > 0;
const admissionResponse = (admission: "limited" | "unavailable"): Response =>
  admission === "limited" ? response(httpTooManyRequests, { status: "limited" }) : unavailable();

const decideSupportCase = (db: D1Database, input: CaseDecision): Promise<Response> =>
  Promise.resolve()
    .then(() => approveCase(db, input))
    .catch((error: unknown) => {
      // A competing approval can invalidate a conditional D1 batch. Other D1 failures
      // still require a candidate recheck; unrelated exceptions are defects.
      if (isD1Failure(error)) return false;
      throw error;
    })
    .then((approved) =>
      approved
        ? response(httpOk, { status: "approved" })
        : matchingRecoveryCandidate(db, input).then((matches) =>
            matches ? unavailable() : notApproved()
          )
    );

class SupportBoundaryFailure extends Data.TaggedError("SupportBoundaryFailure")<{}> {}

// D1 rejects with a fixed error prefix, while user or programmer exceptions must stay defects.
const isD1Failure = (error: unknown): boolean =>
  error instanceof Error && /^D1_(?:EXEC_)?ERROR:/u.test(error.message);

const waitFor = <A>(run: () => Promise<A>): Effect.Effect<A, SupportBoundaryFailure> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => {
      if (isD1Failure(cause)) return new SupportBoundaryFailure();
      throw cause;
    },
  });

/** The one case-decision boundary: stable User resolution, credential consumption, pairing approval
 * and case events commit in one D1 batch. No public reference can resolve a User alone. */
export const handleSupportRecovery = ({
  request,
  db,
  config,
}: {
  request: Request;
  db: D1Database;
  config: { CLOUDFLARE_ACCESS_ISSUER: string; CLOUDFLARE_ACCESS_AUDIENCE: string };
}): Effect.Effect<Response> => {
  if (!configuredAccess(config)) return Effect.succeed(unavailable());
  return Effect.gen(function* () {
    const operator = yield* waitFor(() =>
      verifySupportAccess({
        assertion: Option.fromNullishOr(request.headers.get("cf-access-jwt-assertion")),
        issuer: config.CLOUDFLARE_ACCESS_ISSUER,
        audience: config.CLOUDFLARE_ACCESS_AUDIENCE,
      })
    );
    if (Option.isNone(operator)) return response(httpUnauthorized, { status: "unauthorized" });
    const now = yield* Clock.currentTimeMillis;
    const admission = yield* waitFor(() => admitOperator(db, operator.value, now));
    if (admission !== "allowed") return admissionResponse(admission);
    const payload = yield* waitFor(() => readPayload(request));
    if (Option.isNone(payload)) return notApproved();
    const codeDigest = yield* waitFor(() => digest(payload.value.backupRecoveryCode));
    const decision = {
      operator: operator.value,
      codeDigest,
      publicCode: payload.value.pairingCode,
      now,
    };
    if (!(yield* waitFor(() => matchingRecoveryCandidate(db, decision)))) return notApproved();
    return yield* waitFor(() => decideSupportCase(db, decision));
  }).pipe(Effect.catchTag("SupportBoundaryFailure", () => Effect.succeed(unavailable())));
};
