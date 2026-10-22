import { Effect, Exit, Option } from "effect";
import { BillingCollectionFailure, type BillingObservationWorkflow } from "../contract";

export const billingWorkflowRetention = {
  successRetention: "3 days",
  errorRetention: "3 days",
} as const;
const terminalStatuses: ReadonlySet<InstanceStatus["status"]> = new Set([
  "errored",
  "terminated",
  "complete",
]);
const wait = <A>(run: () => Promise<A>): Effect.Effect<A, BillingCollectionFailure> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BillingCollectionFailure({ cause: Option.some(cause) }),
  });

/** Reserve only new or terminal execution handoffs; an active execution keeps its existing budget. */
export const offerBillingWorkflow = (
  input: Readonly<{
    workflow: BillingObservationWorkflow;
    id: string;
    params: unknown;
    reserve: Effect.Effect<boolean, BillingCollectionFailure>;
  }>
): Effect.Effect<boolean, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const existing = yield* Effect.exit(wait(() => input.workflow.get(input.id)));
    if (Exit.isSuccess(existing)) {
      const current = yield* wait(() => existing.value.status());
      if (!terminalStatuses.has(current.status)) return true;
    }
    if (!(yield* input.reserve)) return true;
    const started = yield* Effect.exit(
      wait(() =>
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
    const recovered = yield* wait(() => input.workflow.get(input.id));
    const status = yield* wait(() => recovered.status());
    return status.status === "queued" || status.status === "running" || status.status === "waiting";
  });
