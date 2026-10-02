import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Crypto, Data, Effect, Exit } from "effect";
import type { TelemetryService } from "@fidy/server/telemetry";
import type { ForwardedEmailEnvironment, ForwardedEmailMessage } from "./contract";
import {
  cloudflareWorkerTelemetry,
  observeWorkerExecution,
  observeWorkerPromise,
  workerRelease,
} from "../runtime/telemetry";
import { captureWorkflowFailure } from "../runtime/operational-workflow-failure";
import {
  dispatchForwardedEmail,
  emailCrypto,
  receiveForwardedEmail,
  sweepForwardedEmail,
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

class EmailScheduleUnavailable extends Data.TaggedError("EmailScheduleUnavailable") {}

type EmailWorker = Readonly<{
  email: (message: ForwardedEmailMessage, environment: ForwardedEmailEnvironment) => Promise<void>;
  scheduled: (controller: unknown, environment: ForwardedEmailEnvironment) => Promise<void>;
}>;

export const makeEmailWorker = (telemetry: TelemetryService): EmailWorker => ({
  email: (message: ForwardedEmailMessage, environment: ForwardedEmailEnvironment): Promise<void> =>
    Effect.runPromise(
      receiveForwardedEmail(message, environment).pipe(
        Effect.withSpan("forwarded-email.receive"),
        Effect.provideService(Crypto.Crypto, emailCrypto),
        observeWorkerExecution({
          telemetry,
          environment: workerRelease(environment),
          operation: "worker.email.receive",
        })
      )
    ),
  scheduled: (_controller: unknown, environment: ForwardedEmailEnvironment): Promise<void> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sweep = yield* Effect.exit(
          sweepForwardedEmail(environment).pipe(Effect.withSpan("forwarded-email.sweep"))
        );
        const dispatch = yield* Effect.exit(
          dispatchForwardedEmail(environment).pipe(Effect.withSpan("forwarded-email.dispatch"))
        );
        if (Exit.isFailure(sweep) || Exit.isFailure(dispatch)) {
          return yield* new EmailScheduleUnavailable();
        }
      }).pipe(
        observeWorkerExecution({
          telemetry,
          environment: workerRelease(environment),
          operation: "worker.email.scheduled",
        })
      )
    ),
});
