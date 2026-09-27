import { Data, Effect, Exit, Option, Schema } from "effect";

class ForwardedEmailDeliveryUnavailable extends Data.TaggedError(
  "ForwardedEmailDeliveryUnavailable"
)<{
  readonly cause: unknown;
}> {}

/** Versioned, secret-free identity from the private forwarded-email Queue. */
export const ForwardedEmailWork = Schema.Struct({
  receiptId: Schema.String.check(Schema.isUUID()),
  userId: Schema.String.check(Schema.isUUID()),
});

/** Route only decoded work to its User coordinator. No Queue identity conveys authority: the
 * coordinator rechecks ownership, Consent, retention, and the outcome before reading R2.
 * A failed coordinator call rejects for Queue redelivery; cron also reoffers unsettled receipts.
 */
export const receiveForwardedEmailWork = ({
  messages,
  coordinator,
}: Readonly<{
  messages: ReadonlyArray<Readonly<{ body: unknown; ack: () => void }>>;
  coordinator: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
}>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const outcomes = yield* Effect.forEach(
        messages,
        (message) =>
          Effect.exit(
            Effect.gen(function* () {
              const work = Schema.decodeUnknownOption(ForwardedEmailWork)(message.body);
              if (Option.isNone(work)) {
                message.ack();
                return;
              }
              const body = yield* Schema.encodeEffect(Schema.fromJsonString(ForwardedEmailWork))(
                work.value
              );
              const response = yield* Effect.tryPromise({
                try: (signal) =>
                  coordinator.getByName(work.value.userId).fetch(
                    new Request("https://coordinator.internal/forwarded-email-work", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body,
                      signal,
                    })
                  ),
                catch: (cause) => new ForwardedEmailDeliveryUnavailable({ cause }),
              });
              if (!response.ok) {
                return yield* new ForwardedEmailDeliveryUnavailable({
                  cause: new Error("Forwarded email coordinator unavailable"),
                });
              }
              message.ack();
            })
          ),
        { concurrency: "unbounded" }
      );
      for (const outcome of outcomes) {
        if (Exit.isFailure(outcome)) return yield* Effect.failCause(outcome.cause);
      }
    })
  ).catch((error: unknown) => {
    if (error instanceof ForwardedEmailDeliveryUnavailable) throw error.cause;
    throw error;
  });

/** Recognize a versioned identity-only Queue message before routing to User coordination. */
export const isForwardedEmailWork = (body: unknown): boolean =>
  Option.isSome(Schema.decodeUnknownOption(ForwardedEmailWork)(body));
