import { EmailAddress, EmailVerificationCode } from "@fidy/server/client";
import {
  BrowserLoginPairingId,
  decidePendingBrowserLoginProof,
} from "@fidy/server/identity-runtime";
import { DateTime, Effect, Option, Schema } from "effect";
import { RequestBodyPolicy, readBoundedRequestBody } from "./request-body";

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
  deadlineMilliseconds: 2_000,
});
const digestLength = 32;
const emailCooldownMilliseconds = 60_000;
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
  for (let index = 0; index < digestLength; index++)
    {difference |= (left[index] ?? 0) ^ (right[index] ?? 0);}
  return difference === 0;
};
// @effect-diagnostics-next-line asyncFunction:off
const readProof = async <A>(
  request: Request,
  schema: Schema.Codec<A>
): Promise<Option.Option<A>> => {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    return Option.none();
  }
  try {
    const bytes = await Effect.runPromise(readBoundedRequestBody(request, policy));
    const candidate: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return Schema.decodeUnknownOption(schema)(candidate);
  } catch {
    return Option.none();
  }
};

// @effect-diagnostics-next-line asyncFunction:off
const checkPairing = async (
  db: D1Database,
  pairingId: string,
  verifier: string
): Promise<Option.Option<number>> => {
  const raw = await db
    .prepare(`SELECT state, verifier_digest, wrong_attempts, expires_at_ms
    FROM browser_login_pairings WHERE id = ?`)
    .bind(pairingId)
    .first();
  if (raw === null) return Option.none();
  const pairing = Schema.decodeUnknownOption(Pairing)(raw);
  if (Option.isNone(pairing)) return Option.none();
  // @effect-diagnostics-next-line globalDate:off
  const current = Date.now();
  const decision = decidePendingBrowserLoginProof({
    lifecycle: pairing.value.state,
    verifierMatches: equalDigest(pairing.value.verifier_digest, await digest(verifier)),
    wrongVerifierAttempts: pairing.value.wrong_attempts,
    expiresAt: DateTime.makeUnsafe(pairing.value.expires_at_ms),
    attemptedAt: DateTime.makeUnsafe(current),
  });
  if (decision._tag === "WrongVerifier") {
    await db
      .prepare(`UPDATE browser_login_pairings SET wrong_attempts = ?, state = ?
      WHERE id = ? AND state = 'pending_approval' AND wrong_attempts = ? AND expires_at_ms > ?`)
      .bind(
        decision.wrongVerifierAttempts,
        decision.lifecycle,
        pairingId,
        pairing.value.wrong_attempts,
        current
      )
      .run();
  }
  return decision._tag === "Accept" ? Option.some(pairing.value.expires_at_ms) : Option.none();
};

/** Start one bounded email proof only after the browser proves ownership of a pending pairing. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const startBrowserPairingEmail = async (
  request: Request,
  db: D1Database
): Promise<Response> => {
  const proof = await readProof(request, Start);
  if (Option.isNone(proof)) return invalid();
  try {
    const expiresAt = await checkPairing(db, proof.value.pairingId, proof.value.privateVerifier);
    if (Option.isNone(expiresAt)) return invalid();
    // @effect-diagnostics-next-line globalDate:off
    const current = Date.now();
    // @effect-diagnostics-next-line cryptoRandomUUID:off
    const workId = crypto.randomUUID();
    // The proof generation and outbox identity commit together; an unknown mailbox has no effect.
    await db.batch([
      db
        .prepare(`INSERT INTO browser_pairing_email_proofs
        (pairing_id, work_id, user_id, email_address, credential_verified_at_ms,
         state, expires_at_ms, generation, last_requested_at_ms)
        SELECT p.id, ?, v.user_id, v.email_address, v.verified_at_ms,
          'awaiting_delivery', p.expires_at_ms, 1, ?
        FROM browser_login_pairings AS p JOIN verified_email_credentials AS v ON v.email_address = ?
        WHERE p.id = ? AND p.state = 'pending_approval' AND p.expires_at_ms > ?
          AND p.expires_at_ms = ? AND p.wrong_attempts < 5
        ON CONFLICT(pairing_id) DO UPDATE SET work_id = excluded.work_id,
          email_address = excluded.email_address,
          user_id = excluded.user_id,
          credential_verified_at_ms = excluded.credential_verified_at_ms,
          state = 'awaiting_delivery', generation = generation + 1,
          last_requested_at_ms = excluded.last_requested_at_ms,
          public_code = NULL, proof_digest = NULL, proof_expires_at_ms = NULL,
          wrong_attempts = 0
        WHERE browser_pairing_email_proofs.state NOT IN ('approved', 'sending')
          AND browser_pairing_email_proofs.generation < 5
          AND browser_pairing_email_proofs.last_requested_at_ms <= ?`)
        .bind(
          workId,
          current,
          proof.value.email,
          proof.value.pairingId,
          current,
          expiresAt.value,
          current - emailCooldownMilliseconds
        ),
      db
        .prepare(`INSERT INTO browser_pairing_email_outbox (id, created_at_ms)
        SELECT work_id, ? FROM browser_pairing_email_proofs
        WHERE work_id = ? AND state = 'awaiting_delivery'`)
        .bind(current, workId),
    ]);
    return pending();
  } catch {
    return unavailable();
  }
};

// @effect-diagnostics-next-line asyncFunction:off
const rejectWrongEmailProof = async (db: D1Database, workId: string): Promise<void> => {
  await db
    .prepare(`UPDATE browser_pairing_email_proofs SET wrong_attempts = wrong_attempts + 1,
    state = CASE WHEN wrong_attempts + 1 >= 5 THEN 'rejected' ELSE state END,
    proof_digest = CASE WHEN wrong_attempts + 1 >= 5 THEN NULL ELSE proof_digest END,
    public_code = CASE WHEN wrong_attempts + 1 >= 5 THEN NULL ELSE public_code END,
    proof_expires_at_ms = CASE WHEN wrong_attempts + 1 >= 5 THEN NULL ELSE proof_expires_at_ms END
    WHERE work_id = ? AND state = 'awaiting_proof' AND wrong_attempts < 5`)
    .bind(workId)
    .run();
};

// @effect-diagnostics-next-line asyncFunction:off
const approveEmailPairing = async (
  db: D1Database,
  input: { pairingId: string; workId: string; publicCode: string; current: number }
): Promise<boolean> => {
  const { pairingId, workId, publicCode, current } = input;
  const bound = await db.batch([
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
  ]);
  return bound[0]?.meta.changes === 1 && bound[1]?.meta.changes === 1;
};

/** Consume a mailbox proof and bind only its credential's stable User to the same browser challenge. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const completeBrowserPairingEmail = async (
  request: Request,
  db: D1Database
): Promise<Response> => {
  const proof = await readProof(request, Complete);
  if (Option.isNone(proof)) return invalid();
  try {
    const expiresAt = await checkPairing(db, proof.value.pairingId, proof.value.privateVerifier);
    if (Option.isNone(expiresAt)) return invalid();
    // @effect-diagnostics-next-line globalDate:off
    const current = Date.now();
    const publicCode = proof.value.combinedCode.slice(0, publicCodeLength);
    const raw = await db
      .prepare(`SELECT proof_digest, wrong_attempts, work_id
      FROM browser_pairing_email_proofs WHERE pairing_id = ? AND public_code = ?
        AND state = 'awaiting_proof' AND proof_expires_at_ms > ? AND expires_at_ms > ?`)
      .bind(proof.value.pairingId, publicCode, current, current)
      .first();
    if (raw === null) return invalid();
    const row = Schema.decodeUnknownOption(
      Schema.Struct({
        proof_digest: Schema.Array(
          Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))
        ),
        wrong_attempts: Schema.Int,
        work_id: Schema.String.check(Schema.isUUID()),
      })
    )(raw);
    if (Option.isNone(row)) return unavailable();
    if (
      !equalDigest(
        row.value.proof_digest,
        await digest(proof.value.combinedCode.slice(secretOffset))
      )
    ) {
      await rejectWrongEmailProof(db, row.value.work_id);
      return invalid();
    }
    if (
      !(await approveEmailPairing(db, {
        pairingId: proof.value.pairingId,
        workId: row.value.work_id,
        publicCode,
        current,
      }))
    )
      {return invalid();}
    return Response.json(
      { status: "pairing_approved" },
      { headers: { "cache-control": "no-store" } }
    );
  } catch {
    return unavailable();
  }
};
