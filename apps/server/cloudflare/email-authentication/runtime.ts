import { checkLoginMailbox, startLoginEmail } from "./internal/login-admission";
import { verifyLoginEmail } from "./internal/login-completion";
import { deliverPendingReplacement as deliverLocal } from "./internal/native-mail-delivery";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Effect, Option, Schema } from "effect";
import {
  NativeLoginEmailWork,
  loginCheckUrl,
  loginDeliverUrl,
  loginStartUrl,
  loginVerifyUrl,
} from "./contract";
import {
  deliverLoginEmail as deliverLogin,
  offerLoginEmail as offerLogin,
  repairLoginAlarm as repairLogin,
  runLoginDelivery,
  startLoginWorkflow as startWorkflow,
} from "./internal/login-delivery";
import type {
  BrowserPairingEmailEnvironment,
  BrowserPairingEmailPublisher,
  EmailPublication,
  EmailReplacementEnvironment,
  EmailReplacementPublisher,
  EmailWorkflowInput,
} from "./contract";
import {
  cloudflareWorkerTelemetry,
  observeWorkerPromise,
  workTraceParent,
  workerRelease,
} from "../runtime/telemetry/operations";
import {
  dispatchBrowserPairingEmail as dispatchPairing,
  receiveBrowserPairingEmail as receivePairing,
  isBrowserPairingEmailWork as recognizesPairing,
  reconcileBrowserPairingEmail as reconcilePairing,
  runBrowserPairingEmailWorkflow as runPairing,
} from "./internal/browser-pairing-workflow";
import {
  dispatchEmailReplacement as dispatchReplacement,
  receiveEmailReplacement as receiveReplacement,
  isEmailReplacementWork as recognizesReplacement,
  reconcileEmailReplacement as reconcileReplacement,
  runEmailReplacementWorkflow as runReplacement,
} from "./internal/replacement-workflow";

export const dispatchBrowserPairingEmail = (
  input: Readonly<{ DB: D1Database; BROWSER_PAIRING_EMAIL_QUEUE: BrowserPairingEmailPublisher }> &
    EmailPublication
): Effect.Effect<void, void> => dispatchPairing(input);

export const receiveBrowserPairingEmail =
  (environment: Pick<BrowserPairingEmailEnvironment, "DB" | "BROWSER_PAIRING_EMAIL_WORKFLOW">) =>
  (batch: MessageBatch<unknown>): Effect.Effect<void, void> =>
    receivePairing(environment)(batch);

export const reconcileBrowserPairingEmail = (db: D1Database): Effect.Effect<void, void> =>
  reconcilePairing(db);

export const runBrowserPairingEmailWorkflow = (input: EmailWorkflowInput): Promise<void> =>
  runPairing(input);

export const isBrowserPairingEmailWork = (value: unknown): boolean => recognizesPairing(value);
export const offerLoginEmail: typeof offerLogin = (...args) => offerLogin(...args);
export const repairLoginAlarm: typeof repairLogin = (...args) => repairLogin(...args);
export const localLoginEmailRequest = Effect.fn(function* ({
  request,
  environment,
  storage,
  owns,
}: Readonly<{
  request: Request;
  environment: { DIRECTORY: DurableObjectNamespace; RESEND_API_KEY: string };
  storage: DurableObjectStorage;
  owns: (id: string) => boolean;
}>) {
  switch (request.url) {
    case loginCheckUrl:
      return yield* checkLoginMailbox(request, owns);
    case loginStartUrl:
      return yield* startLoginEmail({ request, directory: environment.DIRECTORY, storage, owns });
    case loginVerifyUrl:
      return yield* verifyLoginEmail(request, owns);
    case loginDeliverUrl:
      return yield* deliverLogin(request, environment, owns);
    default:
      return new Response(null, { status: 404 });
  }
});
export const startLoginWorkflow: typeof startWorkflow = (...args) => startWorkflow(...args);

export class BrowserPairingEmailWorkflowV1 extends WorkflowEntrypoint<
  { USER_STORE: DurableObjectNamespace },
  unknown
> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    const work = Schema.decodeUnknownOption(NativeLoginEmailWork)(event.payload);
    if (Option.isNone(work)) return Promise.resolve();
    return observeWorkerPromise(
      () =>
        step.do("send-browser-pairing-email-v2", { retries: { limit: 0, delay: "1 second" } }, () =>
          Effect.runPromise(runLoginDelivery(this.env.USER_STORE, work.value))
        ),
      {
        environment: workerRelease(this.env),
        telemetry: cloudflareWorkerTelemetry,
        operation: "workflow.browserPairingEmail",
        parent: workTraceParent(event.payload),
      }
    );
  }
}

export const dispatchEmailReplacement = (
  input: Readonly<{ DB: D1Database; EMAIL_REPLACEMENT_QUEUE: EmailReplacementPublisher }> &
    EmailPublication
): Effect.Effect<void, void> => dispatchReplacement(input);

export const receiveEmailReplacement =
  (environment: Pick<EmailReplacementEnvironment, "DB" | "EMAIL_REPLACEMENT_WORKFLOW">) =>
  (batch: MessageBatch<unknown>): Effect.Effect<void, void> =>
    receiveReplacement(environment)(batch);

export const reconcileEmailReplacement = (db: D1Database): Effect.Effect<void, void> =>
  reconcileReplacement(db);

export const runEmailReplacementWorkflow = (input: EmailWorkflowInput): Promise<void> =>
  runReplacement(input);

export const isEmailReplacementWork = (value: unknown): boolean => recognizesReplacement(value);
export const deliverPendingReplacement: typeof deliverLocal = (...args) => deliverLocal(...args);
