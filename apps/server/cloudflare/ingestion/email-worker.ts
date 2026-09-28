import { Crypto, Data, Effect, Exit } from "effect";
import { type TelemetryService } from "@fidy/server/telemetry";
import {
  cloudflareWorkerTelemetry,
  observeWorkerExecution,
  workerRelease,
} from "../runtime/telemetry";
import {
  type ForwardedEmailEnvironment,
  type ForwardedEmailMessage,
  dispatchForwardedEmail,
  emailCrypto,
  receiveForwardedEmail,
  sweepForwardedEmail,
} from "./forwarded-email";

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

export default makeEmailWorker(cloudflareWorkerTelemetry);
