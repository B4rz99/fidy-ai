import { Config, Crypto, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { BrowserLoginPairingId } from "~/core/browser-login/reference";
import {
  BrowserPairingEmailWorkflowId,
  EmailAddress,
  EmailDeliveryClaimToken,
  EmailDeliveryIntentId,
  EmailVerificationCode,
  EmailVerificationPublicCode,
} from "~/core/email-authentication/model";
import { proofExpiry } from "~/core/email-authentication/rules";
import { UserId } from "~/core/identity/reference";
import { lockPendingBrowserLoginPairingInScope } from "~/shell/browser-login/service";
import { withSubjectLock } from "~/shell/consent/repo";
import { advisoryLockKey, withUserLockInScope } from "~/shell/db/advisory-lock";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { sendEmailWithBoundedRetry } from "./delivery-retry";
import {
  digestBrowserPairingEmailProof,
  processNextBrowserPairingEmailStartRequest,
} from "./browser-pairing-authentication";
import { makeEmailDeliveryProof } from "./repo";

const GatewayClaim = Schema.Struct({
  intentId: EmailDeliveryIntentId,
  userId: UserId,
  claimToken: EmailDeliveryClaimToken,
});
type GatewayClaim = typeof GatewayClaim.Type;

const ArmedDelivery = Schema.Struct({
  intentId: EmailDeliveryIntentId,
  workflowId: BrowserPairingEmailWorkflowId,
  userId: UserId,
  generation: Schema.Int,
  emailAddress: EmailAddress,
  claimToken: EmailDeliveryClaimToken,
  idempotencyKey: Schema.String,
  publicCode: EmailVerificationPublicCode,
});
type ArmedDelivery = typeof ArmedDelivery.Type & Readonly<{ combinedCode: EmailVerificationCode }>;

const claimNextDelivery = Effect.fn(function* (claimedAt: DateTime.Utc) {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const claimToken = EmailDeliveryClaimToken.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
  return yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: GatewayClaim,
    execute: () => sql`
      SELECT intent_id AS "intentId", user_id AS "userId", claim_token AS "claimToken"
      FROM fidy_claim_browser_pairing_email_delivery(
        ${claimedAt}, ${claimToken}, ${DateTime.add(claimedAt, { minutes: 2 })}
      )
    `,
  })(undefined).pipe(Effect.orDie);
});

const ClaimedPairingReference = Schema.Struct({ pairingId: BrowserLoginPairingId });

const findClaimedPairingReferenceInScope = Effect.fn(function* (claim: GatewayClaim) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: ClaimedPairingReference,
    execute: () => sql`
      SELECT workflow.pairing_id AS "pairingId"
      FROM browser_pairing_email_delivery_intents intent
      JOIN browser_pairing_email_workflows workflow ON workflow.id = intent.workflow_id
      WHERE intent.id = ${claim.intentId} AND workflow.user_id = ${claim.userId}
        AND intent.status = 'claimed' AND intent.claim_token = ${claim.claimToken}
    `,
  })(undefined).pipe(Effect.orDie);
});

const rejectClaimedDeliveryInScope = Effect.fn(function* (claim: GatewayClaim) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      UPDATE browser_pairing_email_delivery_intents SET status = 'rejected',
        claim_token = NULL, claim_expires_at = NULL
      WHERE id = ${claim.intentId} AND status = 'claimed' AND claim_token = ${claim.claimToken}
    `.pipe(Effect.orDie);
});

const armClaimedDeliveryInScope = Effect.fn(function* (
  claim: GatewayClaim,
  claimedAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  const pairing = yield* findClaimedPairingReferenceInScope(claim);
  if (Option.isNone(pairing)) return Option.none<ArmedDelivery>();
  const live = yield* lockPendingBrowserLoginPairingInScope(pairing.value.pairingId, claimedAt);
  if (Option.isNone(live)) {
    yield* rejectClaimedDeliveryInScope(claim);
    return Option.none<ArmedDelivery>();
  }
  const { proof } = yield* makeEmailDeliveryProof();
  const digest = yield* digestBrowserPairingEmailProof(pairing.value.pairingId, proof);
  const armed = yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: ArmedDelivery,
    execute: () => sql`
        WITH armed_intent AS (
          UPDATE browser_pairing_email_delivery_intents intent SET status = 'armed'
          FROM browser_pairing_email_workflows workflow
          JOIN verified_email_credentials credential ON credential.user_id = workflow.user_id
          WHERE intent.id = ${claim.intentId} AND intent.workflow_id = workflow.id
            AND workflow.user_id = ${claim.userId} AND intent.status = 'claimed'
            AND intent.claim_token = ${claim.claimToken}
            AND intent.generation = workflow.delivery_generation
            AND workflow.expires_at > ${claimedAt}
            AND credential.email_address = intent.email_address
            AND credential.verified_at = workflow.credential_verified_at
          RETURNING intent.id, intent.workflow_id, intent.generation, intent.email_address,
            intent.claim_token, intent.idempotency_key
        )
        UPDATE browser_pairing_email_workflows workflow SET proof_digest = ${digest},
          proof_expires_at = LEAST(${proofExpiry(claimedAt)}, workflow.expires_at),
          wrong_proof_attempts = 0
        FROM armed_intent intent WHERE workflow.id = intent.workflow_id
        RETURNING intent.id AS "intentId", workflow.id AS "workflowId",
          workflow.user_id AS "userId", intent.generation,
          intent.email_address AS "emailAddress", intent.claim_token AS "claimToken",
          intent.idempotency_key AS "idempotencyKey", workflow.public_code AS "publicCode"
      `,
  })(undefined).pipe(Effect.orDie);
  if (Option.isNone(armed)) {
    yield* rejectClaimedDeliveryInScope(claim);
    return Option.none<ArmedDelivery>();
  }
  return Option.some({
    ...armed.value,
    combinedCode: EmailVerificationCode.make(`${armed.value.publicCode}-${proof}`),
  });
});

const settleArmedDeliveryInScope = Effect.fn(function* (input: {
  claim: ArmedDelivery;
  status: "sent" | "rejected" | "uncertain";
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      UPDATE browser_pairing_email_delivery_intents intent SET status = ${input.status},
        claim_token = NULL, claim_expires_at = NULL
      FROM browser_pairing_email_workflows workflow
      WHERE intent.id = ${input.claim.intentId} AND intent.workflow_id = ${input.claim.workflowId}
        AND workflow.id = intent.workflow_id AND intent.status = 'armed'
        AND intent.claim_token = ${input.claim.claimToken}
        AND intent.generation = ${input.claim.generation}
        AND intent.idempotency_key = ${input.claim.idempotencyKey}
        AND workflow.user_id = ${input.claim.userId}
        AND workflow.delivery_generation = ${input.claim.generation}
    `.pipe(Effect.orDie);
});

/**
 * Processes at most one RLS-safe email-login delivery outside provider transactions.
 *
 * This orchestration intentionally remains separate from replacement delivery: BrowserLogin
 * approval has an additional pairing lock and terminal-state check, and sharing the claim/arm/
 * settle pipeline would widen settlement authority across the two workflows. Provider latency,
 * retries, and terminal failure are observed once by `sendEmailWithBoundedRetry`; durable intent
 * status is the continuation signal, so this layer emits no second workflow event or identity.
 */
const processOneBrowserPairingEmailDelivery = Effect.fn(function* () {
  const claimedAt = yield* DateTime.now;
  const gatewayClaim = yield* claimNextDelivery(claimedAt);
  if (Option.isNone(gatewayClaim)) return false;
  const claim = gatewayClaim.value;
  const armed = yield* withUserTransaction(
    claim.userId,
    withSubjectLock(
      claim.userId,
      withUserLockInScope(
        advisoryLockKey.browserLoginApproval(claim.userId),
        armClaimedDeliveryInScope(claim, claimedAt)
      )
    )
  );
  if (Option.isNone(armed)) return false;
  const status = yield* sendEmailWithBoundedRetry({
    purpose: "browser-pairing-approval",
    to: armed.value.emailAddress,
    combinedCode: armed.value.combinedCode,
    idempotencyKey: armed.value.idempotencyKey,
  });
  yield* withUserTransaction(
    claim.userId,
    withSubjectLock(
      claim.userId,
      withUserLockInScope(
        advisoryLockKey.browserLoginApproval(claim.userId),
        settleArmedDeliveryInScope({ claim: armed.value, status })
      )
    )
  );
  return true;
});

/** Closed worker progress signal that projects no request, User, pairing, or delivery authority. */
export type BrowserPairingEmailBackgroundStepOutcome =
  | Readonly<{ readonly _tag: "Idle" }>
  | Readonly<{ readonly _tag: "Progressed" }>;

/** Advances one queued request and, when available, one closed-authority delivery step. */
export const processNextBackgroundStep = Effect.fn("EmailAuthentication.processNextBackgroundStep")(
  function* () {
    const requestProcessed = yield* processNextBrowserPairingEmailStartRequest();
    const deliveryProcessed = yield* processOneBrowserPairingEmailDelivery();
    return requestProcessed || deliveryProcessed
      ? ({ _tag: "Progressed" } as const)
      : ({ _tag: "Idle" } as const);
  }
);

/**
 * Scoped production loop that polls durable request/delivery work once per second. It requires the
 * database, cryptography, and EmailDeliveryPort services; provider retries and terminal failures
 * are observed by the bounded sender, while defects terminate the layer for runtime supervision.
 * Scope closure interrupts polling and waits for no PostgreSQL transaction across provider I/O.
 */
export const BrowserPairingEmailDeliveryWorkerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const environment = yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"));
    if (environment !== "production") return;
    yield* processNextBackgroundStep().pipe(
      Effect.delay("1 second"),
      Effect.forever,
      Effect.forkScoped
    );
  })
);
