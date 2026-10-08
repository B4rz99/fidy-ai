import {
  approvedRecoveryBrowserPairingQuery,
  pendingRecoveryBrowserPairingQuery,
  prepareRecoveryBrowserPairingApproval,
} from "../../browser-login/operations";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { emailPairingAllowsUser } from "../../../src/shell/email-authentication/operations";
import { BackupRecoveryCode } from "../../../src/core/recovery/contract";
import { recoveryCodeDigest } from "./material";
import { type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from "jose";
import { Clock, Data, DateTime, Effect, Option, Schema } from "effect";
import { newId } from "../../secret-material/operations";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";

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
  claims.value.exp > now &&
  claims.value.exp > claims.value.iat &&
  claims.value.exp - claims.value.iat <= maximumAssertionLifetimeSeconds &&
  claims.value.exp - now <= maximumAssertionLifetimeSeconds;

/** Origin-side Access JWT validation, including signed issuer, audience and short lived identity. */
const verifySupportAccess = ({
  assertion,
  issuer,
  audience,
  clock,
}: {
  assertion: Option.Option<string>;
  issuer: string;
  audience: string;
  clock: Clock.Clock;
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
        // Jose reads this after key retrieval and signature verification, not at request entry.
        get currentDate(): Date {
          return DateTime.toDateUtc(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe()));
        },
      });
    })
    .then(({ payload }) => {
      const claims = Schema.decodeUnknownOption(Claims)(payload);
      const now = Math.floor(clock.currentTimeMillisUnsafe() / millisecondsPerSecond);
      if (!currentClaims(claims, now) || Option.isNone(claims)) {
        return Option.none<{ issuer: string; subject: string }>();
      }
      return Option.some({ issuer, subject: claims.value.sub });
    })
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

const recoveryCandidateQuery = ({
  codeDigest,
  publicCode,
  now,
}: Readonly<{ codeDigest: Uint8Array; publicCode: string; now: number }>): OwnedStatement => {
  const pending = pendingRecoveryBrowserPairingQuery({ publicCode, current: now });
  return emailPairingAllowsUser({
    subject: {
      sql: `SELECT p.pairingId, b.user_id AS userId FROM (${pending.sql}) AS p
        JOIN backup_recovery_credentials AS b ON b.code_digest = ? AND b.consumed_at_ms IS NULL
        WHERE NOT EXISTS (SELECT 1 FROM support_recovery_cases WHERE pairing_id = p.pairingId)`,
      params: [...pending.params, codeDigest],
    },
  });
};

const matchingRecoveryCandidate = (
  db: D1Database,
  input: Readonly<{ codeDigest: Uint8Array; publicCode: string; now: number }>
): Promise<boolean> => {
  const candidateStatement = recoveryCandidateQuery(input);
  return db
    .prepare(candidateStatement.sql)
    .bind(...candidateStatement.params)
    .first()
    .then((candidate) => candidate !== null);
};

const recoveryCredentialConsume = ({
  ready,
  codeDigest,
  now,
}: Readonly<{ ready: OwnedStatement; codeDigest: Uint8Array; now: number }>): OwnedStatement => ({
  sql: `UPDATE backup_recovery_credentials SET code_digest = ?, consumed_at_ms = ?
    WHERE code_digest = ? AND consumed_at_ms IS NULL
      AND EXISTS (SELECT 1 FROM (${ready.sql}) AS p
        WHERE p.userId = backup_recovery_credentials.user_id) AND changes() = 1`,
  params: [crypto.getRandomValues(new Uint8Array(digestBytes)), now, codeDigest, ...ready.params],
});

const supportCaseInsert = ({
  ready,
  caseId,
  operator,
  now,
}: Readonly<{
  ready: OwnedStatement;
  caseId: string;
  operator: { issuer: string; subject: string };
  now: number;
}>): OwnedStatement => ({
  sql: `INSERT INTO support_recovery_cases (id, user_id, pairing_id,
    operator_issuer, operator_subject, credential_revision, opened_at_ms, expires_at_ms,
    state, closed_at_ms) SELECT ?, p.userId, p.pairingId, ?, ?, b.revision, ?, p.expiresAt,
    'approved', ? FROM (${ready.sql}) AS p
    JOIN backup_recovery_credentials AS b ON b.user_id = p.userId
    WHERE b.consumed_at_ms = ? AND changes() = 1`,
  params: [caseId, operator.issuer, operator.subject, now, now, ...ready.params, now],
});
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
  const ready = approvedRecoveryBrowserPairingQuery({ publicCode, current: now });
  const credentialStatement = recoveryCredentialConsume({ ready, codeDigest, now });
  const caseStatement = supportCaseInsert({ ready, caseId, operator, now });
  return db
    .batch([
      prepareRecoveryBrowserPairingApproval({
        db,
        subject: recoveryCandidateQuery(input),
        current: now,
      }),
      db.prepare(credentialStatement.sql).bind(...credentialStatement.params),
      db.prepare(caseStatement.sql).bind(...caseStatement.params),
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
  error instanceof Error && /^D1_(?:EXEC_)?ERROR(?::|$)/u.test(error.message);

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
    const clock = yield* Clock.Clock;
    const operator = yield* waitFor(() =>
      verifySupportAccess({
        assertion: Option.fromNullishOr(request.headers.get("cf-access-jwt-assertion")),
        issuer: config.CLOUDFLARE_ACCESS_ISSUER,
        audience: config.CLOUDFLARE_ACCESS_AUDIENCE,
        clock,
      })
    );
    if (Option.isNone(operator)) return response(httpUnauthorized, { status: "unauthorized" });
    const now = yield* Clock.currentTimeMillis;
    const admission = yield* waitFor(() => admitOperator(db, operator.value, now));
    if (admission !== "allowed") return admissionResponse(admission);
    const payload = yield* boundedJsonBody({ request, policy, schema: Payload });
    if (Option.isNone(payload)) return notApproved();
    const codeDigest = yield* waitFor(() => recoveryCodeDigest(payload.value.backupRecoveryCode));
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
