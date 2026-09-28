import { Crypto, Data, Effect, Exit, Option, Schema } from "effect";
import { type TelemetryService } from "@fidy/server/telemetry";
import { cloudflareWorkerTelemetry, observeWorkerExecution } from "../runtime/telemetry";
import {
  type ForwardedEmailEnvironment,
  type ForwardedEmailMessage,
  dispatchForwardedEmail,
  emailCrypto,
  receiveForwardedEmail,
  sweepForwardedEmail,
} from "./forwarded-email";

class EmailScheduleUnavailable extends Data.TaggedError("EmailScheduleUnavailable") {}

/** Dedicated Email Routing target: no fetch handler and no public HTTP ingress. */
const releaseOf = (environment: ForwardedEmailEnvironment): string =>
  Option.getOrElse(
    Schema.decodeUnknownOption(Schema.Struct({ RELEASE_GIT_SHA: Schema.String }))(environment),
    () => ({ RELEASE_GIT_SHA: "" })
  ).RELEASE_GIT_SHA;

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
          environment: { RELEASE_GIT_SHA: releaseOf(environment) },
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
          environment: { RELEASE_GIT_SHA: releaseOf(environment) },
          operation: "worker.email.scheduled",
        })
      )
    ),
});

export default makeEmailWorker(cloudflareWorkerTelemetry);
