import { sanitizeWorkTrace, workTraceHeaders } from "../../runtime/telemetry/operations";
import { ForwardedEmailWork } from "../contract";
import { Data, Effect, Exit, Layer, ManagedRuntime, Option, Schema } from "effect";

const boundaryRuntime = ManagedRuntime.make(Layer.empty);

const coordinatorDeliveryConcurrency = 4;

class ForwardedEmailDeliveryUnavailable extends Data.TaggedError(
  "ForwardedEmailDeliveryUnavailable"
)<{
  readonly cause: unknown;
}> {}

export const receiveForwardedEmailWork = ({
  messages,
  coordinator,
}: Readonly<{
  messages: ReadonlyArray<Readonly<{ body: unknown; ack: () => void }>>;
  coordinator: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
}>): Promise<void> =>
  boundaryRuntime
    .runPromise(
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

                const payload = yield* sanitizeWorkTrace(work.value);
                const traceHeaders = yield* workTraceHeaders(payload);

                const body = yield* Schema.encodeEffect(Schema.fromJsonString(ForwardedEmailWork))(
                  payload
                );

                const response = yield* Effect.tryPromise({
                  try: (signal) =>
                    coordinator.getByName(work.value.userId).fetch(
                      new Request("https://coordinator.internal/forwarded-email-work", {
                        method: "POST",
                        headers: { "content-type": "application/json", ...traceHeaders },
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
          { concurrency: coordinatorDeliveryConcurrency }
        );

        yield* Effect.forEach(
          outcomes,
          Effect.fnUntraced(function* (outcome) {
            if (Exit.isFailure(outcome)) return yield* Effect.failCause(outcome.cause);
          }),
          { discard: true }
        );
      })
    )
    .catch((error: unknown) => {
      if (Schema.is(Schema.instanceOf(ForwardedEmailDeliveryUnavailable))(error)) throw error.cause;
      throw error;
    });

export const isForwardedEmailWork = (body: unknown): boolean =>
  Option.isSome(Schema.decodeUnknownOption(ForwardedEmailWork)(body));
