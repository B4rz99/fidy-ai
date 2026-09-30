import { EmailAddress, EmailVerificationCode } from "@fidy/server/client";

import { BrowserLoginPairingId } from "../../../src/core/browser-login/contract";
import { decidePendingBrowserLoginProof } from "../../../src/core/browser-login/operations";
import { Clock, Crypto, DateTime, Effect, Option, PlatformError, Schema } from "effect";

import { RequestBodyPolicy, readBoundedRequestBody } from "../../http/request-body";

const Start = Schema.Struct({
  pairingId: BrowserLoginPairingId,
  privateVerifier: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
  email: EmailAddress,
});

const Complete = Schema.Struct({
  pairingId: BrowserLoginPairingId,
  privateVerifier: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
  combinedCode: EmailVerificationCode,
});

const Pairing = Schema.Struct({
  state: Schema.Literals(["pending_approval", "ready", "consumed", "invalidated"]),
  verifier_digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
  wrong_attempts: Schema.Int,
  expires_at_ms: Schema.Finite,
});

const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 512,
  deadlineMilliseconds: 2000,
});

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

const emailCooldownMilliseconds = 60000;

const publicCodeLength = 9;

const secretOffset = 10;

const invalid = (): Response =>
  Response.json(
    {
      error: {
        code: "authentication_invalid",
        message: "El código no es válido. Inicia de nuevo o solicita otro correo.",
      },
    },
    { status: 400, headers: { "cache-control": "no-store" } }
  );

const pending = (): Response =>
  Response.json(
    { status: "pending", retryAfterSeconds: 60 },
    { status: 202, headers: { "cache-control": "no-store" } }
  );

const unavailable = (): Response =>
  Response.json(
    { status: "unavailable" },
    { status: 503, headers: { "cache-control": "no-store" } }
  );

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

const readProof = <A>(request: Request, schema: Schema.Codec<A>): Promise<Option.Option<A>> => {
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

const checkPairing = (
  db: D1Database,
  pairingId: string,
  verifier: string
): Promise<Option.Option<number>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const raw = yield* attempt(() =>
        db
          .prepare(`SELECT state, verifier_digest, wrong_attempts, expires_at_ms
    FROM browser_login_pairings WHERE id = ?`)
          .bind(pairingId)
          .first()
      );
      if (raw === null) return Option.none();
      const pairing = Schema.decodeUnknownOption(Pairing)(raw);
      if (Option.isNone(pairing)) return Option.none();
      const current = yield* Clock.currentTimeMillis;
      const decision = decidePendingBrowserLoginProof({
        lifecycle: pairing.value.state,
        verifierMatches: equalDigest(
          pairing.value.verifier_digest,
          yield* attempt(() => digest(verifier))
        ),
        wrongVerifierAttempts: pairing.value.wrong_attempts,
        expiresAt: DateTime.makeUnsafe(pairing.value.expires_at_ms),
        attemptedAt: DateTime.makeUnsafe(current),
      });
      if (decision._tag === "WrongVerifier") {
        yield* attempt(() =>
          db
            .prepare(`UPDATE browser_login_pairings SET wrong_attempts = ?, state = ?
      WHERE id = ? AND state = 'pending_approval' AND wrong_attempts = ? AND expires_at_ms > ?`)
            .bind(
              decision.wrongVerifierAttempts,
              decision.lifecycle,
              pairingId,
              pairing.value.wrong_attempts,
              current
            )
            .run()
        );
      }
      return decision._tag === "Accept" ? Option.some(pairing.value.expires_at_ms) : Option.none();
    })
  );

const rejectWrongEmailProof = (db: D1Database, workId: string): Promise<void> =>
  Effect.runPromise(
    attempt(() =>
      db
        .prepare(`UPDATE browser_pairing_email_proofs SET wrong_attempts = wrong_attempts + 1,
    state = CASE WHEN wrong_attempts + 1 >= 5 THEN 'rejected' ELSE state END,
    proof_digest = CASE WHEN wrong_attempts + 1 >= 5 THEN NULL ELSE proof_digest END,
    public_code = CASE WHEN wrong_attempts + 1 >= 5 THEN NULL ELSE public_code END,
    proof_expires_at_ms = CASE WHEN wrong_attempts + 1 >= 5 THEN NULL ELSE proof_expires_at_ms END
    WHERE work_id = ? AND state = 'awaiting_proof' AND wrong_attempts < 5`)
        .bind(workId)
        .run()
    ).pipe(Effect.asVoid)
  );

const approveEmailPairing = (
  db: D1Database,
  input: {
    pairingId: string;
    workId: string;
    publicCode: string;
    current: number;
  }
): Promise<boolean> => {
  const { pairingId, workId, publicCode, current } = input;
  return Effect.runPromise(
    Effect.map(
      attempt(() =>
        db.batch([
          db
            .prepare(`UPDATE browser_login_pairings SET state = 'ready', user_id = (
      SELECT e.user_id FROM browser_pairing_email_proofs AS e
      JOIN verified_email_credentials AS v ON v.user_id = e.user_id
        AND v.email_address = e.email_address AND v.verified_at_ms = e.credential_verified_at_ms
      WHERE e.work_id = ? AND e.state = 'awaiting_proof' AND e.public_code = ?
        AND e.proof_expires_at_ms > ? AND e.expires_at_ms > ?)
      WHERE id = ? AND state = 'pending_approval' AND expires_at_ms > ?
        AND EXISTS (SELECT 1 FROM browser_pairing_email_proofs AS e
          JOIN verified_email_credentials AS v ON v.user_id = e.user_id
            AND v.email_address = e.email_address AND v.verified_at_ms = e.credential_verified_at_ms
          WHERE e.work_id = ? AND e.state = 'awaiting_proof' AND e.public_code = ?
            AND e.proof_expires_at_ms > ? AND e.expires_at_ms > ?)`)
            .bind(
              workId,
              publicCode,
              current,
              current,
              pairingId,
              current,
              workId,
              publicCode,
              current,
              current
            ),
          db
            .prepare(`UPDATE browser_pairing_email_proofs SET state = 'approved',
      proof_digest = NULL, public_code = NULL, proof_expires_at_ms = NULL
      WHERE work_id = ? AND state = 'awaiting_proof' AND changes() = 1`)
            .bind(workId),
        ])
      ),
      (bound) => bound[0]?.meta.changes === 1 && bound[1]?.meta.changes === 1
    )
  );
};

const EmailProofRow = Schema.Struct({
  proof_digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
  wrong_attempts: Schema.Int,
  work_id: Schema.String.check(Schema.isUUID()),
});

export const internals = {
  Start,
  Complete,
  Pairing,
  policy,
  workerCrypto,
  newId,
  digestLength,
  emailCooldownMilliseconds,
  publicCodeLength,
  secretOffset,
  invalid,
  pending,
  unavailable,
  digest,
  equalDigest,
  attempt,
  readProof,
  checkPairing,
  rejectWrongEmailProof,
  approveEmailPairing,
  EmailProofRow,
};
