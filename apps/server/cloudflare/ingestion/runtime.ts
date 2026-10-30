import { sweepReviewDrafts as sweepDrafts } from "./internal/review-retention";
import { projections as erasureProjections } from "./internal/erasure";
import { makeErasureStore } from "../erasure-store/runtime";
import { withPublicationWake } from "./internal/publication-wake";
import type { ErasureStore } from "../erasure-store/contract";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Crypto, Effect, Option } from "effect";
import type { UserId } from "../../src/core/identity/contract";
import type {
  ForwardedEmailEnvironment,
  ForwardedEmailMessage,
  ReviewRetentionWork,
  ReviewUnavailable,
  StatementDeliveryUnavailable,
  StatementDispatchBindings,
} from "./contract";
import {
  cloudflareWorkerTelemetry,
  observeWorkerPromise,
  workTraceParent,
  workerRelease,
} from "../runtime/telemetry/operations";
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
import { sweepMedia } from "./internal/media-retention";
import { expireStatementReviewEvidence as expireReview } from "./internal/statement-review-retention";

/** Bounded inactive-User cleanup of expired media locators, held capacity and aged accountability. */
export const sweepMediaSubmissions: typeof sweepMedia = (input) => sweepMedia(input);

/** Reoffer committed extraction identities directly to their Workflow, with Queue fallback. */
export const dispatchStatementExtraction = (
  input: StatementDispatchBindings
): Effect.Effect<void, StatementDeliveryUnavailable> =>
  dispatchStatements({ ...input, userId: Option.none() });

/** A User's durable alarm discovers only that User's retained publication intents. */
export const dispatchUserStatementExtraction = (
  input: StatementDispatchBindings & Readonly<{ userId: UserId }>
): Effect.Effect<void, StatementDeliveryUnavailable> =>
  dispatchStatements({ ...input, userId: Option.some(input.userId) });

/** Supply a coordinator-owned durable wake-up; absent or failed wake-ups retain cron recovery. */
export const withStatementPublicationWake: typeof withPublicationWake = (schedule) =>
  withPublicationWake(schedule);
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
    return observeWorkerPromise(
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
        parent: workTraceParent(event.payload),
      }
    );
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

export const sweepReviewDrafts = (
  input: ReviewRetentionWork
): Effect.Effect<void, ReviewUnavailable> => sweepDrafts(input);
export const makeIngestionErasureStores = (db: D1Database): ReadonlyArray<ErasureStore> =>
  erasureProjections.map((projection) => makeErasureStore({ db, projection }));
