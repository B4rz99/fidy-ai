import { admitLocalMedia as publishMedia } from "./internal/local-media";
import { drainIngestion } from "./internal/drain-originals";
import { reviewRequest } from "./internal/sample-operator";
import { reviewLocal } from "./internal/sample-review";
import {
  admitLocalEmail as acceptLocalEmail,
  receivePrivateEmail as acceptPrivateEmail,
  processLocalEmail as completeLocalEmail,
} from "./internal/local-email";
import {
  type ForwardedEmailMessage,
  type NativeEmailEnvironment,
  type ReviewRetentionWork,
  type ReviewUnavailable,
  type StatementDeliveryUnavailable,
  type StatementDispatchBindings,
} from "./contract";
import { admitLocalDocument as admitDocument } from "./internal/local-document";
import {
  localPendingStatement as pendingStatement,
  localStatementActivity as statementActivity,
} from "./internal/local-statement-work";
import { recoverIngestion, repairIngestionAlarm } from "./internal/local-retention";
import { sweepReviewDrafts as sweepDrafts } from "./internal/review-retention";
import { projections as erasureProjections } from "./internal/erasure";
import { makeErasureStore } from "../erasure-store/runtime";
import { withPublicationWake } from "./internal/publication-wake";
import type { ErasureStore } from "../erasure-store/contract";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Cause, Effect, Exit, Option } from "effect";
import type { UserId } from "../../src/core/identity/contract";

import {
  cloudflareWorkerTelemetry,
  observeWorkerPromise,
  workTraceParent,
  workerRelease,
} from "../runtime/telemetry/operations";
import {
  dispatchStatementExtraction as dispatchStatements,
  receiveNativeStatementExtraction as receiveOwnedStatements,
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

export const sweepMediaSubmissions: typeof sweepMedia = (input) => sweepMedia(input);

export const dispatchStatementExtraction = (
  input: StatementDispatchBindings
): Effect.Effect<void, StatementDeliveryUnavailable> =>
  dispatchStatements({ ...input, userId: Option.none() });

export const dispatchUserStatementExtraction = (
  input: StatementDispatchBindings & Readonly<{ userId: UserId }>
): Effect.Effect<void, StatementDeliveryUnavailable> =>
  dispatchStatements({ ...input, userId: Option.some(input.userId) });

export const recoverUserStatementExtraction = (
  input: StatementDispatchBindings &
    Readonly<{
      userId: UserId;
      USER_TRANSACTION_COORDINATOR: Parameters<
        typeof reconcileStatements
      >[0]["USER_TRANSACTION_COORDINATOR"];
    }>
): Effect.Effect<void, StatementDeliveryUnavailable> =>
  Effect.gen(function* () {
    const reconciliation = yield* Effect.exit(
      Option.match(input.STATEMENT_EXTRACTION_WORKFLOW, {
        onNone: () => Effect.void,
        onSome: (workflow) =>
          reconcileStatements({
            ...input,
            userId: Option.some(input.userId),
            STATEMENT_EXTRACTION_WORKFLOW: workflow,
          }),
      })
    );
    if (Exit.isFailure(reconciliation) && Cause.hasInterrupts(reconciliation.cause)) {
      return yield* Effect.failCause(reconciliation.cause);
    }
    const dispatch = yield* Effect.exit(dispatchUserStatementExtraction(input));
    if (Exit.isFailure(dispatch)) return yield* Effect.failCause(dispatch.cause);
    if (Exit.isFailure(reconciliation)) return yield* Effect.failCause(reconciliation.cause);
  });

export const withStatementPublicationWake: typeof withPublicationWake = (schedule) =>
  withPublicationWake(schedule);

export const receiveStatementExtraction: typeof receiveStatements = (input) =>
  receiveStatements(input);
export const receiveNativeStatementExtraction: typeof receiveOwnedStatements = (input) =>
  receiveOwnedStatements(input);

export const reconcileStatementExtraction: typeof reconcileStatements = (input) =>
  reconcileStatements(input);

export const executeStatementExtraction: typeof runStatementExtractionWorkflow = (input) =>
  runStatementExtractionWorkflow(input);

export const isStatementExtractionWork = (body: unknown): boolean => recognizesStatement(body);

export const receiveForwardedEmailWork: typeof receiveEmailWork = (input) =>
  receiveEmailWork(input);

export const isForwardedEmailWork = (body: unknown): boolean => recognizesEmail(body);

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

export class StatementExtractionWorkflowV1 extends WorkflowEntrypoint<
  Readonly<{ USER_STORE: StatementCoordinator }>,
  unknown
> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    return observeWorkerPromise(
      () =>
        runStatementExtractionWorkflow({
          payload: event.payload,
          coordinator: this.env.USER_STORE,
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

export const receiveForwardedEmail = ({
  message,
  environment,
}: Readonly<{
  message: ForwardedEmailMessage;
  environment: NativeEmailEnvironment;
}>): ReturnType<typeof acceptPrivateEmail> =>
  acceptPrivateEmail(message, environment).pipe(Effect.withSpan("forwarded-email.receive"));

export const sweepExpiredUploadAdmission: typeof sweepUploadAdmission = (input) =>
  sweepUploadAdmission(input);

export const expireStatementReviewEvidence: typeof expireReview = (input) => expireReview(input);

export const sweepReviewDrafts = (
  input: ReviewRetentionWork
): Effect.Effect<void, ReviewUnavailable> => sweepDrafts(input);
export const makeIngestionErasureStores = (db: D1Database): ReadonlyArray<ErasureStore> =>
  erasureProjections.map((projection) => makeErasureStore({ db, projection }));

export const admitLocalDocument: typeof admitDocument = (...args) => admitDocument(...args);
export const localPendingStatement: typeof pendingStatement = (...args) =>
  pendingStatement(...args);
export const localStatementActivity: typeof statementActivity = (...args) =>
  statementActivity(...args);
export const recoverLocalIngestion: typeof recoverIngestion = (...args) =>
  recoverIngestion(...args);
export const repairLocalIngestionAlarm: typeof repairIngestionAlarm = (...args) =>
  repairIngestionAlarm(...args);

export const admitLocalEmail: typeof acceptLocalEmail = (...args) => acceptLocalEmail(...args);
export const processLocalEmail: typeof completeLocalEmail = (...args) =>
  completeLocalEmail(...args);

export const drainLocalIngestion: typeof drainIngestion = (...args) => drainIngestion(...args);
export const handleSampleReview: typeof reviewRequest = (...args) => reviewRequest(...args);
export const localSampleReview: typeof reviewLocal = (...args) => reviewLocal(...args);

export const admitLocalMedia: typeof publishMedia = (input) => publishMedia(input);
