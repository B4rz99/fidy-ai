import { Config, Crypto, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import {
  EmailAddress,
  EmailDeliveryClaimToken,
  EmailDeliveryIntentId,
  EmailReplacementWorkflowId,
  EmailVerificationCode,
  EmailVerificationPublicCode,
} from "~/core/email-authentication/model";
import { proofExpiry } from "~/core/email-authentication/rules";
import { UserId } from "~/core/identity/reference";
import { withSubjectLock } from "~/shell/consent/repo";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { sendEmailWithBoundedRetry } from "./delivery-retry";
import { makeEmailDeliveryProof } from "./repo";

const DeliveryGatewayClaim = Schema.Struct({
  intentId: EmailDeliveryIntentId,
  userId: UserId,
  claimToken: EmailDeliveryClaimToken,
});
type DeliveryGatewayClaim = typeof DeliveryGatewayClaim.Type;

const ArmedReplacementDelivery = Schema.Struct({
  intentId: EmailDeliveryIntentId,
  workflowId: EmailReplacementWorkflowId,
  userId: UserId,
  generation: Schema.Int,
  emailAddress: EmailAddress,
  claimToken: EmailDeliveryClaimToken,
  idempotencyKey: Schema.String,
  publicCode: EmailVerificationPublicCode,
});
type ArmedReplacementDelivery = typeof ArmedReplacementDelivery.Type &
  Readonly<{ combinedCode: EmailVerificationCode }>;

const claimNextDelivery = Effect.fn("EmailReplacementDelivery.claimNext")(function* (
  claimedAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const claimToken = EmailDeliveryClaimToken.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
  return yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: DeliveryGatewayClaim,
    execute: () => sql`
      SELECT intent_id AS "intentId", user_id AS "userId", claim_token AS "claimToken"
      FROM fidy_claim_email_replacement_delivery(
        ${claimedAt}, ${claimToken}, ${DateTime.add(claimedAt, { minutes: 2 })}
      )
    `,
  })(undefined).pipe(Effect.orDie);
});

const armClaimedDeliveryInScope = Effect.fn("EmailReplacementDelivery.armClaimedInScope")(
  function* (claim: DeliveryGatewayClaim, claimedAt: DateTime.Utc) {
    const sql = yield* SqlClient.SqlClient;
    const { digest, proof } = yield* makeEmailDeliveryProof();
    const armed = yield* SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: ArmedReplacementDelivery,
      execute: () => sql`
        WITH armed_intent AS (
          UPDATE email_replacement_delivery_intents intent SET status = 'armed'
          FROM email_replacement_workflows workflow
          WHERE intent.id = ${claim.intentId} AND intent.workflow_id = workflow.id
            AND workflow.user_id = ${claim.userId} AND intent.status = 'claimed'
            AND intent.claim_token = ${claim.claimToken}
            AND intent.generation = workflow.delivery_generation
            AND workflow.expires_at > ${claimedAt}
          RETURNING intent.id, intent.workflow_id, intent.generation, intent.email_address,
            intent.claim_token, intent.idempotency_key
        )
        UPDATE email_replacement_workflows workflow SET proof_digest = ${digest},
          proof_expires_at = LEAST(${proofExpiry(claimedAt)}, workflow.expires_at),
          wrong_proof_attempts = 0
        FROM armed_intent intent
        WHERE workflow.id = intent.workflow_id
        RETURNING intent.id AS "intentId", workflow.id AS "workflowId",
          workflow.user_id AS "userId", intent.generation,
          intent.email_address AS "emailAddress", intent.claim_token AS "claimToken",
          intent.idempotency_key AS "idempotencyKey", workflow.public_code AS "publicCode"
      `,
    })(undefined).pipe(Effect.orDie);
    if (Option.isNone(armed)) return Option.none<ArmedReplacementDelivery>();
    return Option.some({
      ...armed.value,
      combinedCode: EmailVerificationCode.make(`${armed.value.publicCode}-${proof}`),
    });
  }
);

const settleArmedDeliveryInScope = Effect.fn("EmailReplacementDelivery.settleArmedInScope")(
  function* (input: {
    claim: ArmedReplacementDelivery;
    status: "sent" | "rejected" | "uncertain";
    providerMessageId: Option.Option<string>;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const updated = yield* sql`
      UPDATE email_replacement_delivery_intents intent SET status = ${input.status},
        provider_message_id = ${Option.getOrNull(input.providerMessageId)},
        claim_token = NULL, claim_expires_at = NULL
      FROM email_replacement_workflows workflow
      WHERE intent.id = ${input.claim.intentId} AND intent.workflow_id = ${input.claim.workflowId}
        AND workflow.id = intent.workflow_id AND intent.status = 'armed'
        AND intent.claim_token = ${input.claim.claimToken}
        AND intent.generation = ${input.claim.generation}
        AND intent.idempotency_key = ${input.claim.idempotencyKey}
        AND workflow.user_id = ${input.claim.userId}
        AND workflow.delivery_generation = ${input.claim.generation}
      RETURNING intent.id
    `.pipe(Effect.orDie);
    return updated.length === 1;
  }
);

/**
 * Processes at most one eligible replacement delivery. It returns `false` when no work is available
 * or the selected work is no longer valid, and `true` after one proof reaches the provider boundary
 * and its outcome is submitted for durable settlement. Provider failures become terminal delivery
 * outcomes rather than escaping to the caller.
 */
export const processOneReplacementDelivery = Effect.fn("EmailReplacementDelivery.processOne")(
  function* () {
    const claimedAt = yield* DateTime.now;
    const gatewayClaim = yield* claimNextDelivery(claimedAt);
    if (Option.isNone(gatewayClaim)) return false;
    const claim = gatewayClaim.value;
    const armed = yield* withUserTransaction(
      claim.userId,
      withSubjectLock(claim.userId, armClaimedDeliveryInScope(claim, claimedAt))
    );
    if (Option.isNone(armed)) return false;
    const intent = armed.value;
    // Provider attempts own their bounded telemetry and terminal failure capture. The durable intent
    // lifecycle is the continuation evidence, so an outer poll span would double-report failures
    // and emit noise for every empty worker step.
    const status = yield* sendEmailWithBoundedRetry({
      purpose: "credential-replacement",
      to: intent.emailAddress,
      combinedCode: intent.combinedCode,
      idempotencyKey: intent.idempotencyKey,
    });
    yield* withUserTransaction(
      claim.userId,
      withSubjectLock(
        claim.userId,
        settleArmedDeliveryInScope({
          claim: intent,
          status,
          providerMessageId: Option.none(),
        })
      )
    );
    return true;
  }
);

/** Production proof delivery loop; provider calls remain outside database transactions. */
export const EmailReplacementDeliveryWorkerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const environment = yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"));
    if (environment !== "production") return;
    yield* processOneReplacementDelivery().pipe(
      Effect.delay("1 second"),
      Effect.forever,
      Effect.forkScoped
    );
  })
);
