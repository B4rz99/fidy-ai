import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Crypto, Effect } from "effect";
import type { ForwardedEmailEnvironment, ForwardedEmailMessage } from "./contract";
import {
  cloudflareWorkerTelemetry,
  observeWorkerPromise,
  workerRelease,
} from "../runtime/telemetry/operations";
import { captureWorkflowFailure } from "../runtime/operational-health/operations";
import {
  dispatchForwardedEmail as dispatchEmail,
  emailCrypto,
  receiveForwardedEmail as receiveEmail,
  sweepForwardedEmail as retainEmail,
} from "./internal/forwarded-email";
import {
  dispatchStatementExtraction as dispatchStatements,
  receiveStatementExtraction as receiveStatements,
  isStatementExtractionWork as recognizesStatement,
  reconcileStatementExtraction as reconcileStatements,
  runStatementExtractionWorkflow,
} from "./internal/statement-delivery";
import {
  receiveForwardedEmailWork as receiveEmailWork,
  isForwardedEmailWork as recognizesEmail,
} from "./internal/forwarded-email-delivery";
import { StatementStaging } from "./internal/statement-staging";
import { sweepExpiredUploadAdmission as sweepUploadAdmission } from "./internal/statement-ingestion";
import { expireStatementReviewEvidence as expireReview } from "./internal/statement-review-retention";

/** Reoffer bounded committed extraction identities; a Queue offer never authorizes extraction. */
export const dispatchStatementExtraction: typeof dispatchStatements = (input) =>
  dispatchStatements(input);
/** Decode Queue work and check current owner state before handing the stable identity to its Workflow. */
export const receiveStatementExtraction: typeof receiveStatements = (input) =>
  receiveStatements(input);
/** Settle stalled extraction under its existing User coordinator, retaining visible partial accounting. */
export const reconcileStatementExtraction: typeof reconcileStatements = (input) =>
  reconcileStatements(input);
/** Execute the existing bounded, versioned activities without retaining financial content in history. */
export const executeStatementExtraction: typeof runStatementExtractionWorkflow = (input) =>
  runStatementExtractionWorkflow(input);
/** Select the statement protocol without treating a Queue identity as authority. */
export const isStatementExtractionWork = (body: unknown): boolean => recognizesStatement(body);
/** Route decoded receipt identity to its User coordinator; failed handoff remains retryable. */
export const receiveForwardedEmailWork: typeof receiveEmailWork = (input) =>
  receiveEmailWork(input);
/** Select the forwarded-email protocol without granting permission to read its material. */
export const isForwardedEmailWork = (body: unknown): boolean => recognizesEmail(body);
/** Build only bounded retention activities; raw R2 reads and staging repositories remain private. */
export const statementRetention = (
  input: Readonly<{ database: D1Database; bucket: R2Bucket; nowEpochMs: () => number }>
): Readonly<{
  expireSubmissions: Effect.Effect<void, void>;
  sweepStaging: Effect.Effect<void, void>;
}> => {
  const staging = StatementStaging.make(input);
  return {
    expireSubmissions: staging.expireStatementSubmissions.pipe(
      Effect.asVoid,
      Effect.mapError(() => undefined)
    ),
    sweepStaging: staging.sweepExpiredStatementStaging.pipe(
      Effect.asVoid,
      Effect.mapError(() => undefined)
    ),
  };
};

type StatementCoordinator = Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;

/** Cloudflare stores only the bounded work identity and the named activity outcome. */
export class StatementExtractionWorkflowV1 extends WorkflowEntrypoint<
  Readonly<{ USER_TRANSACTION_COORDINATOR: StatementCoordinator; DB: D1Database }>,
  unknown
> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    return captureWorkflowFailure({
      work: observeWorkerPromise(
        () =>
          runStatementExtractionWorkflow({
            payload: event.payload,
            coordinator: this.env.USER_TRANSACTION_COORDINATOR,
            activity: (name, options, run) => step.do(name, options, run),
          }),
        {
          environment: workerRelease(this.env),
          telemetry: cloudflareWorkerTelemetry,
          operation: "workflow.statementExtraction",
        }
      ),
      db: this.env.DB,
    });
  }
}

/** Admit forwarded material only through the Email Worker, retaining the owner's bounded byte and Consent checks. */
export const receiveForwardedEmail = ({
  message,
  environment,
}: Readonly<{
  message: ForwardedEmailMessage;
  environment: ForwardedEmailEnvironment;
}>): Effect.Effect<void, Effect.Error<ReturnType<typeof receiveEmail>>> =>
  receiveEmail(message, environment).pipe(
    Effect.withSpan("forwarded-email.receive"),
    Effect.provideService(Crypto.Crypto, emailCrypto)
  );

/** Reoffer only retained same-User receipt identities; an offer grants no processing authority. */
export const dispatchForwardedEmail: typeof dispatchEmail = (environment) =>
  dispatchEmail(environment);

/** Expire private bytes and retain only the owner's bounded replay/review evidence. */
export const sweepForwardedEmail: typeof retainEmail = (environment) => retainEmail(environment);

/** Remove only expired Ingestion upload-admission records; live spend and other owners remain intact. now is the decision instant in Unix epoch milliseconds. */
export const sweepExpiredUploadAdmission: typeof sweepUploadAdmission = (input) =>
  sweepUploadAdmission(input);

/** Clear expired personal review evidence while retaining classification and conserved accounting. */
export const expireStatementReviewEvidence: typeof expireReview = (input) => expireReview(input);
