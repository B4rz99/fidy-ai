import { Layer } from "effect";
import { TestRunner } from "effect/unstable/cluster";
import { WorkflowEngine } from "effect/unstable/workflow";
import type { ClusterReadiness } from "~/shell/cluster-readiness";
import { ClusterReadinessVolatile } from "~/shell/cluster-readiness";
import { PersistedQueueSqlLive } from "~/shell/persisted-queue/runtime";

const SqlQueueBase = Layer.mergeAll(
  PersistedQueueSqlLive,
  WorkflowEngine.layerMemory,
  TestRunner.layer
);

/** Builds the SQL-queue test substrate around the readiness behavior relevant to a scenario. */
export const makeSqlQueueHarness = (
  readiness: Layer.Layer<ClusterReadiness>
): Layer.Layer<
  Layer.Success<typeof SqlQueueBase> | ClusterReadiness,
  Layer.Error<typeof SqlQueueBase>,
  Layer.Services<typeof SqlQueueBase>
> => Layer.merge(SqlQueueBase, readiness);

/** SQL queue plus volatile workflow history for PostgreSQL tests without a runner listener. */
export const SqlQueueHarness = makeSqlQueueHarness(ClusterReadinessVolatile);
