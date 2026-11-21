import { admitLocalMedia as publishMedia } from "./internal/local-media";
import { drainIngestion } from "./internal/drain-originals";
import { reviewRequest } from "./internal/sample-operator";
import { reviewLocal } from "./internal/sample-review";
import {
  admitLocalEmail as acceptLocalEmail,
  receivePrivateEmail as acceptPrivateEmail,
  processLocalEmail as completeLocalEmail,
} from "./internal/local-email";
import { type ForwardedEmailMessage, type NativeEmailEnvironment } from "./contract";
import { admitLocalDocument as admitDocument } from "./internal/local-document";
import {
  localPendingStatement as pendingStatement,
  localStatementActivity as statementActivity,
} from "./internal/local-statement-work";
import { recoverIngestion, repairIngestionAlarm } from "./internal/local-retention";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Effect } from "effect";

import {
  cloudflareWorkerTelemetry,
  observeWorkerPromise,
  workTraceParent,
  workerRelease,
} from "../runtime/telemetry/operations";
import {
  receiveNativeStatementExtraction as receiveOwnedStatements,
  isStatementExtractionWork as recognizesStatement,
  runStatementExtractionWorkflow,
} from "./internal/statement-delivery";
import {
  receiveForwardedEmailWork as receiveEmailWork,
  isForwardedEmailWork as recognizesEmail,
} from "./internal/forwarded-email-delivery";

export const receiveNativeStatementExtraction: typeof receiveOwnedStatements = (input) =>
  receiveOwnedStatements(input);

export const executeStatementExtraction: typeof runStatementExtractionWorkflow = (input) =>
  runStatementExtractionWorkflow(input);

export const isStatementExtractionWork = (body: unknown): boolean => recognizesStatement(body);

export const receiveForwardedEmailWork: typeof receiveEmailWork = (input) =>
  receiveEmailWork(input);

export const isForwardedEmailWork = (body: unknown): boolean => recognizesEmail(body);

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
