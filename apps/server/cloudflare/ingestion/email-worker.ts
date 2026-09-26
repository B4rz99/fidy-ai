import { Crypto, Effect } from "effect";
import {
  type ForwardedEmailEnvironment,
  type ForwardedEmailMessage,
  dispatchForwardedEmail,
  emailCrypto,
  receiveForwardedEmail,
  sweepForwardedEmail,
} from "./forwarded-email";

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
        yield* sweepForwardedEmail(environment).pipe(Effect.withSpan("forwarded-email.sweep"));
        yield* dispatchForwardedEmail(environment).pipe(
          Effect.withSpan("forwarded-email.dispatch")
        );
      })
    ),
};
