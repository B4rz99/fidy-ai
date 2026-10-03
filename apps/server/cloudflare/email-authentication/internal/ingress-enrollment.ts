import {
  type EmailStatus,
  Sha256Digest,
  WhatsAppProviderMessageId,
} from "../../../src/shell/consent/contract";
import { Crypto, Effect, Option, Schema } from "effect";
import type {
  OnboardingEmailEnrollmentInput,
  OnboardingEmailReplayInput,
  OnboardingEmailStatusInput,
} from "../contract";

const EnrollmentReplayRow = Schema.Struct({
  submission_message_id: WhatsAppProviderMessageId,
  submission_body_sha256: Sha256Digest,
});
const EmailState = Schema.Struct({
  state: Schema.Literals([
    "awaiting_delivery",
    "sending",
    "awaiting_proof",
    "rejected",
    "ambiguous",
  ]),
});
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, void> =>
  Effect.tryPromise({ try: run, catch: () => undefined });

export const findOnboardingEmailReplay = (
  input: OnboardingEmailReplayInput
): Effect.Effect<Option.Option<"matching" | "conflict">, void> =>
  Effect.gen(function* () {
    const stored = yield* attempt(() =>
      input.db
        .prepare(`SELECT submission_message_id, submission_body_sha256 FROM pending_email_enrollments
        WHERE exchange_id = ?`)
        .bind(input.exchangeId)
        .first()
    );
    if (stored === null) return Option.none();
    const row = yield* Schema.decodeUnknownEffect(EnrollmentReplayRow)(stored).pipe(
      Effect.mapError(() => undefined)
    );
    return Option.some(
      row.submission_message_id === input.submissionMessageId &&
        row.submission_body_sha256 === input.submissionBodySha256
        ? "matching"
        : "conflict"
    );
  });

export const startOnboardingEmailEnrollment = (
  input: OnboardingEmailEnrollmentInput
): Effect.Effect<string, void, Crypto.Crypto> =>
  Effect.gen(function* () {
    const cryptoService = yield* Crypto.Crypto;
    const id = yield* cryptoService.randomUUIDv4.pipe(Effect.orDie);
    yield* attempt(() =>
      input.db
        .prepare(`INSERT INTO pending_email_enrollments
        (id, exchange_id, email_address, submission_message_id, submission_body_sha256,
         created_at_ms, expires_at_ms, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_delivery')`)
        .bind(
          id,
          input.exchangeId,
          input.email,
          input.submissionMessageId,
          input.submissionBodySha256,
          input.createdAtMs,
          input.expiresAtMs
        )
        .run()
    );
    return id;
  });

export const readOnboardingEmailStatus = (
  input: OnboardingEmailStatusInput
): Effect.Effect<EmailStatus, void> =>
  Effect.gen(function* () {
    const stored = yield* attempt(() =>
      input.db
        .prepare("SELECT state FROM pending_email_enrollments WHERE exchange_id = ?")
        .bind(input.exchangeId)
        .first()
    );
    if (stored === null) return "awaiting_email";
    return (yield* Schema.decodeUnknownEffect(EmailState)(stored).pipe(
      Effect.mapError(() => undefined)
    )).state;
  });
