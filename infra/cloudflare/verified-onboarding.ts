import { EmailAddress, EmailVerificationCode } from "@fidy/server/client";
import {
  canRedeemOnboardingProof,
  maximumOnboardingProofFailures,
  verifiedOnboardingContext,
} from "@fidy/server/onboarding-verification";
import { Option, Schema } from "effect";

const Payload = Schema.Struct({ combinedCode: EmailVerificationCode });
const ProofRow = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  exchange_id: Schema.String.check(Schema.isUUID()),
  email_address: EmailAddress,
  proof_digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
  expires_at_ms: Schema.Finite,
  proof_expires_at_ms: Schema.Finite,
  state: Schema.Literals([
    "awaiting_delivery",
    "sending",
    "awaiting_proof",
    "rejected",
    "ambiguous",
  ]),
});
type Enrollment = typeof ProofRow.Type;
const maximumBodyBytes = 512;
const maximumBodyChunks = 32;
const digestLength = 32;
const recoverySymbols = 25;
const publicCodeLength = 9;
const proofOffset = 10;
const invalid = (): Response =>
  Response.json(
    {
      error: {
        code: "verification_invalid",
        message: "El código no es válido. Revisa el correo o solicita uno nuevo.",
      },
    },
    { status: 400, headers: { "cache-control": "no-store" } }
  );
const unavailable = (): Response =>
  Response.json(
    { status: "unavailable" },
    { status: 503, headers: { "cache-control": "no-store" } }
  );
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const randomCode = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(recoverySymbols));
  const symbols = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
  return symbols.match(/.{1,5}/gu)?.join("-") ?? "";
};
const digest = (text: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((bytes) => new Uint8Array(bytes));
const equalDigest = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== digestLength || right.length !== digestLength) return false;
  let difference = 0;
  for (let index = 0; index < digestLength; index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
};

const collectBody = (
  reader: ReadableStreamDefaultReader<unknown>,
  chunks: Array<Uint8Array>,
  length: number
): Promise<Option.Option<string>> =>
  reader.read().then((part) => {
    if (part.done) {
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return Option.some(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    }
    const chunk: unknown = part.value;
    if (
      !(chunk instanceof Uint8Array) ||
      chunks.length >= maximumBodyChunks ||
      length + chunk.byteLength > maximumBodyBytes
    ) {
      return Option.none();
    }
    chunks.push(chunk);
    return collectBody(reader, chunks, length + chunk.byteLength);
  });

// @effect-diagnostics-next-line asyncFunction:off
const readBody = async (request: Request): Promise<Option.Option<string>> => {
  if (request.body === null) return Option.none();
  const reader = request.body.getReader();
  try {
    return await collectBody(reader, [], 0);
  } catch {
    return Option.none();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

// @effect-diagnostics-next-line asyncFunction:off
const readCode = async (request: Request): Promise<Option.Option<string>> => {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" ||
    Number(request.headers.get("content-length")) > maximumBodyBytes
  ) {
    return Option.none();
  }
  const text = await readBody(request);
  if (Option.isNone(text)) return Option.none();
  try {
    const input: unknown = JSON.parse(text.value);
    return Option.map(Schema.decodeUnknownOption(Payload)(input), (value) => value.combinedCode);
  } catch {
    return Option.none();
  }
};

// @effect-diagnostics-next-line asyncFunction:off
const createUser = async (db: D1Database, row: Enrollment, now: number): Promise<Response> => {
  // @effect-diagnostics-next-line cryptoRandomUUID:off
  const userId = crypto.randomUUID();
  const recoveryCode = randomCode();
  const recoveryDigest = await digest(recoveryCode);
  const context = verifiedOnboardingContext(now);
  await db.batch([
    db
      .prepare(`INSERT INTO users (id, service_market, locale, time_zone, created_at_ms)
      VALUES (?, ?, ?, ?, ?)`)
      .bind(userId, context.serviceMarket, context.locale, context.timeZone, now),
    db
      .prepare(`INSERT INTO whatsapp_identities (user_id, portfolio_id, bsuid, verified_at_ms)
      SELECT ?, portfolio_id, bsuid, ? FROM pending_consent_exchanges WHERE id = ? AND state = 'accepted'`)
      .bind(userId, now, row.exchange_id),
    db
      .prepare(`INSERT INTO verified_email_credentials (user_id, email_address, verified_at_ms)
      VALUES (?, ?, ?)`)
      .bind(userId, row.email_address, now),
    db
      .prepare(`INSERT INTO onboarding_consent_records
      (id, user_id, disclosure_json, disclosure_message_id, decision_message_id, decision_received_at_ms, accepted_at_ms)
      SELECT d.exchange_id, ?, d.disclosure_json, d.disclosure_message_id,
        d.decision_message_id, d.received_at_ms, ? FROM pending_consent_decisions AS d
      WHERE d.exchange_id = ? AND d.decision = 'accepted'`)
      .bind(userId, now, row.exchange_id),
    db
      .prepare(`INSERT INTO trial_periods (user_id, started_at_ms, ends_at_ms)
      VALUES (?, ?, ?)`)
      .bind(userId, context.trialPeriod.startedAtMs, context.trialPeriod.endsAtMs),
    db
      .prepare(`INSERT INTO backup_recovery_credentials (user_id, code_digest, created_at_ms)
      VALUES (?, ?, ?)`)
      .bind(userId, recoveryDigest, now),
    db
      .prepare(`INSERT INTO completed_email_enrollments (enrollment_id, user_id, completed_at_ms)
      VALUES (?, ?, ?)`)
      .bind(row.id, userId, now),
  ]);
  return Response.json(
    { status: "created", backupRecoveryCode: recoveryCode },
    { headers: { "cache-control": "no-store" } }
  );
};

/** Redeem a mailbox proof once; all stable identity and evidence commits or none do. */
// @effect-diagnostics-next-line missingPipeableSignature:off asyncFunction:off
export const verifyOnboarding = async (request: Request, db: D1Database): Promise<Response> => {
  const code = await readCode(request);
  if (Option.isNone(code)) return invalid();
  try {
    const raw = await db
      .prepare(`SELECT id, exchange_id, email_address, proof_digest,
      expires_at_ms, proof_expires_at_ms, state FROM pending_email_enrollments
      WHERE public_code = ?`)
      .bind(code.value.slice(0, publicCodeLength))
      .first();
    if (raw === null) return invalid();
    const row = Schema.decodeUnknownOption(ProofRow)(raw);
    if (Option.isNone(row)) return unavailable();
    // @effect-diagnostics-next-line globalDate:off
    const now = Date.now();
    if (
      !canRedeemOnboardingProof({
        state: row.value.state,
        expiresAtMs: row.value.expires_at_ms,
        proofExpiresAtMs: row.value.proof_expires_at_ms,
        nowMs: now,
      })
    ) {
      return invalid();
    }
    if (
      !equalDigest(
        Uint8Array.from(row.value.proof_digest),
        await digest(code.value.slice(proofOffset))
      )
    ) {
      await db
        .prepare(`UPDATE pending_email_enrollments SET
        wrong_proof_attempts = wrong_proof_attempts + 1,
        state = CASE WHEN wrong_proof_attempts + 1 >= ? THEN 'rejected' ELSE state END,
        proof_digest = CASE WHEN wrong_proof_attempts + 1 >= ? THEN NULL ELSE proof_digest END,
        public_code = CASE WHEN wrong_proof_attempts + 1 >= ? THEN NULL ELSE public_code END,
        proof_expires_at_ms = CASE WHEN wrong_proof_attempts + 1 >= ? THEN NULL ELSE proof_expires_at_ms END
        WHERE id = ? AND state = 'awaiting_proof' AND wrong_proof_attempts < ?`)
        .bind(
          maximumOnboardingProofFailures,
          maximumOnboardingProofFailures,
          maximumOnboardingProofFailures,
          maximumOnboardingProofFailures,
          row.value.id,
          maximumOnboardingProofFailures
        )
        .run();
      return invalid();
    }
    return await createUser(db, row.value, now);
  } catch {
    // D1's constraints and final proof trigger reject races, replay, and conflicting ownership.
    return invalid();
  }
};
