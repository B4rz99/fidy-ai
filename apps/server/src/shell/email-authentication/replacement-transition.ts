import { timingSafeEqual } from "node:crypto";
import { Crypto, DateTime, Effect, Option, Redacted, Schema, Struct } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import {
  EmailAddress,
  EmailDeliveryIntentId,
  EmailReplacementWorkflow,
  EmailReplacementWorkflowId,
  type EmailVerificationCode,
  EmailVerificationDigest,
  EmailVerificationProof,
  EmailVerificationPublicCode,
} from "~/core/email-authentication/model";
import {
  decideEmailReplacementRequest,
  decideProofAttempt,
  emailWorkflowExpiry,
  formatEmailCode,
  resendAvailability,
  selectEmailCodeSymbols,
} from "~/core/email-authentication/rules";
import type { UserId } from "~/core/identity/reference";
import type { WebSessionId } from "~/core/web-session/reference";
import { withSubjectLock } from "~/shell/consent/repo";
import { advisoryLockKey } from "~/shell/db/advisory-lock";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { lockFreshWebSessionInScope } from "~/shell/web-session/repo";
import { admitEmailDeliveryInScope } from "./admission";
import type { RequestEmailReplacementPayload } from "./operations";
import { acquireEmailVerificationAdmissionInScope } from "./repo";

const workflowPublicSymbolCount = 8;
const groupedCodeSymbolCount = 4;
const publicCodeLength = 9;
const proofOffset = 10;

const ReplacementWorkflowRowBase = EmailReplacementWorkflow.mapFields(Struct.omit(["proofState"]));
const ReplacementWorkflowRow = ReplacementWorkflowRowBase.pipe(
  Schema.fieldsAssign({
    proofDigest: Schema.OptionFromNullOr(EmailVerificationDigest),
    proofExpiresAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  })
).mapFields(
  Struct.evolve({
    startedAt: () => Schema.DateTimeUtcFromDate,
    expiresAt: () => Schema.DateTimeUtcFromDate,
    resendAvailableAt: () => Schema.DateTimeUtcFromDate,
  })
);

const workflowProjection = `workflow.id, workflow.candidate_email_address AS "candidateEmailAddress",
  workflow.public_code AS "publicCode", workflow.started_at AS "startedAt",
  workflow.expires_at AS "expiresAt",
  workflow.delivery_generation AS "deliveryGeneration",
  workflow.resend_available_at AS "resendAvailableAt",
  workflow.proof_digest AS "proofDigest", workflow.proof_expires_at AS "proofExpiresAt",
  workflow.wrong_proof_attempts AS "wrongProofAttempts"`;

const decodeWorkflow = Schema.decodeUnknownSync(Schema.toType(EmailReplacementWorkflow));

const replacementWorkflowFromRow = (
  row: typeof ReplacementWorkflowRow.Type
): EmailReplacementWorkflow => {
  const { proofDigest, proofExpiresAt, ...workflow } = row;
  if (Option.isNone(proofDigest) && Option.isNone(proofExpiresAt)) {
    return decodeWorkflow({ ...workflow, proofState: { _tag: "AwaitingDelivery" } });
  }
  if (Option.isSome(proofDigest) && Option.isSome(proofExpiresAt)) {
    return decodeWorkflow({
      ...workflow,
      proofState: {
        _tag: "AwaitingProof",
        proofDigest: proofDigest.value,
        proofExpiresAt: proofExpiresAt.value,
      },
    });
  }
  throw new Error("Email replacement proof columns violated their database invariant");
};

const findLockedReplacementWorkflow = Effect.fn("EmailReplacementTransition.findLockedWorkflow")(
  function* (userId: UserId) {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: ReplacementWorkflowRow,
      execute: () => sql`
      SELECT ${sql.literal(workflowProjection)} FROM email_replacement_workflows workflow
      WHERE workflow.user_id = ${userId} FOR UPDATE
    `,
    })(undefined).pipe(Effect.orDie, Effect.map(Option.map(replacementWorkflowFromRow)));
  }
);

const findLockedReplacementWorkflowByPublicCode = Effect.fn(
  "EmailReplacementTransition.findLockedWorkflowByPublicCode"
)(function* (userId: UserId, publicCode: string) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: ReplacementWorkflowRow,
    execute: () => sql`
      SELECT ${sql.literal(workflowProjection)} FROM email_replacement_workflows workflow
      WHERE workflow.user_id = ${userId} AND workflow.public_code = ${publicCode} FOR UPDATE
    `,
  })(undefined).pipe(Effect.orDie, Effect.map(Option.map(replacementWorkflowFromRow)));
});

type RequestWorkflowAdmission =
  | Readonly<{ _tag: "Rejected" }>
  | Readonly<{ _tag: "Admitted"; existing: Option.Option<EmailReplacementWorkflow> }>;
const rejectedRequest = (): RequestWorkflowAdmission => ({ _tag: "Rejected" });
const admittedRequest = (
  existing: Option.Option<EmailReplacementWorkflow>
): RequestWorkflowAdmission => ({ _tag: "Admitted", existing });

/** Already-authorized facts required to request one replacement delivery generation. */
type RequestReplacementInput = Readonly<{
  userId: UserId;
  candidateEmail: EmailAddress;
  requestedAt: DateTime.Utc;
}>;

const acquireCandidateLock = Effect.fn("EmailReplacementTransition.acquireCandidateLock")(
  function* (candidateEmail: EmailAddress) {
    const sql = yield* SqlClient.SqlClient;
    const candidateLock = advisoryLockKey.emailReplacementCandidate(candidateEmail);
    yield* sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${candidateLock.value}, ${candidateLock.seed}))
    `.pipe(Effect.orDie);
  }
);

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
  yield* acquireCandidateLock(input.candidateEmail);
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
  const existing = yield* findLockedReplacementWorkflow(input.userId);
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

const persistReplacementGeneration = Effect.fn("EmailAuthentication.persistReplacementGeneration")(
  function* (input: RequestReplacementInput, existing: Option.Option<EmailReplacementWorkflow>) {
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

const requestReplacementInScope = Effect.fn("EmailAuthentication.requestReplacementInScope")(
  function* (input: RequestReplacementInput) {
    const admittedWorkflow = yield* decideLockedReplacementAdmission(input);
    if (admittedWorkflow._tag === "Rejected") return;
    if (
      !(yield* admitEmailDeliveryInScope({
        requester: { _tag: "User", userId: input.userId },
        recipient: input.candidateEmail,
        attemptedAt: input.requestedAt,
      }))
    ) {
      return;
    }
    yield* persistReplacementGeneration(input, admittedWorkflow.existing);
  }
);

/**
 * Requests delivery of a replacement proof for the User and candidate mailbox in the payload.
 * The caller may rely only on the uniform pending response; rejection and admission state are not
 * disclosed, and successful admission persists the next bounded delivery generation.
 */
export const requestEmailReplacement = Effect.fn("EmailReplacementTransition.request")(
  function* (input: { userId: UserId; payload: typeof RequestEmailReplacementPayload.Type }) {
    const requestedAt = yield* DateTime.now;
    yield* withSubjectLock(
      input.userId,
      requestReplacementInScope({
        userId: input.userId,
        candidateEmail: input.payload.candidateEmail,
        requestedAt,
      })
    );
    return { data: { status: "pending" as const }, next: [] };
  }
);

const digestProof = Effect.fn("EmailAuthentication.digestReplacementProof")(function* (
  proof: EmailVerificationProof
) {
  const crypto = yield* Crypto.Crypto;
  return yield* crypto.digest("SHA-256", new TextEncoder().encode(proof)).pipe(Effect.orDie);
});

/** Uniform direct-completion outcome; rejection reveals no workflow or mailbox state. */
export type ReplacementCompletion = "replaced" | "rejected";

type CompleteReplacementInput = Readonly<{
  userId: UserId;
  authorizingWebSessionId: WebSessionId;
  attemptedAt: DateTime.Utc;
  combinedCode: Redacted.Redacted<EmailVerificationCode>;
}>;

const findCompletionWorkflow = Effect.fn("EmailAuthentication.findCompletionWorkflow")(function* (
  input: CompleteReplacementInput
) {
  return yield* findLockedReplacementWorkflowByPublicCode(
    input.userId,
    Redacted.value(input.combinedCode).slice(0, publicCodeLength)
  );
});

const applyCompletionProofAttempt = Effect.fn("EmailAuthentication.applyCompletionProofAttempt")(
  function* (workflow: EmailReplacementWorkflow, input: CompleteReplacementInput) {
    const sql = yield* SqlClient.SqlClient;
    yield* acquireCandidateLock(workflow.candidateEmailAddress);
    if (workflow.proofState._tag === "AwaitingDelivery") return false;
    const proof = EmailVerificationProof.make(
      Redacted.value(input.combinedCode).slice(proofOffset)
    );
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
  workflow: EmailReplacementWorkflow,
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
const completeReplacementInScope = Effect.fn("EmailAuthentication.completeReplacementInScope")(
  function* (input: CompleteReplacementInput) {
    const workflow = yield* findCompletionWorkflow(input);
    if (Option.isNone(workflow)) return "rejected" as const;
    if (!(yield* applyCompletionProofAttempt(workflow.value, input))) return "rejected" as const;
    return (yield* commitReplacement(workflow.value, input)) ? "replaced" : "rejected";
  }
);

/**
 * Attempts replacement for the named User using authority from the named current WebSession and a
 * redacted proof observed at `attemptedAt`. The caller may rely on a uniform rejected result for
 * invalid or absent proof state; stale session authority is reported separately, and success means
 * the credential, constrained lifecycle evidence, and workflow cleanup committed atomically.
 */
export const completeEmailReplacement = Effect.fn("EmailReplacementTransition.complete")(
  function* (input: {
    subjectUserId: UserId;
    authorizingWebSessionId: WebSessionId;
    attemptedAt: DateTime.Utc;
    combinedCode: Redacted.Redacted<EmailVerificationCode>;
  }) {
    return yield* withUserTransaction(
      input.subjectUserId,
      withSubjectLock(
        input.subjectUserId,
        Effect.gen(function* () {
          const sessionRemainsFresh = yield* lockFreshWebSessionInScope({
            webSessionId: input.authorizingWebSessionId,
            subjectUserId: input.subjectUserId,
            attemptedAt: input.attemptedAt,
          });
          if (!sessionRemainsFresh) return "fresh-pairing-required" as const;
          if (!(yield* acquireEmailVerificationAdmissionInScope())) return "rejected" as const;
          return yield* completeReplacementInScope({
            userId: input.subjectUserId,
            authorizingWebSessionId: input.authorizingWebSessionId,
            attemptedAt: input.attemptedAt,
            combinedCode: input.combinedCode,
          });
        })
      )
    );
  }
);
