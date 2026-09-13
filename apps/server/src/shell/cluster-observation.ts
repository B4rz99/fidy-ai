import { Cause, Effect, Layer, Option, Ref } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import {
  type ClusterRetryCounts,
  clusterObservationLogFields,
  projectClusterObservation,
} from "./cluster-observation-projection";
import {
  type ClusterObservationDependencies,
  sampleClusterObservation,
} from "./cluster-observation-sample";
import { runBestEffortMaintenance } from "./maintenance-schedule";

const clusterObservationInterval = "60 seconds";

/**
 * Samples and emits one bounded structured observation. Durable-queue and cross-runner request
 * retries are compared against the previous sample to report rates; a real failure never interrupts
 * the schedule, and an unreadable first sample simply omits the rates. A scope-close interruption
 * only ends the loop and is never logged as an observation failure.
 */
export const observeClusterTopology = (
  previousRetries: Ref.Ref<Option.Option<ClusterRetryCounts>>
): Effect.Effect<void, never, SqlClient.SqlClient | ClusterObservationDependencies> =>
  Effect.gen(function* () {
    const sample = yield* sampleClusterObservation;
    const previous = yield* Ref.get(previousRetries);
    yield* Ref.set(
      previousRetries,
      Option.some({
        queueRetries: sample.queueRetriesTotal,
        requestRetries: sample.requestRetriesTotal,
      })
    );
    const observation = projectClusterObservation({ sample, previousRetries: previous });
    yield* Effect.logInfo("Observed Cluster topology", clusterObservationLogFields(observation));
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Cluster observation unavailable", { error: "observation_failed" })
    )
  );

/**
 * Runs the observation loop immediately and then at the operational cadence. A missed tick only
 * delays telemetry, so the loop is best-effort and dies with its owning layer scope.
 */
export const ClusterObservationLive: Layer.Layer<
  never,
  never,
  SqlClient.SqlClient | ClusterObservationDependencies
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const previousRetries = yield* Ref.make(Option.none<ClusterRetryCounts>());
    yield* Effect.forkScoped(
      runBestEffortMaintenance({
        timing: "best-effort",
        cadence: clusterObservationInterval,
        work: observeClusterTopology(previousRetries),
      })
    );
  })
);
