import { timingSafeEqual } from "node:crypto";
import { Crypto, DateTime, Effect, Option, Schema, Struct } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import {
  EmailAddress,
  EmailDeliveryClaimToken,
  EmailDeliveryIntentId,
  EmailReplacementRetentionClaimToken,
  EmailReplacementWorkflow,
  EmailReplacementWorkflowId,
  EmailVerificationCode,
  EmailVerificationDigest,
  EmailVerificationProof,
  EmailVerificationPublicCode,
  maximumEmailDeliveryGenerations,
} from "~/core/email-authentication/model";
import {
  decideEmailReplacementRequest,
  decideProofAttempt,
  emailWorkflowExpiry,
  formatEmailCode,
  proofExpiry,
  resendAvailability,
  selectEmailCodeSymbols,
} from "~/core/email-authentication/rules";
import { UserId } from "~/core/identity/reference";
import type { WebSessionId } from "~/core/web-session/reference";
import { advisoryLockKey } from "~/shell/db/advisory-lock";
import { makeEmailDeliveryProof } from "./repo";

const workflowPublicSymbolCount = 8;
const groupedCodeSymbolCount = 4;
const requiredAdmissionBudgetCount = 2;
const publicCodeLength = 9;
const proofOffset = 10;

const RequestWorkflow = EmailReplacementWorkflow.mapFields(
  Struct.pick([
    "id",
    "candidateEmailAddress",
    "deliveryGeneration",
    "resendAvailableAt",
    "expiresAt",
  ])
).mapFields(
  Struct.evolve({
    resendAvailableAt: () => Schema.DateTimeUtcFromDate,
    expiresAt: () => Schema.DateTimeUtcFromDate,
  })
);
const WorkflowRequestRow = RequestWorkflow;
type RequestWorkflow = typeof RequestWorkflow.Type;

const CompletionWorkflow = EmailReplacementWorkflow.mapFields(
  Struct.pick(["id", "candidateEmailAddress", "expiresAt", "proofState", "wrongProofAttempts"])
).mapFields(Struct.evolve({ expiresAt: () => Schema.DateTimeUtcFromDate }));
type CompletionWorkflow = typeof CompletionWorkflow.Type;
const CompletionWorkflowRowBase = CompletionWorkflow.mapFields(Struct.omit(["proofState"]));
const CompletionWorkflowRow = Schema.Struct({
  ...CompletionWorkflowRowBase.fields,
  proofDigest: Schema.OptionFromNullOr(EmailVerificationDigest),
  proofExpiresAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
});
type RequestWorkflowAdmission =
  | Readonly<{ _tag: "Rejected" }>
  | Readonly<{ _tag: "Admitted"; existing: Option.Option<RequestWorkflow> }>;
const rejectedRequest = (): RequestWorkflowAdmission => ({ _tag: "Rejected" });
const admittedRequest = (existing: Option.Option<RequestWorkflow>): RequestWorkflowAdmission => ({
  _tag: "Admitted",
  existing,
});

/** Already-authorized facts required to request one replacement delivery generation. */
export type RequestReplacementInput = Readonly<{
  userId: UserId;
  candidateEmail: EmailAddress;
  requestedAt: DateTime.Utc;
  callerBudgetKey: string;
  recipientBudgetKey: string;
}>;

const candidateMatchesCurrentCredential = Effect.fn(
  "EmailAuthentication.candidateMatchesCurrentCredential"
)(function* (input: RequestReplacementInput) {
  const sql = yield* SqlClient.SqlClient;
  const current = yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: Schema.Struct({ emailAddress: EmailAddress }),
    execute: () => sql`
      SELECT email_address AS "emailAddress" FROM verified_email_credentials
      WHERE user_id = ${input.userId}
    `,
  })(undefined).pipe(Effect.orDie);
  return Option.exists(current, ({ emailAddress }) => emailAddress === input.candidateEmail);
});

const decideLockedReplacementAdmission = Effect.fn(
  "EmailAuthentication.decideLockedReplacementAdmission"
)(function* (input: RequestReplacementInput) {
  const sql = yield* SqlClient.SqlClient;
  if (yield* candidateMatchesCurrentCredential(input)) {
    return rejectedRequest();
  }
  const candidateLock = advisoryLockKey.emailReplacementCandidate(input.candidateEmail);
  yield* sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${candidateLock.value}, ${candidateLock.seed}))
  `.pipe(Effect.orDie);
  const candidate = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ unavailable: Schema.Boolean }),
    execute: () => sql`
      SELECT fidy_email_replacement_candidate_unavailable(
        ${input.userId}, ${input.candidateEmail}
      ) AS unavailable
    `,
  })(undefined).pipe(Effect.orDie);
  if (candidate.unavailable) return rejectedRequest();
  const existing = yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: WorkflowRequestRow,
    execute: () => sql`
      SELECT id, candidate_email_address AS "candidateEmailAddress",
        delivery_generation AS "deliveryGeneration", resend_available_at AS "resendAvailableAt",
        expires_at AS "expiresAt"
      FROM email_replacement_workflows WHERE user_id = ${input.userId} FOR UPDATE
    `,
  })(undefined).pipe(Effect.orDie);
  const decision = yield* decideEmailReplacementRequest({
    existing: Option.map(existing, (workflow) => ({
      candidateMatches: workflow.candidateEmailAddress === input.candidateEmail,
      deliveryGeneration: workflow.deliveryGeneration,
      resendAvailableAt: workflow.resendAvailableAt,
      expiresAt: workflow.expiresAt,
    })),
    requestedAt: input.requestedAt,
  });
  if (decision === "Reject") return rejectedRequest();
  if (decision === "ReplaceExpired") {
    yield* sql`DELETE FROM email_replacement_workflows WHERE user_id = ${input.userId}`.pipe(
      Effect.orDie
    );
    return admittedRequest(Option.none());
  }
  return admittedRequest(decision === "Start" ? Option.none() : existing);
});

const admitReplacementBudgets = Effect.fn("EmailAuthentication.admitReplacementBudgets")(function* (
  input: RequestReplacementInput
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      INSERT INTO email_delivery_admission_budgets (scope_key, delivery_count, expires_at)
      VALUES (${input.callerBudgetKey}, 0, ${input.requestedAt}),
        (${input.recipientBudgetKey}, 0, ${input.requestedAt})
      ON CONFLICT (scope_key) DO NOTHING
    `.pipe(Effect.orDie);
  const admitted = yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: Schema.Struct({ count: Schema.Int }),
    execute: () => sql`
        WITH locked AS MATERIALIZED (
          SELECT scope_key, delivery_count, expires_at FROM email_delivery_admission_budgets
          WHERE scope_key IN (${input.callerBudgetKey}, ${input.recipientBudgetKey})
          ORDER BY scope_key FOR UPDATE
        ), eligible AS (
          SELECT count(*) = ${requiredAdmissionBudgetCount}
            AND bool_and(expires_at <= ${input.requestedAt}
              OR delivery_count < ${maximumEmailDeliveryGenerations}) AS admitted FROM locked
        ), updated_budgets AS (
          UPDATE email_delivery_admission_budgets budget SET
            delivery_count = CASE WHEN expires_at <= ${input.requestedAt}
              THEN 1 ELSE delivery_count + 1 END,
            expires_at = CASE WHEN expires_at <= ${input.requestedAt}
              THEN ${DateTime.add(input.requestedAt, { hours: 24 })} ELSE expires_at END
          WHERE scope_key IN (${input.callerBudgetKey}, ${input.recipientBudgetKey})
            AND (SELECT admitted FROM eligible) RETURNING scope_key
        ) SELECT count(*)::int AS count FROM updated_budgets
      `,
  })(undefined).pipe(Effect.orDie);
  return Option.isSome(admitted) && admitted.value.count === requiredAdmissionBudgetCount;
});

const persistReplacementGeneration = Effect.fn("EmailAuthentication.persistReplacementGeneration")(
  function* (input: RequestReplacementInput, existing: Option.Option<RequestWorkflow>) {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const workflowId = Option.isSome(existing)
      ? existing.value.id
      : EmailReplacementWorkflowId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
    const intentId = EmailDeliveryIntentId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
    const publicCode = EmailVerificationPublicCode.make(
      formatEmailCode({
        symbols: selectEmailCodeSymbols({
          bytes: yield* crypto.randomBytes(workflowPublicSymbolCount).pipe(Effect.orDie),
          maximum: workflowPublicSymbolCount,
        }),
        groupSize: groupedCodeSymbolCount,
      })
    );
    if (Option.isNone(existing)) {
      const inserted = yield* sql`
      INSERT INTO email_replacement_workflows (
        id, user_id, candidate_email_address, public_code, started_at, expires_at,
        delivery_generation, resend_available_at
      ) VALUES (
        ${workflowId}, ${input.userId}, ${input.candidateEmail}, ${publicCode},
        ${input.requestedAt}, ${emailWorkflowExpiry(input.requestedAt)}, 1,
        ${resendAvailability(input.requestedAt)}
      ) ON CONFLICT DO NOTHING RETURNING id
    `.pipe(Effect.orDie);
      if (inserted.length === 0) return;
    } else {
      yield* sql`
      UPDATE email_replacement_delivery_intents SET status = 'superseded',
        claim_token = NULL, claim_expires_at = NULL
      WHERE workflow_id = ${workflowId} AND status <> 'superseded'
    `.pipe(Effect.orDie);
      yield* sql`
      UPDATE email_replacement_workflows SET
        candidate_email_address = ${input.candidateEmail}, public_code = ${publicCode},
        delivery_generation = delivery_generation + 1,
        resend_available_at = ${resendAvailability(input.requestedAt)},
        proof_digest = NULL, proof_expires_at = NULL, wrong_proof_attempts = 0
      WHERE id = ${workflowId}
    `.pipe(Effect.orDie);
    }
    yield* sql`
    INSERT INTO email_replacement_delivery_intents (
      id, workflow_id, generation, email_address, status, idempotency_key, created_at
    ) SELECT ${intentId}, id, delivery_generation, candidate_email_address, 'pending',
      ${intentId}, ${input.requestedAt}
    FROM email_replacement_workflows WHERE id = ${workflowId}
  `.pipe(Effect.orDie);
  }
);

/** Admits or supersedes one bounded workflow while preserving its original 24-hour horizon. */
export const requestReplacementInScope = Effect.fn("EmailAuthentication.requestReplacementInScope")(
  function* (input: RequestReplacementInput) {
    const admittedWorkflow = yield* decideLockedReplacementAdmission(input);
    if (admittedWorkflow._tag === "Rejected") return;
    if (!(yield* admitReplacementBudgets(input))) return;
    yield* persistReplacementGeneration(input, admittedWorkflow.existing);
  }
);

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
});
/** User-scoped delivery claim carrying the transient code sent to the provider. */
export type ClaimedReplacementDelivery = typeof ArmedReplacementDelivery.Type &
  Readonly<{ combinedCode: EmailVerificationCode }>;

/** Global minimum-data gateway claim; proof creation and workflow access remain User-scoped. */
export const claimReplacementDeliveryGateway = Effect.fn(
  "EmailAuthentication.claimReplacementDeliveryGateway"
)(function* (claimedAt: DateTime.Utc) {
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

/** Arms exactly the gateway-claimed generation with a fresh proof inside User RLS scope. */
export const armClaimedReplacementInScope = Effect.fn(
  "EmailAuthentication.armClaimedReplacementInScope"
)(function* (claim: DeliveryGatewayClaim, claimedAt: DateTime.Utc) {
  const sql = yield* SqlClient.SqlClient;
  const { digest, proof } = yield* makeEmailDeliveryProof();
  const armed = yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: ArmedReplacementDelivery.pipe(
      Schema.fieldsAssign({ publicCode: EmailVerificationPublicCode })
    ),
    execute: () => sql`
    UPDATE email_replacement_workflows workflow SET proof_digest = ${digest},
      proof_expires_at = LEAST(${proofExpiry(claimedAt)}, workflow.expires_at),
      wrong_proof_attempts = 0
    FROM email_replacement_delivery_intents intent
    WHERE intent.id = ${claim.intentId} AND intent.workflow_id = workflow.id
      AND workflow.user_id = ${claim.userId} AND intent.status = 'claimed'
      AND intent.claim_token = ${claim.claimToken}
      AND intent.generation = workflow.delivery_generation
      AND workflow.expires_at > ${claimedAt}
    RETURNING intent.id AS "intentId", workflow.id AS "workflowId",
      workflow.user_id AS "userId", intent.generation,
      intent.email_address AS "emailAddress", intent.claim_token AS "claimToken",
      intent.idempotency_key AS "idempotencyKey", workflow.public_code AS "publicCode"
  `,
  })(undefined).pipe(Effect.orDie);
  return Option.map(armed, ({ publicCode, ...intent }) => ({
    ...intent,
    combinedCode: EmailVerificationCode.make(`${publicCode}-${proof}`),
  }));
});

/** Records one fenced provider outcome and clears its lease inside User RLS scope. */
export const settleReplacementDeliveryInScope = Effect.fn(
  "EmailAuthentication.settleReplacementDeliveryInScope"
)(function* (input: {
  claim: ClaimedReplacementDelivery;
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
      AND workflow.id = intent.workflow_id AND intent.status = 'claimed'
      AND intent.claim_token = ${input.claim.claimToken}
      AND intent.generation = ${input.claim.generation}
      AND intent.idempotency_key = ${input.claim.idempotencyKey}
      AND workflow.user_id = ${input.claim.userId}
      AND workflow.delivery_generation = ${input.claim.generation}
    RETURNING intent.id
  `.pipe(Effect.orDie);
  return updated.length === 1;
});

const digestProof = Effect.fn("EmailAuthentication.digestReplacementProof")(function* (
  proof: EmailVerificationProof
) {
  const crypto = yield* Crypto.Crypto;
  return yield* crypto.digest("SHA-256", new TextEncoder().encode(proof)).pipe(Effect.orDie);
});

const RetentionGatewayClaim = Schema.Struct({
  workflowId: EmailReplacementWorkflowId,
  userId: UserId,
  claimToken: EmailReplacementRetentionClaimToken,
});
export type RetentionGatewayClaim = typeof RetentionGatewayClaim.Type;

/** Claims at most one expired workflow without exposing its candidate, proof, or state. */
export const claimExpiredReplacementWorkflow = Effect.fn(
  "EmailAuthentication.claimExpiredReplacementWorkflow"
)(function* (claimedAt: DateTime.Utc) {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const claimToken = EmailReplacementRetentionClaimToken.make(
    yield* crypto.randomUUIDv7.pipe(Effect.orDie)
  );
  return yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: RetentionGatewayClaim,
    execute: () => sql`
      SELECT workflow_id AS "workflowId", user_id AS "userId", claim_token AS "claimToken"
      FROM fidy_claim_expired_email_replacement_workflow(
        ${claimedAt}, ${claimToken}, ${DateTime.add(claimedAt, { minutes: 2 })}
      )
    `,
  })(undefined).pipe(Effect.orDie);
});

/** Deletes only the expired workflow named by the current retention lease. */
export const removeClaimedExpiredReplacementWorkflowInScope = Effect.fn(
  "EmailAuthentication.removeClaimedExpiredReplacementWorkflowInScope"
)(function* (claim: RetentionGatewayClaim, attemptedAt: DateTime.Utc) {
  const sql = yield* SqlClient.SqlClient;
  const deleted = yield* sql`
    DELETE FROM email_replacement_workflows
    WHERE id = ${claim.workflowId} AND user_id = ${claim.userId}
      AND retention_claim_token = ${claim.claimToken}
      AND retention_claim_expires_at > ${attemptedAt} AND expires_at <= ${attemptedAt}
    RETURNING id
  `.pipe(Effect.orDie);
  return deleted.length === 1;
});

/** Owner operation for the approved gateway; rows exactly at the cutoff remain retained. */
export const removeLifecycleEventsBefore = Effect.fn(
  "EmailAuthentication.removeLifecycleEventsBefore"
)(function* (cutoff: DateTime.Utc) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    SELECT fidy_delete_verified_email_lifecycle_events_before(${cutoff}) AS deleted_count
  `;
});

/** Uniform direct-completion outcome; rejection reveals no workflow or mailbox state. */
export type ReplacementCompletion = "replaced" | "rejected";

type CompleteReplacementInput = Readonly<{
  userId: UserId;
  authorizingWebSessionId: WebSessionId;
  attemptedAt: DateTime.Utc;
  combinedCode: EmailVerificationCode;
}>;

const reconstructCompletionWorkflow = (
  row: typeof CompletionWorkflowRow.Type
): CompletionWorkflow => {
  const { proofDigest: _, proofExpiresAt: __, ...workflow } = row;
  if (Option.isNone(row.proofDigest) && Option.isNone(row.proofExpiresAt)) {
    return { ...workflow, proofState: { _tag: "AwaitingDelivery" } };
  }
  if (Option.isSome(row.proofDigest) && Option.isSome(row.proofExpiresAt)) {
    return {
      ...workflow,
      proofState: {
        _tag: "AwaitingProof",
        proofDigest: row.proofDigest.value,
        proofExpiresAt: row.proofExpiresAt.value,
      },
    };
  }
  throw new Error("Email replacement proof columns violated their database invariant");
};

const findCompletionWorkflow = Effect.fn("EmailAuthentication.findCompletionWorkflow")(function* (
  input: CompleteReplacementInput
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: CompletionWorkflowRow,
    execute: () => sql`
        SELECT id, candidate_email_address AS "candidateEmailAddress", expires_at AS "expiresAt",
          proof_digest AS "proofDigest", proof_expires_at AS "proofExpiresAt",
          wrong_proof_attempts AS "wrongProofAttempts" FROM email_replacement_workflows
        WHERE user_id = ${input.userId}
          AND public_code = ${input.combinedCode.slice(0, publicCodeLength)} FOR UPDATE
      `,
  })(undefined).pipe(Effect.orDie, Effect.map(Option.map(reconstructCompletionWorkflow)));
});

const applyCompletionProofAttempt = Effect.fn("EmailAuthentication.applyCompletionProofAttempt")(
  function* (workflow: CompletionWorkflow, input: CompleteReplacementInput) {
    const sql = yield* SqlClient.SqlClient;
    const candidateLock = advisoryLockKey.emailReplacementCandidate(workflow.candidateEmailAddress);
    yield* sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${candidateLock.value}, ${candidateLock.seed}))
  `.pipe(Effect.orDie);
    if (workflow.proofState._tag === "AwaitingDelivery") return false;
    const proof = EmailVerificationProof.make(input.combinedCode.slice(proofOffset));
    const actualDigest = yield* digestProof(proof);
    const decision = yield* decideProofAttempt({
      digestMatches:
        actualDigest.length === workflow.proofState.proofDigest.length &&
        timingSafeEqual(actualDigest, workflow.proofState.proofDigest),
      wrongAttempts: workflow.wrongProofAttempts,
      proofExpiresAt: workflow.proofState.proofExpiresAt,
      enrollmentExpiresAt: workflow.expiresAt,
      attemptedAt: input.attemptedAt,
    });
    if (decision._tag === "Accept") return true;
    if (decision._tag === "Delete") {
      yield* sql`DELETE FROM email_replacement_workflows WHERE id = ${workflow.id}`.pipe(
        Effect.orDie
      );
    } else if (decision._tag === "Wrong") {
      yield* sql`
      UPDATE email_replacement_workflows SET wrong_proof_attempts = ${decision.wrongAttempts}
      WHERE id = ${workflow.id}
    `.pipe(Effect.orDie);
    } else {
      yield* sql`
      UPDATE email_replacement_workflows SET proof_digest = NULL, proof_expires_at = NULL
      WHERE id = ${workflow.id}
    `.pipe(Effect.orDie);
    }
    return false;
  }
);

const appendReplacedLifecycleEvent = Effect.fn("EmailAuthentication.appendReplacedLifecycleEvent")(
  function* (input: {
    userId: UserId;
    authorizingWebSessionId: WebSessionId;
    occurredAt: DateTime.Utc;
  }) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
    INSERT INTO verified_email_credential_lifecycle_events (
      subject_user_id, authorizing_web_session_id, occurred_at
    ) VALUES (${input.userId}, ${input.authorizingWebSessionId}, ${input.occurredAt})
  `.pipe(Effect.orDie);
  }
);

const commitReplacement = Effect.fn("EmailAuthentication.commitReplacement")(function* (
  workflow: CompletionWorkflow,
  input: CompleteReplacementInput
) {
  const sql = yield* SqlClient.SqlClient;
  const credentialUpdated = yield* sql
    .withTransaction(
      sql`
        UPDATE verified_email_credentials SET email_address = ${workflow.candidateEmailAddress},
          verified_at = ${input.attemptedAt} WHERE user_id = ${input.userId}
        RETURNING user_id
      `
    )
    .pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.catch((error) =>
        error.reason._tag === "UniqueViolation" &&
        error.reason.constraint === "verified_email_credentials_normalized_email_unique"
          ? Effect.succeed(false)
          : Effect.fail(error)
      ),
      Effect.orDie
    );
  if (!credentialUpdated) return false;
  yield* appendReplacedLifecycleEvent({
    userId: input.userId,
    authorizingWebSessionId: input.authorizingWebSessionId,
    occurredAt: input.attemptedAt,
  });
  yield* sql`DELETE FROM email_replacement_workflows WHERE id = ${workflow.id}`.pipe(Effect.orDie);
  return true;
});

/** Consumes one current proof and commits credential, evidence, and cleanup as one transaction. */
export const completeReplacementInScope = Effect.fn(
  "EmailAuthentication.completeReplacementInScope"
)(function* (input: CompleteReplacementInput) {
  const workflow = yield* findCompletionWorkflow(input);
  if (Option.isNone(workflow)) return "rejected" as const;
  if (!(yield* applyCompletionProofAttempt(workflow.value, input))) return "rejected" as const;
  return (yield* commitReplacement(workflow.value, input)) ? "replaced" : "rejected";
});
