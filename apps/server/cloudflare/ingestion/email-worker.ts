import { Crypto, Data, Effect, Exit } from "effect";
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
export default {
  email: (message: ForwardedEmailMessage, environment: ForwardedEmailEnvironment): Promise<void> =>
    Effect.runPromise(
      receiveForwardedEmail(message, environment).pipe(
        Effect.withSpan("forwarded-email.receive"),
        Effect.provideService(Crypto.Crypto, emailCrypto)
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
      })
    ),
};
