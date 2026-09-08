import { DateTime, Effect, Option, Result, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { Activity } from "effect/unstable/workflow";
import {
  EmailAddress,
  EmailReplacementWorkflowId,
  EmailVerificationCode,
  EmailVerificationPublicCode,
} from "~/core/email-authentication/model";
import { proofExpiry } from "~/core/email-authentication/rules";
import { withSubjectLock } from "~/shell/consent/repo";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { attemptEmailDelivery, settleTerminalEmailFailure } from "./delivery-retry";
import { makeEmailDeliveryProof } from "./repo";
import type { EmailSendFailed } from "./delivery";
import {
  type ReplacementAttemptResult,
  type ReplacementDeliveryPayload,
} from "./replacement-protocol";

const CurrentDelivery = Schema.Struct({
  workflowId: EmailReplacementWorkflowId,
  generation: Schema.Int,
  emailAddress: EmailAddress,
  publicCode: EmailVerificationPublicCode,
  status: Schema.Literals(["pending", "armed", "sent", "rejected", "uncertain", "superseded"]),
});
const AttemptEvidence = Schema.Struct({
  outcome: Schema.Literals(["armed", "sent", "rejected", "uncertain", "retry"]),
});

const findCurrentDelivery = Effect.fn(function* (
  payload: ReplacementDeliveryPayload,
  now: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: CurrentDelivery,
    execute: () => sql`SELECT workflow.id AS "workflowId", intent.generation,
      intent.email_address AS "emailAddress", workflow.public_code AS "publicCode", intent.status
      FROM email_replacement_delivery_intents intent
      JOIN email_replacement_workflows workflow ON workflow.id = intent.workflow_id
      JOIN verified_email_credentials credential ON credential.user_id = workflow.user_id
      WHERE intent.id = ${payload.intentId} AND workflow.user_id = ${payload.userId}
        AND intent.generation = workflow.delivery_generation
        AND intent.email_address = workflow.candidate_email_address
        AND credential.verified_at = workflow.credential_verified_at
        AND workflow.expires_at > ${now}
      FOR UPDATE OF workflow, intent`,
  })(undefined).pipe(Effect.orDie);
});

const reconcileArmedAttempt = Effect.fn(function* (
  payload: ReplacementDeliveryPayload,
  attempt: number
) {
  const sql = yield* SqlClient.SqlClient;
  // No raw proof survives arming. Recovery cannot distinguish an unsent proof from provider commit.
  yield* sql`UPDATE email_replacement_delivery_attempts SET outcome = 'uncertain'
    WHERE intent_id = ${payload.intentId} AND attempt = ${attempt}`.pipe(Effect.orDie);
  yield* sql`UPDATE email_replacement_delivery_intents SET status = 'uncertain'
    WHERE id = ${payload.intentId}`.pipe(Effect.orDie);
  return "uncertain" as const;
});

const canArmAttempt = Effect.fn(function* (
  payload: ReplacementDeliveryPayload,
  attempt: number,
  status: (typeof CurrentDelivery.Type)["status"]
) {
  if (attempt === 1) return status === "pending";
  if (status !== "rejected") return false;
  const sql = yield* SqlClient.SqlClient;
  const previous = yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: AttemptEvidence,
    execute: () => sql`SELECT outcome FROM email_replacement_delivery_attempts
      WHERE intent_id = ${payload.intentId} AND attempt = ${attempt - 1}`,
  })(undefined).pipe(Effect.orDie);
  return Option.exists(previous, (evidence) => evidence.outcome === "retry");
});

const prepareAttempt = Effect.fn(function* (payload: ReplacementDeliveryPayload, attempt: number) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* DateTime.now;
  const current = yield* findCurrentDelivery(payload, now);
  if (Option.isNone(current) || current.value.status === "superseded") {
    return { _tag: "Settled", outcome: "not-current" } as const;
  }
  const prior = yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: AttemptEvidence,
    execute: () => sql`SELECT outcome FROM email_replacement_delivery_attempts
      WHERE intent_id = ${payload.intentId} AND attempt = ${attempt}`,
  })(undefined).pipe(Effect.orDie);
  if (Option.isSome(prior)) {
    const outcome =
      prior.value.outcome === "armed"
        ? yield* reconcileArmedAttempt(payload, attempt)
        : prior.value.outcome;
    return { _tag: "Settled", outcome } as const;
  }
  if (!(yield* canArmAttempt(payload, attempt, current.value.status))) {
    return { _tag: "Settled", outcome: "not-current" } as const;
  }
  const { digest, proof } = yield* makeEmailDeliveryProof();
  yield* sql`INSERT INTO email_replacement_delivery_attempts (intent_id, attempt, outcome)
    VALUES (${payload.intentId}, ${attempt}, 'armed')`.pipe(Effect.orDie);
  yield* sql`UPDATE email_replacement_delivery_intents SET status = 'armed'
    WHERE id = ${payload.intentId}`.pipe(Effect.orDie);
  yield* sql`UPDATE email_replacement_workflows SET proof_digest = ${digest},
    proof_expires_at = LEAST(${proofExpiry(now)}, expires_at), wrong_proof_attempts = 0
    WHERE id = ${current.value.workflowId} AND user_id = ${payload.userId}`.pipe(Effect.orDie);
  return {
    _tag: "Armed",
    ...current.value,
    digest,
    combinedCode: EmailVerificationCode.make(`${current.value.publicCode}-${proof}`),
  } as const;
});

const deliveryOutcome = Effect.fn(function* (
  send: Result.Result<void, EmailSendFailed>,
  attempt: number
) {
  if (Result.isSuccess(send)) return "sent" as const;
  if (send.failure.certainty === "rejected" && send.failure.retryable && attempt < 3) {
    return "retry" as const;
  }
  return yield* settleTerminalEmailFailure(send.failure);
});

/**
 * Executes one provider attempt for an explicit User-owned intent. Arming and settlement commit in
 * separate short transactions; plaintext never leaves this Activity for persisted workflow history.
 * Re-entry reuses definitive evidence or reconciles Armed as uncertain, never resending that proof.
 */
export const performReplacementAttempt = Effect.fn("EmailReplacementDelivery.attempt")(function* (
  payload: ReplacementDeliveryPayload,
  attempt: number
) {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 3) return "not-current" as const;
  const prepared = yield* withUserTransaction(
    payload.userId,
    withSubjectLock(payload.userId, prepareAttempt(payload, attempt))
  );
  if (prepared._tag === "Settled") return prepared.outcome;
  const send = yield* attemptEmailDelivery({
    purpose: "credential-replacement",
    to: prepared.emailAddress,
    combinedCode: prepared.combinedCode,
    idempotencyKey: `${payload.intentId}/${attempt}`,
  }).pipe(Effect.provideService(Activity.CurrentAttempt, attempt), Effect.result);
  const outcome: ReplacementAttemptResult = yield* deliveryOutcome(send, attempt);
  return yield* withUserTransaction(
    payload.userId,
    withSubjectLock(
      payload.userId,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const current = yield* findCurrentDelivery(payload, yield* DateTime.now);
        if (
          Option.isNone(current) ||
          current.value.status !== "armed" ||
          current.value.generation !== prepared.generation
        ) {
          return "not-current" as const;
        }
        const settled =
          yield* sql`UPDATE email_replacement_delivery_attempts evidence SET outcome = ${outcome}
        FROM email_replacement_workflows workflow
        WHERE evidence.intent_id = ${payload.intentId} AND evidence.attempt = ${attempt}
          AND evidence.outcome = 'armed' AND workflow.id = ${prepared.workflowId}
          AND workflow.user_id = ${payload.userId} AND workflow.proof_digest = ${prepared.digest}
        RETURNING evidence.intent_id`.pipe(Effect.orDie);
        if (settled.length !== 1) return "not-current" as const;
        yield* sql`UPDATE email_replacement_delivery_intents SET status = ${outcome === "retry" ? "rejected" : outcome}
        WHERE id = ${payload.intentId}`.pipe(Effect.orDie);
        return outcome;
      })
    )
  );
});
