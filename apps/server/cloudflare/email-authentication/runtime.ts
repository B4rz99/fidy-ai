import { checkLoginMailbox, startLoginEmail } from "./internal/login-admission";
import { verifyLoginEmail } from "./internal/login-completion";
import { deliverPendingReplacement as deliverLocal } from "./internal/native-mail-delivery";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
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
import {
  cloudflareWorkerTelemetry,
  observeWorkerPromise,
  workTraceParent,
  workerRelease,
} from "../runtime/telemetry/operations";
import { isBrowserPairingEmailWork as recognizesPairing } from "./internal/browser-pairing-workflow";
import { isEmailReplacementWork as recognizesReplacement } from "./internal/replacement-workflow";

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

const deliveryRuntime = ManagedRuntime.make(Layer.empty);

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
          deliveryRuntime.runPromise(runLoginDelivery(this.env.USER_STORE, work.value))
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

export const isEmailReplacementWork = (value: unknown): boolean => recognizesReplacement(value);

export const deliverPendingReplacement: typeof deliverLocal = (...args) => deliverLocal(...args);
