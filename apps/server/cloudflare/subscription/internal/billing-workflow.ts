import { routeBillingEvent } from "./native-billing";
import { UserId } from "../../../src/core/identity/contract";
import { captureWorkTrace } from "../../runtime/telemetry/operations";
import { WompiEnvironment } from "../../../src/shell/secret-material/contract";
import { BillingAttemptId } from "../../../src/core/subscription/contract";
import { verifiedWompiEventHint } from "./wompi-event";
import { Clock, Effect, Exit, Option, Schema } from "effect";
import { type WompiTransportFactory } from "./wompi-runtime";
import {
  BillingCollectionFailure,
  type BillingObservationWorkflow,
  type BillingRuntime,
  type BillingWorkRouting,
  type BillingWorkflowActivity,
  LocalBillingCollection,
  LocalSourceCancellationWork,
  SubscriptionCancellationWork,
  WompiBillingEvent,
  type WompiEventEnvironment,
  collectUserBillingUrl,
} from "../contract";

import {
  receiveLocalSourceCancellation,
  receiveSourceCancellation,
  runBillingObservation,
} from "./billing-observation";

type CollectionQueue = Readonly<{
  send: (work: typeof LocalBillingCollection.Type) => Promise<unknown>;
}>;
type CollectionWorkflow = BillingObservationWorkflow;
/** Identify this Queue payload without interpreting any provider data as authority. */
export const isBillingCollectionWork = (body: unknown): boolean =>
  Option.isSome(
    Schema.decodeUnknownOption(
      Schema.Union([SubscriptionCancellationWork, LocalSourceCancellationWork])
    )(body)
  );
const pendingBatchSize = 32;
const dispatchCooldownMs = 60_000;
const failure = (cause: Option.Option<unknown> = Option.none()): BillingCollectionFailure =>
  new BillingCollectionFailure({ cause });
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, BillingCollectionFailure> =>
  Effect.tryPromise({ try: run, catch: (cause) => failure(Option.some(cause)) });
const decode = <A, E>(
  schema: Schema.Codec<A, E>,
  value: unknown
): Effect.Effect<A, BillingCollectionFailure> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => failure(Option.some(cause)))
  );

const publishBillingEntry = (
  input: Readonly<{
    environment: Readonly<{ DB: D1Database; BILLING_COLLECTION_QUEUE: CollectionQueue }>;
    entry: { readonly attempt_id: BillingAttemptId; readonly user_id: UserId };
    now: number;
  }>
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const trace = yield* captureWorkTrace;
    const { environment, entry, now } = input;
    const claimed = yield* Effect.exit(
      attempt(() =>
        environment.DB.prepare(`UPDATE billing_attempts AS billing_collection_work SET collection_last_attempt_at_ms = ? WHERE collection_state IS NOT NULL AND id = ?
      AND (collection_last_attempt_at_ms IS NULL OR collection_last_attempt_at_ms < ?)`)
          .bind(now, entry.attempt_id, now - dispatchCooldownMs)
          .run()
      )
    );
    if (Exit.isFailure(claimed)) return false;
    if (claimed.value.meta.changes !== 1) return true;
    const offered = yield* Effect.exit(
      attempt(() =>
        environment.BILLING_COLLECTION_QUEUE.send({
          ...trace,
          _tag: "CollectUserBillingAttempt",
          userId: entry.user_id,
          attemptId: entry.attempt_id,
        })
      )
    );
    if (Exit.isFailure(offered)) return false;
    return true;
  });

/** Offer bounded, secret-free work identities. D1 intent remains authoritative on Queue failure. */
export const dispatchBillingCollection = (
  environment: Readonly<{ DB: D1Database; BILLING_COLLECTION_QUEUE: CollectionQueue }> & {
    readonly identity: Option.Option<string>;
  }
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const identity = environment.identity;
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* attempt(() =>
      environment.DB.prepare(`SELECT o.attempt_id,o.user_id
      FROM (SELECT rowid,user_id,id AS attempt_id,collection_state AS state,collection_sent_at_ms AS sent_at_ms,collection_last_attempt_at_ms AS last_attempt_at_ms FROM billing_attempt_context WHERE collection_state IS NOT NULL) AS o
      WHERE o.state = 'armed' AND (o.last_attempt_at_ms IS NULL OR o.last_attempt_at_ms < ?)
        AND (? IS NULL OR o.attempt_id = ?)
      ORDER BY o.last_attempt_at_ms, o.attempt_id LIMIT ?`)
        .bind(
          now - dispatchCooldownMs,
          Option.getOrNull(identity),
          Option.getOrNull(identity),
          pendingBatchSize
        )
        .all()
    );
    const entries = yield* decode(
      Schema.Array(Schema.Struct({ attempt_id: BillingAttemptId, user_id: UserId })),
      rows.results
    );
    let failed = false;
    for (const entry of entries) {
      const published = yield* publishBillingEntry({ environment, entry, now });
      if (!published) failed = true;
    }
    if (failed) return yield* failure();
  }).pipe(Effect.withSpan("billing.collection.dispatch"));

const receiveCancellation = (
  environment: BillingWorkRouting &
    Readonly<{ DB: D1Database; BILLING_COLLECTION_WORKFLOW: CollectionWorkflow }>,
  work: typeof LocalSourceCancellationWork.Type | typeof SubscriptionCancellationWork.Type
): Effect.Effect<void, BillingCollectionFailure> =>
  work.version === 3
    ? receiveLocalSourceCancellation({
        environment,
        workflow: environment.BILLING_COLLECTION_WORKFLOW,
        work,
      })
    : receiveSourceCancellation({
        db: environment.DB,
        workflow: environment.BILLING_COLLECTION_WORKFLOW,
        work,
      });

/** Duplicated Queue messages converge on one deterministic Workflow instance. */
export const receiveBillingCollection = (
  input: Readonly<{
    environment: BillingWorkRouting &
      Readonly<{ DB: D1Database; BILLING_COLLECTION_WORKFLOW: CollectionWorkflow }>;
    batch: Readonly<{ messages: ReadonlyArray<{ body: unknown; ack: () => void }> }>;
  }>
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    for (const message of input.batch.messages) {
      const work = Schema.decodeUnknownOption(
        Schema.Union([SubscriptionCancellationWork, LocalSourceCancellationWork])
      )(message.body);
      if (Option.isNone(work)) {
        message.ack();
        continue;
      }
      yield* receiveCancellation(input.environment, work.value);
      message.ack();
    }
  }).pipe(Effect.withSpan("billing.collection.receive"));

const configuredEventEnvironment = (
  env: WompiEventEnvironment
): Option.Option<WompiEnvironment> => {
  const selected = Schema.decodeUnknownOption(WompiEnvironment)(env.WOMPI_ENVIRONMENT);
  return Option.filter(selected, (scope) =>
    env.WOMPI_EVENT_SECRET.startsWith(scope === "sandbox" ? "test_events_" : "prod_events_")
  );
};
/** A valid signed event persists only a bounded transaction-id hint, then independently verifies provider evidence. */
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
    const event = Schema.decodeOption(WompiBillingEvent)({
      _tag: "WompiBillingEvent",
      environment: configured.value,
      ...verified.value.value,
    });
    if (Option.isNone(event)) return new Response(null, { status: 400 });
    const accepted = yield* Effect.exit(attempt(() => queue.send(event.value)));
    if (Exit.isFailure(accepted)) return new Response(null, { status: 503 });
    return new Response(null, { status: 200 });
  });

type BillingWorkflowExecution = Readonly<{
  environment: BillingRuntime;
  payload: unknown;
  activity: BillingWorkflowActivity;
  observe: Option.Option<BillingWorkflowActivity<boolean>>;
  sleep: (name: string, duration: number) => Promise<void>;
  wompiHttp: WompiTransportFactory;
}>;
/** Only a versioned identity enters Workflow state. The named Activity owns the one armed POST. */
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
  return runBillingObservation(input);
};
