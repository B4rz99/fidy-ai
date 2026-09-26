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
import { Clock, Crypto, Data, Effect, Exit, Option, PlatformError, Schema } from "effect";
import { freshBrowserSession } from "./browser-login";
import { RequestBodyPolicy, readBoundedRequestBody } from "../http/request-body";

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
const newId = (): string => Effect.runSync(workerCrypto.randomUUIDv4.pipe(Effect.orDie));
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

const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, void> =>
  Effect.tryPromise({ try: run, catch: () => undefined });
const readProof = <A, Encoded>(
  request: globalThis.Request,
  schema: Schema.Codec<A, Encoded>
): Promise<Option.Option<A>> => {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    return Promise.resolve(Option.none());
  }
  return Effect.runPromise(
    Effect.gen(function* () {
      const bytes = yield* readBoundedRequestBody(request, policy);
      const text = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: () => undefined,
      });
      return Option.some(yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text));
    }).pipe(Effect.orElseSucceed(() => Option.none<A>()))
  );
};

/** Start a candidate-mailbox proof for a fresh WebSession, without disclosing collisions. */
export const requestEmailReplacement = ({
  request,
  db,
  onAccepted,
}: {
  request: globalThis.Request;
  db: D1Database;
  onAccepted: (id: string) => void;
}): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const input = yield* attempt(() => readProof(request, RequestEmailReplacementPayload));
      if (Option.isNone(input)) return invalid();
      {
        const current = yield* Clock.currentTimeMillis;
        const session = yield* attempt(() => freshBrowserSession({ request, db, current }));
        if (Option.isNone(session)) return fresh();
        if (!permitsFreshBrowserReplacement("request")) return unavailable();
        const result = yield* emailReplacementImplementations
          .request({ payload: input.value }, browserReplacementCaller(session.value))
          .pipe(
            Effect.provideService(
              EmailReplacementMutation,
              replacementAdapter({ db, session: session.value, current, onAccepted })
            )
          );
        return json(result, HTTP_OK);
      }
    }).pipe(Effect.catchCause(() => Effect.succeed(unavailable())))
  );

const startProof = (
  db: D1Database,
  input: {
    session: SessionSubject;
    candidateEmail: string;
    workId: string;
    current: number;
  }
): Promise<void> => {
  const { session, candidateEmail, workId, current } = input;
  return Effect.runPromise(
    attempt(() =>
      db.batch([
        admissionStatement(db, { userId: session.user_id, workId, current }),
        db
          .prepare(`INSERT INTO email_replacement_audit
      (id, user_id, session_id, operation, outcome, occurred_at_ms)
      VALUES (?, ?, ?, 'requestEmailReplacement', 'accepted', ?)`)
          .bind(newId(), session.user_id, session.id, current),
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
      ])
    ).pipe(Effect.asVoid)
  );
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

const recordMalformedInput = (
  request: globalThis.Request,
  db: D1Database
): Effect.Effect<void, void> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const session = yield* attempt(() => freshBrowserSession({ request, db, current }));
    if (Option.isSome(session)) {
      yield* attempt(() => recordRejected(db, session.value, current));
    }
  });

/** Consume a candidate-mailbox proof only while the initiating User still has fresh browser authority. */
export const completeEmailReplacement = ({
  request,
  db,
}: {
  request: globalThis.Request;
  db: D1Database;
}): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const input = yield* attempt(() => readProof(request, CompleteEmailReplacementPayload));
      if (Option.isNone(input)) {
        // No successful credential transition can follow malformed input, even if audit fails.
        yield* Effect.exit(recordMalformedInput(request, db));
        return invalid();
      }
      {
        const current = yield* Clock.currentTimeMillis;
        const session = yield* attempt(() => freshBrowserSession({ request, db, current }));
        if (Option.isNone(session)) return fresh();
        if (!permitsFreshBrowserReplacement("complete")) return unavailable();
        return yield* emailReplacementImplementations
          .complete({ payload: input.value }, browserReplacementCaller(session.value))
          .pipe(
            Effect.provideService(
              EmailReplacementMutation,
              replacementAdapter({
                db,
                session: session.value,
                current,
                onAccepted: () => undefined,
              })
            ),
            Effect.match({ onSuccess: (result) => json(result, HTTP_OK), onFailure: invalid })
          );
      }
    }).pipe(Effect.catchCause(() => Effect.succeed(invalid())))
  );

const redeemProof = (
  db: D1Database,
  input: {
    session: { readonly id: string; readonly user_id: string };
    combinedCode: string;
    current: number;
  }
): Promise<boolean> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { session, combinedCode, current } = input;
      const publicCode = combinedCode.slice(0, proofPublicLength);
      const raw = yield* attempt(() =>
        db
          .prepare(`SELECT user_id, work_id, proof_digest FROM email_replacements
      WHERE user_id = ? AND session_id = ? AND state = 'awaiting_proof'
        AND public_code = ? AND proof_expires_at_ms > ? AND expires_at_ms > ?`)
          .bind(session.user_id, session.id, publicCode, current, current)
          .first()
      );
      const proof = Schema.decodeUnknownOption(Proof)(raw);
      if (Option.isNone(proof)) {
        yield* attempt(() => recordRejected(db, session, current));
        return false;
      }
      if (
        !equalDigest(
          proof.value.proof_digest,
          yield* attempt(() => digest(combinedCode.slice(proofSecretOffset)))
        )
      ) {
        yield* attempt(() =>
          rejectWrongProof(db, { workId: proof.value.work_id, session, current })
        );
        return false;
      }
      // Both writes are in one D1 transaction. An expired session, superseded credential or
      // competing candidate UNIQUE claim leaves the existing mailbox authoritative.
      const committed = yield* Effect.exit(
        attempt(() =>
          commitReplacement(db, {
            workId: proof.value.work_id,
            userId: session.user_id,
            sessionId: session.id,
            publicCode,
            current,
          })
        )
      );
      if (
        Exit.isSuccess(committed) &&
        committed.value.length === 3 &&
        committed.value.every((result) => result.meta.changes === 1)
      ) {
        return true;
      }
      yield* attempt(() => recordRejected(db, session, current));
      return false;
    })
  );

type SessionSubject = { readonly id: string; readonly user_id: string };

class ReplacementDatabaseUnavailable extends Data.TaggedError("ReplacementDatabaseUnavailable")<{
  readonly operation: "request" | "complete";
}> {}

const replacementAdapter = ({
  db,
  session,
  current,
  onAccepted,
}: {
  db: D1Database;
  session: SessionSubject;
  current: number;
  onAccepted: (id: string) => void;
}): EmailReplacementMutationService => ({
  request: (subject, candidateEmail) => {
    if (subject !== session.user_id) return Effect.die("Email replacement subject mismatch");
    const workId = newId();
    return Effect.tryPromise({
      try: () => startProof(db, { session, candidateEmail, workId, current }),
      catch: () => new ReplacementDatabaseUnavailable({ operation: "request" }),
    }).pipe(
      Effect.tap(() => Effect.sync(() => onAccepted(workId))),
      Effect.orDie
    );
  },
  complete: (subject, combinedCode) =>
    subject === session.user_id
      ? Effect.tryPromise({
          try: () => redeemProof(db, { session, combinedCode, current }),
          catch: () => new ReplacementDatabaseUnavailable({ operation: "complete" }),
        }).pipe(Effect.orDie)
      : Effect.die("Email replacement subject mismatch"),
});

const recordRejected = (
  db: D1Database,
  session: SessionSubject,
  current: number
): Promise<void> => {
  const auditId = newId();
  return Effect.runPromise(
    attempt(() =>
      db
        .prepare(`INSERT INTO email_replacement_audit
    (id, user_id, session_id, operation, outcome, occurred_at_ms)
    VALUES (?, ?, ?, 'completeEmailReplacement', 'rejected', ?)`)
        .bind(auditId, session.user_id, session.id, current)
        .run()
    ).pipe(Effect.asVoid)
  );
};

const rejectWrongProof = (
  db: D1Database,
  input: { workId: string; session: SessionSubject; current: number }
): Promise<void> => {
  const { workId, session, current } = input;
  return Effect.runPromise(
    attempt(() =>
      db.batch([
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
          .bind(newId(), session.user_id, session.id, current),
      ])
    ).pipe(Effect.asVoid)
  );
};

const commitReplacement = (
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
  return Effect.runPromise(
    attempt(() =>
      db.batch([
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
        db
          .prepare(`DELETE FROM email_replacements WHERE work_id = ? AND changes() = 1`)
          .bind(workId),
        db
          .prepare(`INSERT INTO email_replacement_audit
        (id, user_id, session_id, operation, outcome, occurred_at_ms)
        SELECT ?, ?, ?, 'completeEmailReplacement', 'replaced', ? WHERE changes() = 1`)
          .bind(newId(), userId, sessionId, current),
      ])
    )
  );
};
