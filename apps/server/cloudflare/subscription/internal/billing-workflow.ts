import { routeBillingEvent } from "./native-billing";
import { WompiEnvironment } from "../../../src/shell/secret-material/contract";
import { verifiedWompiEventHint } from "./wompi-event";
import { Effect, Exit, Option, Schema } from "effect";
import { type WompiTransportFactory } from "./wompi-runtime";
import {
  BillingCollectionFailure,
  type BillingWorkflowActivity,
  type BillingWorkflowEnvironment,
  LocalBillingCollection,
  LocalSourceCancellationWork,
  SubscriptionCancellationWork,
  WompiBillingEvent,
  type WompiEventEnvironment,
  collectUserBillingUrl,
} from "../contract";

import { runLocalCancellationLoop } from "./billing-observation";

export const isBillingCollectionWork = (body: unknown): boolean =>
  Option.isSome(
    Schema.decodeUnknownOption(
      Schema.Union([SubscriptionCancellationWork, LocalSourceCancellationWork])
    )(body)
  );

const failure = (cause: Option.Option<unknown> = Option.none()): BillingCollectionFailure =>
  new BillingCollectionFailure({ cause });

const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, BillingCollectionFailure> =>
  Effect.tryPromise({ try: run, catch: (cause) => failure(Option.some(cause)) });

const configuredEventEnvironment = (
  env: WompiEventEnvironment
): Option.Option<WompiEnvironment> => {
  const selected = Schema.decodeUnknownOption(WompiEnvironment)(env.WOMPI_ENVIRONMENT);

  return Option.filter(selected, (scope) =>
    env.WOMPI_EVENT_SECRET.startsWith(scope === "sandbox" ? "test_events_" : "prod_events_")
  );
};

export const receiveWompiBillingEvent = (
  input: Readonly<{
    request: Request;
    environment: WompiEventEnvironment;
  }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const configured = configuredEventEnvironment(input.environment);

    if (Option.isNone(configured)) return new Response(null, { status: 503 });

    const verified = yield* Effect.exit(
      verifiedWompiEventHint({
        request: input.request,
        secret: input.environment.WOMPI_EVENT_SECRET,
        environment: configured.value,
      })
    );

    if (Exit.isFailure(verified) || Option.isNone(verified.value)) {
      return new Response(null, { status: 400 });
    }

    const queue = input.environment.BILLING_COLLECTION_QUEUE;

    if (queue === undefined) return new Response(null, { status: 503 });

    const event = WompiBillingEvent.makeOption({
      environment: configured.value,
      ...verified.value.value,
    });

    if (Option.isNone(event)) return new Response(null, { status: 400 });
    const accepted = yield* Effect.exit(attempt(() => queue.send(event.value)));

    if (Exit.isFailure(accepted)) return new Response(null, { status: 503 });

    return new Response(null, { status: 200 });
  });

type BillingWorkflowExecution = Readonly<{
  environment: BillingWorkflowEnvironment;
  payload: unknown;
  activity: BillingWorkflowActivity;
  observe: Option.Option<BillingWorkflowActivity<boolean>>;
  sleep: (name: string, duration: number) => Promise<void>;
  wompiHttp: WompiTransportFactory;
}>;

export const runBillingCollectionWorkflow = (input: BillingWorkflowExecution): Promise<void> => {
  const event = Schema.decodeUnknownOption(WompiBillingEvent)(input.payload);

  if (Option.isSome(event)) {
    const work = event.value;

    return input.activity(
      "verify-wompi-callback",
      { retries: { limit: 7, delay: "1 minute", backoff: "constant" } },
      () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const { DIRECTORY, USER_STORE } = input.environment;

            const configured = yield* Schema.decodeUnknownEffect(WompiEnvironment)(
              input.environment.WOMPI_ENVIRONMENT
            );

            if (DIRECTORY === undefined || USER_STORE === undefined) return yield* failure();
            yield* routeBillingEvent(
              work,
              { ...input.environment, DIRECTORY, USER_STORE, WOMPI_ENVIRONMENT: configured },
              input.wompiHttp
            );
          })
        )
    );
  }

  const native = Schema.decodeUnknownOption(LocalBillingCollection)(input.payload);

  if (Option.isSome(native)) {
    const work = native.value;

    return input.activity(
      "collect-user-billing",
      { retries: { limit: 7, delay: "1 minute", backoff: "constant" } },
      () => {
        const owners = input.environment.USER_STORE;

        if (owners === undefined) return Promise.reject(new Error("User store unavailable"));

        return owners
          .getByName(work.userId)
          .fetch(collectUserBillingUrl, { method: "POST", body: JSON.stringify(work) })
          .then((reply) => {
            if (!reply.ok) throw new Error("Billing collection unavailable");
          });
      }
    );
  }

  const cancellation = Schema.decodeUnknownOption(LocalSourceCancellationWork)(input.payload);

  return Option.isSome(cancellation)
    ? runLocalCancellationLoop({ ...input, work: cancellation.value })
    : Promise.reject(Error("Unknown native billing work"));
};
