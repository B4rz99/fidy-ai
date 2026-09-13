import { Effect } from "effect";
import { beforeAll } from "vitest";
import { resetClusterTopologyIdentity } from "./cluster-topology-fixtures";

/**
 * Registers the per-file compatibility-identity reset. Each integration file is its own deployment:
 * an earlier file on the shared database may have published a different lock topology.
 */
export const resetClusterTopologyBeforeAll = (): void => {
  beforeAll(() => Effect.runPromise(resetClusterTopologyIdentity));
};
