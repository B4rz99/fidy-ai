import {
  CompleteEmailReplacementPayload,
  RequestEmailReplacementPayload,
  emailReplacementFreshBody,
  emailReplacementInvalidBody,
} from "@fidy/server/client";
import {
  EmailReplacementMutation,
  type EmailReplacementMutationService,
  browserReplacementCaller,
  emailReplacementImplementations,
  permitsFreshBrowserReplacement,
} from "@fidy/server/email-replacement";
import { Data, Effect, Option, Schema } from "effect";
import { freshBrowserSession } from "./browser-login";
import { RequestBodyPolicy, readBoundedRequestBody } from "./request-body";

const Proof = Schema.Struct({
  user_id: Schema.String.check(Schema.isUUID()),
  work_id: Schema.String.check(Schema.isUUID()),
  proof_digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
});
const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 512,
  deadlineMilliseconds: 2_000,
});
const HTTP_OK = 200;
const HTTP_INVALID = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_UNAVAILABLE = 503;
const digestLength = 32;
const proofPublicLength = 9;
const proofSecretOffset = 10;
const proofLifetimeMilliseconds = 600_000;
const admissionWindowMilliseconds = 86_400_000;
const json = (body: object, status: number): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
const invalid = (): Response => json(emailReplacementInvalidBody, HTTP_INVALID);
const unavailable = (): Response => json({ status: "unavailable" }, HTTP_UNAVAILABLE);
const fresh = (): Response => json(emailReplacementFreshBody, HTTP_UNAUTHORIZED);
const digest = (value: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((bytes) => new Uint8Array(bytes));
const equalDigest = (left: ReadonlyArray<number>, right: Uint8Array): boolean => {
  if (left.length !== digestLength || right.length !== digestLength) return false;
  let difference = 0;
  for (let index = 0; index < digestLength; index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
};

// @effect-diagnostics-next-line asyncFunction:off
const readProof = async <A, Encoded>(
  request: globalThis.Request,
  schema: Schema.Codec<A, Encoded>
): Promise<Option.Option<A>> => {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    return Option.none();
  }
  try {
    const bytes = await Effect.runPromise(readBoundedRequestBody(request, policy));
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return Schema.decodeUnknownOption(schema)(value);
  } catch {
    return Option.none();
  }
};

/** Start a candidate-mailbox proof for a fresh WebSession, without disclosing collisions. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const requestEmailReplacement = async (
  request: globalThis.Request,
  db: D1Database
): Promise<Response> => {
  const input = await readProof(request, RequestEmailReplacementPayload);
  if (Option.isNone(input)) return invalid();
  try {
    // @effect-diagnostics-next-line globalDate:off
    const current = Date.now();
    const session = await freshBrowserSession(request, db, current);
    if (Option.isNone(session)) return fresh();
    if (!permitsFreshBrowserReplacement("request")) return unavailable();
    const result = await Effect.runPromise(
      emailReplacementImplementations
        .request({ payload: input.value }, browserReplacementCaller(session.value))
        .pipe(
          Effect.provideService(
            EmailReplacementMutation,
            replacementAdapter(db, session.value, current)
          )
        )
    );
    return json(result, HTTP_OK);
  } catch {
    return unavailable();
  }
};

// @effect-diagnostics-next-line asyncFunction:off
const startProof = async (
  db: D1Database,
  input: {
    session: SessionSubject;
    candidateEmail: string;
    workId: string;
    current: number;
  }
): Promise<void> => {
  const { session, candidateEmail, workId, current } = input;
  await db.batch([
    admissionStatement(db, { userId: session.user_id, workId, current }),
    db
      .prepare(`INSERT INTO email_replacement_audit
      (id, user_id, session_id, operation, outcome, occurred_at_ms)
      VALUES (?, ?, ?, 'requestEmailReplacement', 'accepted', ?)`)
      // @effect-diagnostics-next-line cryptoRandomUUID:off
      .bind(crypto.randomUUID(), session.user_id, session.id, current),
    db
      .prepare(`INSERT INTO email_replacements
      (user_id, work_id, session_id, candidate_email, prior_email, prior_verified_at_ms,
       state, created_at_ms, expires_at_ms)
      SELECT v.user_id, ?, ?, ?, v.email_address, v.verified_at_ms, 'awaiting_delivery', ?, ?
      FROM verified_email_credentials AS v WHERE v.user_id = ? AND v.email_address <> ?
        AND EXISTS (SELECT 1 FROM email_replacement_limits AS l
          WHERE l.user_id = v.user_id AND l.last_work_id = ?)
        AND NOT EXISTS (SELECT 1 FROM verified_email_credentials WHERE email_address = ?)
        AND NOT EXISTS (SELECT 1 FROM email_replacements AS r WHERE r.user_id = v.user_id
          AND r.expires_at_ms > ? AND r.state IN ('awaiting_delivery', 'sending', 'awaiting_proof'))
      ON CONFLICT(user_id) DO UPDATE SET work_id = excluded.work_id,
        session_id = excluded.session_id, candidate_email = excluded.candidate_email,
        prior_email = excluded.prior_email, prior_verified_at_ms = excluded.prior_verified_at_ms,
        state = 'awaiting_delivery', created_at_ms = excluded.created_at_ms,
        expires_at_ms = excluded.expires_at_ms, wrong_attempts = 0,
        public_code = NULL, proof_digest = NULL, proof_expires_at_ms = NULL
      WHERE email_replacements.expires_at_ms <= ? OR email_replacements.state IN ('rejected', 'ambiguous')`)
      .bind(
        workId,
        session.id,
        candidateEmail,
        current,
        current + proofLifetimeMilliseconds,
        session.user_id,
        candidateEmail,
        workId,
        candidateEmail,
        current,
        current
      ),
    db
      .prepare(`INSERT INTO email_replacement_outbox (id, created_at_ms)
      SELECT work_id, ? FROM email_replacements WHERE work_id = ?`)
      .bind(current, workId),
  ]);
};

const admissionStatement = (
  db: D1Database,
  input: { userId: string; workId: string; current: number }
): D1PreparedStatement => {
  const { userId, workId, current } = input;
  return db
    .prepare(`INSERT INTO email_replacement_limits
    (user_id, window_started_at_ms, requests, last_work_id) VALUES (?, ?, 1, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      window_started_at_ms = CASE WHEN window_started_at_ms <= ? THEN excluded.window_started_at_ms ELSE window_started_at_ms END,
      requests = CASE WHEN window_started_at_ms <= ? THEN 1 ELSE requests + 1 END,
      last_work_id = excluded.last_work_id
    WHERE requests < 5 OR window_started_at_ms <= ?`)
    .bind(
      userId,
      current,
      workId,
      current - admissionWindowMilliseconds,
      current - admissionWindowMilliseconds,
      current - admissionWindowMilliseconds
    );
};

/** Consume a candidate-mailbox proof only while the initiating User still has fresh browser authority. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const completeEmailReplacement = async (
  request: globalThis.Request,
  db: D1Database
): Promise<Response> => {
  const input = await readProof(request, CompleteEmailReplacementPayload);
  if (Option.isNone(input)) {
    try {
      // @effect-diagnostics-next-line globalDate:off
      const current = Date.now();
      const session = await freshBrowserSession(request, db, current);
      if (Option.isSome(session)) await recordRejected(db, session.value, current);
    } catch {
      /* No successful credential transition can follow malformed input. */
    }
    return invalid();
  }
  try {
    // @effect-diagnostics-next-line globalDate:off
    const current = Date.now();
    const session = await freshBrowserSession(request, db, current);
    if (Option.isNone(session)) return fresh();
    if (!permitsFreshBrowserReplacement("complete")) return unavailable();
    return await Effect.runPromise(
      emailReplacementImplementations
        .complete({ payload: input.value }, browserReplacementCaller(session.value))
        .pipe(
          Effect.provideService(
            EmailReplacementMutation,
            replacementAdapter(db, session.value, current)
          ),
          Effect.match({ onSuccess: (result) => json(result, HTTP_OK), onFailure: invalid })
        )
    );
  } catch {
    return invalid();
  }
};

// @effect-diagnostics-next-line asyncFunction:off
const redeemProof = async (
  db: D1Database,
  input: {
    session: { readonly id: string; readonly user_id: string };
    combinedCode: string;
    current: number;
  }
): Promise<boolean> => {
  const { session, combinedCode, current } = input;
  const publicCode = combinedCode.slice(0, proofPublicLength);
  const raw = await db
    .prepare(`SELECT user_id, work_id, proof_digest FROM email_replacements
      WHERE user_id = ? AND session_id = ? AND state = 'awaiting_proof'
        AND public_code = ? AND proof_expires_at_ms > ? AND expires_at_ms > ?`)
    .bind(session.user_id, session.id, publicCode, current, current)
    .first();
  const proof = Schema.decodeUnknownOption(Proof)(raw);
  if (Option.isNone(proof)) {
    await recordRejected(db, session, current);
    return false;
  }
  if (!equalDigest(proof.value.proof_digest, await digest(combinedCode.slice(proofSecretOffset)))) {
    await rejectWrongProof(db, { workId: proof.value.work_id, session, current });
    return false;
  }
  // Both writes are in one D1 transaction. An expired session, superseded credential or
  // competing candidate UNIQUE claim leaves the existing mailbox authoritative.
  try {
    const committed = await commitReplacement(db, {
      workId: proof.value.work_id,
      userId: session.user_id,
      sessionId: session.id,
      publicCode,
      current,
    });
    if (committed.length === 3 && committed.every((result) => result.meta.changes === 1)) {
      return true;
    }
  } catch {
    /* A competing global mailbox claim or stale authority leaves the old credential. */
  }
  await recordRejected(db, session, current);
  return false;
};

type SessionSubject = { readonly id: string; readonly user_id: string };

class ReplacementDatabaseUnavailable extends Data.TaggedError("ReplacementDatabaseUnavailable")<{
  readonly operation: "request" | "complete";
}> {}

const replacementAdapter = (
  db: D1Database,
  session: SessionSubject,
  current: number
): EmailReplacementMutationService => ({
  request: (subject, candidateEmail) => {
    if (subject !== session.user_id) return Effect.die("Email replacement subject mismatch");
    // @effect-diagnostics-next-line cryptoRandomUUID:off
    const workId = crypto.randomUUID();
    return Effect.tryPromise({
      try: () => startProof(db, { session, candidateEmail, workId, current }),
      catch: () => new ReplacementDatabaseUnavailable({ operation: "request" }),
    }).pipe(Effect.orDie);
  },
  complete: (subject, combinedCode) =>
    subject === session.user_id
      ? Effect.tryPromise({
          try: () => redeemProof(db, { session, combinedCode, current }),
          catch: () => new ReplacementDatabaseUnavailable({ operation: "complete" }),
        }).pipe(Effect.orDie)
      : Effect.die("Email replacement subject mismatch"),
});

// @effect-diagnostics-next-line asyncFunction:off
const recordRejected = async (
  db: D1Database,
  session: SessionSubject,
  current: number
): Promise<void> => {
  // @effect-diagnostics-next-line cryptoRandomUUID:off
  const auditId = crypto.randomUUID();
  await db
    .prepare(`INSERT INTO email_replacement_audit
    (id, user_id, session_id, operation, outcome, occurred_at_ms)
    VALUES (?, ?, ?, 'completeEmailReplacement', 'rejected', ?)`)
    .bind(auditId, session.user_id, session.id, current)
    .run();
};

// @effect-diagnostics-next-line asyncFunction:off
const rejectWrongProof = async (
  db: D1Database,
  input: { workId: string; session: SessionSubject; current: number }
): Promise<void> => {
  const { workId, session, current } = input;
  await db.batch([
    db
      .prepare(`UPDATE email_replacements SET wrong_attempts = wrong_attempts + 1,
    state = CASE WHEN wrong_attempts + 1 >= 5 THEN 'rejected' ELSE state END,
    proof_digest = CASE WHEN wrong_attempts + 1 >= 5 THEN NULL ELSE proof_digest END,
    public_code = CASE WHEN wrong_attempts + 1 >= 5 THEN NULL ELSE public_code END,
    proof_expires_at_ms = CASE WHEN wrong_attempts + 1 >= 5 THEN NULL ELSE proof_expires_at_ms END
    WHERE work_id = ? AND state = 'awaiting_proof' AND wrong_attempts < 5`)
      .bind(workId),
    db
      .prepare(`INSERT INTO email_replacement_audit
      (id, user_id, session_id, operation, outcome, occurred_at_ms)
      VALUES (?, ?, ?, 'completeEmailReplacement', 'rejected', ?)`)
      // @effect-diagnostics-next-line cryptoRandomUUID:off
      .bind(crypto.randomUUID(), session.user_id, session.id, current),
  ]);
};

// @effect-diagnostics-next-line asyncFunction:off
const commitReplacement = async (
  db: D1Database,
  input: {
    workId: string;
    userId: string;
    sessionId: string;
    publicCode: string;
    current: number;
  }
): Promise<D1Result[]> => {
  const { workId, userId, sessionId, publicCode, current } = input;
  return db.batch([
    db
      .prepare(`UPDATE verified_email_credentials SET email_address = (
          SELECT candidate_email FROM email_replacements WHERE work_id = ?), verified_at_ms = ?
        WHERE user_id = ? AND EXISTS (SELECT 1 FROM email_replacements AS r
          JOIN web_sessions AS s ON s.id = r.session_id AND s.user_id = r.user_id
          WHERE r.work_id = ? AND r.user_id = ? AND r.session_id = ?
            AND r.state = 'awaiting_proof' AND r.public_code = ?
            AND r.proof_expires_at_ms > ? AND r.expires_at_ms > ?
            AND s.revoked_at_ms IS NULL AND s.fresh_until_ms > ?
            AND s.idle_expires_at_ms > ? AND s.hard_expires_at_ms > ?
            AND verified_email_credentials.email_address = r.prior_email
            AND verified_email_credentials.verified_at_ms = r.prior_verified_at_ms)`)
      .bind(
        workId,
        current,
        userId,
        workId,
        userId,
        sessionId,
        publicCode,
        current,
        current,
        current,
        current,
        current
      ),
    db.prepare(`DELETE FROM email_replacements WHERE work_id = ? AND changes() = 1`).bind(workId),
    db
      .prepare(`INSERT INTO email_replacement_audit
        (id, user_id, session_id, operation, outcome, occurred_at_ms)
        SELECT ?, ?, ?, 'completeEmailReplacement', 'replaced', ? WHERE changes() = 1`)
      // @effect-diagnostics-next-line cryptoRandomUUID:off
      .bind(crypto.randomUUID(), userId, sessionId, current),
  ]);
};
