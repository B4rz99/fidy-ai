import type { ClusterRunnerHttpPolicy } from "~/shell/cluster-runner-http";

/**
 * Private runner policy for loopback Cluster runtimes. Every test runner listens on 127.0.0.1 and
 * picks an ephemeral port the harness cannot know at layer construction, so loopback explicitly
 * allows any port on that host; the health deadline matches the upstream ping bound, and the
 * request deadline outlives the bounded test Turns while still bounding a stalled exchange.
 */
export const loopbackClusterRunnerHttpPolicy: ClusterRunnerHttpPolicy = {
  runnerHosts: ["127.0.0.1"],
  runnerPorts: { _tag: "Any" },
  healthDeadline: "10 seconds",
  requestDeadline: "10 minutes",
};
