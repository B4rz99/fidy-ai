import { type Array } from "effect";
import type { ClusterRunnerHttpPolicy } from "~/shell/cluster-runner-http";

/** Private runner policy for the exact loopback ports owned by one Cluster test harness. */
export const loopbackClusterRunnerHttpPolicy = (
  runnerPorts: Array.NonEmptyArray<number>
): ClusterRunnerHttpPolicy => ({
  runnerHosts: ["127.0.0.1"],
  runnerPorts,
  connectDeadline: "5 seconds",
  healthDeadline: "10 seconds",
  requestDeadline: "10 minutes",
});
