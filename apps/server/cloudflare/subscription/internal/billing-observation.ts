import { Effect, Exit, Layer, ManagedRuntime, Option, Ref, Schema } from "effect";
import {
  BillingCollectionFailure,
  type BillingObservationWorkflow,
  type BillingWorkRouting,
  type BillingWorkflowActivity,
  LocalSourceCancellationWork,
} from "../contract";

const boundaryRuntime = ManagedRuntime.make(Layer.empty);

const candidateCooldownMs = 60_000;

const maximumCandidateLookupAttempts = 8;

const failure = (cause: Option.Option<unknown> = Option.none()): BillingCollectionFailure =>
  new BillingCollectionFailure({ cause });

const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, BillingCollectionFailure> =>
  Effect.tryPromise({ try: run, catch: (cause) => failure(Option.some(cause)) });

const billingWorkflowRetention = {
  successRetention: "3 days",
  errorRetention: "3 days",
} as const;

const activeStatuses: ReadonlySet<InstanceStatus["status"]> = new Set([
  "queued",
  "running",
  "waiting",
]);

const terminalStatuses: ReadonlySet<InstanceStatus["status"]> = new Set([
  "errored",
  "terminated",
  "complete",
]);

const offerBillingWorkflow = (
  input: Readonly<{
    workflow: BillingObservationWorkflow;
    id: string;
    params: unknown;
    reserve: Effect.Effect<boolean, BillingCollectionFailure>;
  }>
): Effect.Effect<boolean, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const existing = yield* Effect.exit(attempt(() => input.workflow.get(input.id)));

    if (Exit.isSuccess(existing)) {
      const current = yield* attempt(() => existing.value.status());

      if (!terminalStatuses.has(current.status)) return activeStatuses.has(current.status);
    }

    if (!(yield* input.reserve)) return true;

    const started = yield* Effect.exit(
      attempt(() =>
        Exit.isSuccess(existing)
          ? existing.value.restart()
          : input.workflow.create({
              id: input.id,
              params: input.params,
              retention: billingWorkflowRetention,
            })
      )
    );

    if (Exit.isSuccess(started)) return true;
    const recovered = yield* attempt(() => input.workflow.get(input.id));
    const status = yield* attempt(() => recovered.status());

    return activeStatuses.has(status.status);
  });

const workPending = 202;

const noEligibleWork = 204;

const callCancellationOwner = (
  environment: BillingWorkRouting,
  work: typeof LocalSourceCancellationWork.Type,
  action: "pending" | "observe"
): Effect.Effect<boolean, BillingCollectionFailure> =>
  Effect.gen(function* () {
    if (environment.USER_STORE === undefined) return yield* failure();
    const owner = environment.USER_STORE.getByName(work.userId);

    const body = yield* Schema.encodeEffect(Schema.fromJsonString(LocalSourceCancellationWork))(
      work
    ).pipe(Effect.mapError(() => failure()));

    const response = yield* Effect.tryPromise({
      try: (signal) =>
        owner.fetch("https://user-store.internal/work/source-cancellation/" + action, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal,
        }),
      catch: () => failure(),
    });

    if (response.status === noEligibleWork) return false;

    if (response.status === workPending) return true;

    return yield* failure();
  });

export const receiveLocalSourceCancellation = (
  input: Readonly<{
    environment: BillingWorkRouting;
    workflow: BillingObservationWorkflow;
    work: typeof LocalSourceCancellationWork.Type;
  }>
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    if (!(yield* callCancellationOwner(input.environment, input.work, "pending"))) return;

    const offered = yield* offerBillingWorkflow({
      workflow: input.workflow,
      id: `source-cancel-v3-${input.work.userId}-${input.work.paidAttemptId}`,
      params: input.work,
      reserve: Effect.succeed(true),
    });

    if (!offered) return yield* failure();
  });

type BillingObservationTiming = Readonly<{
  observe: Option.Option<BillingWorkflowActivity<boolean>>;
  sleep: (name: string, duration: number) => Promise<void>;
}>;

export const runLocalCancellationLoop = (
  input: BillingObservationTiming & {
    environment: BillingWorkRouting;
    work: typeof LocalSourceCancellationWork.Type;
  }
): Promise<void> =>
  boundaryRuntime.runPromise(
    Effect.gen(function* () {
      const observe = input.observe;

      if (Option.isNone(observe)) return yield* failure();
      const run = Effect.runPromiseWith(yield* Effect.context<never>());

      const nextIndex = yield* Ref.make(0);

      const observeOwner = (): Promise<boolean> =>
        run(callCancellationOwner(input.environment, input.work, "observe"));

      const observeCandidate = Effect.gen(function* () {
        const index = yield* Ref.getAndUpdate(nextIndex, (current) => current + 1);

        if (index > 0) {
          yield* attempt(() =>
            input.sleep(`source-cancellation-wait-v3-${index}`, candidateCooldownMs + 1)
          );
        }

        const pending = yield* attempt(() =>
          observe.value(
            `verify-source-cancellation-v3-${index}`,
            { retries: { limit: 0, delay: "1 second" } },
            observeOwner
          )
        );

        return pending;
      });

      yield* observeCandidate.pipe(
        Effect.repeat({ while: Boolean, times: maximumCandidateLookupAttempts - 1 })
      );
    })
  );
