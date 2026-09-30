import type { PreparedOnboardingCredential } from "../contract";

import { maximumOnboardingProofFailures } from "@fidy/server/email-authentication-policy";

import { EmailAddress } from "@fidy/server/client";

import { Schema } from "effect";

const digestLength = 32;

export const OnboardingProofRow = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  exchange_id: Schema.String.check(Schema.isUUID()),
  email_address: EmailAddress,
  proof_digest: Schema.Array(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))
  ).check(Schema.isLengthBetween(digestLength, digestLength)),
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

export const onboardingProofDigest = (text: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((bytes) => new Uint8Array(bytes));

export const onboardingDigestMatches = (
  input: Readonly<{ stored: ReadonlyArray<number>; candidate: Uint8Array }>
): boolean => {
  if (input.stored.length !== digestLength || input.candidate.length !== digestLength) return false;
  let difference = 0;
  for (let index = 0; index < digestLength; index++) {
    difference |= (input.stored[index] ?? 0) ^ (input.candidate[index] ?? 0);
  }
  return difference === 0;
};

export const recordWrongOnboardingProof = (
  input: Readonly<{ db: D1Database; enrollmentId: string }>
): Promise<D1Result> =>
  input.db
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
      input.enrollmentId,
      maximumOnboardingProofFailures
    )
    .run();

export const preparedOnboardingCredential = (
  input: Readonly<{ db: D1Database; row: typeof OnboardingProofRow.Type }>
): PreparedOnboardingCredential => {
  const { row } = input;
  return {
    enrollmentId: row.id,
    pendingConsentExchangeId: row.exchange_id,
    statements: ({ userId, verifiedAtMs }) => [
      input.db
        .prepare(`INSERT INTO verified_email_credentials (user_id, email_address, verified_at_ms)
          SELECT ?, email_address, ? FROM pending_email_enrollments
          WHERE id = ? AND email_address = ? AND proof_digest = ? AND state = 'awaiting_proof'
            AND expires_at_ms > ? AND proof_expires_at_ms > ?`)
        .bind(
          userId,
          verifiedAtMs,
          row.id,
          row.email_address,
          Uint8Array.from(row.proof_digest),
          verifiedAtMs,
          verifiedAtMs
        ),
      input.db
        .prepare(`INSERT INTO completed_email_enrollments (enrollment_id, user_id, completed_at_ms)
          VALUES (?, ?, ?)`)
        .bind(row.id, userId, verifiedAtMs),
    ],
  };
};
