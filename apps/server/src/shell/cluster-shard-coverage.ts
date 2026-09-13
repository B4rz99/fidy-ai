import { Function, HashRing, Option, PrimaryKey } from "effect";
import {
  type Runner,
  type RunnerAddress,
  ShardId,
  type Sharding,
  type ShardingConfig,
} from "effect/unstable/cluster";
/** Counts the shards this process currently owns across its assigned groups. */
const countOwnedShards = (
  sharding: Sharding.Sharding["Service"],
  config: ShardingConfig.ShardingConfig["Service"]
): number => {
  let assigned = 0;
  for (const group of config.assignedShardGroups) {
    for (let id = 1; id <= config.shardsPerGroup; id += 1) {
      if (sharding.hasShardId(ShardId.make(group, id))) assigned += 1;
    }
  }
  return assigned;
};

/** Rebuilds the weighted ring Sharding uses for one group from the healthy runner registry. */
const ringForGroup = (
  runners: ReadonlyArray<readonly [Runner.Runner, boolean]>,
  group: string
): HashRing.HashRing<RunnerAddress.RunnerAddress> => {
  const ring = HashRing.make<RunnerAddress.RunnerAddress>();
  for (const [runner, healthy] of runners) {
    if (healthy && runner.groups.includes(group)) {
      HashRing.add(ring, runner.address, { weight: runner.weight });
    }
  }
  return ring;
};

/**
 * Counts the shards the healthy ring assigns to `selfKey` across the runner's assigned groups.
 * Sharding exposes no public accessor for its ring, so this derivation is the only available source
 * of expected assignment; it is observability-only and never feeds routing.
 */
export const expectedShardsFor = (input: {
  readonly runners: ReadonlyArray<readonly [Runner.Runner, boolean]>;
  readonly config: ShardingConfig.ShardingConfig["Service"];
  readonly selfKey: string;
}): number => {
  let expected = 0;
  for (const group of input.config.assignedShardGroups) {
    const assignments = HashRing.getShards(
      ringForGroup(input.runners, group),
      input.config.shardsPerGroup
    );
    if (assignments === undefined) continue;
    for (const address of assignments) {
      if (PrimaryKey.value(address) === input.selfKey) expected += 1;
    }
  }
  return expected;
};

/**
 * Counts currently owned shards against the share this runner's assigned groups hold on the healthy
 * ring. A steady fleet reports no lag while a takeover or rebalance reports the shards still to
 * acquire; a process without an address owns nothing.
 */
export const shardCoverage: {
  (
    runners: ReadonlyArray<readonly [Runner.Runner, boolean]>,
    config: ShardingConfig.ShardingConfig["Service"]
  ): (sharding: Sharding.Sharding["Service"]) => {
    readonly assigned: number;
    readonly expected: number;
  };
  (
    sharding: Sharding.Sharding["Service"],
    runners: ReadonlyArray<readonly [Runner.Runner, boolean]>,
    config: ShardingConfig.ShardingConfig["Service"]
  ): { readonly assigned: number; readonly expected: number };
} = Function.dual(
  3,
  (
    sharding: Sharding.Sharding["Service"],
    runners: ReadonlyArray<readonly [Runner.Runner, boolean]>,
    config: ShardingConfig.ShardingConfig["Service"]
  ) => ({
    assigned: countOwnedShards(sharding, config),
    expected: Option.match(config.runnerAddress, {
      onNone: () => 0,
      onSome: (address) =>
        expectedShardsFor({ runners, config, selfKey: PrimaryKey.value(address) }),
    }),
  })
);
