import { expect, it } from "@effect/vitest";
import { Option } from "effect";
import { ShardingConfig } from "effect/unstable/cluster";
import {
  clientClusterTopology,
  clusterCompatibilityDifferences,
  clusterCompatibilityFields,
  clusterCompatibilityIdentity,
  clusterProtocolGeneration,
  clusterSerialization,
  clusterSerializationMaxBufferSizeBytes,
  clusterStoragePrefix,
  productionRunnerTopology,
} from "./cluster-topology";

const runnerTopology = productionRunnerTopology({
  advertisedHost: "runner.internal",
  listenHost: "0.0.0.0",
  port: 34431,
});

it("states every Sharding setting that affects ownership, recovery, or capacity", () => {
  expect(new Set(Object.keys(runnerTopology.sharding))).toEqual(
    new Set(Object.keys(ShardingConfig.defaults))
  );
  expect(new Set(Object.keys(clientClusterTopology().sharding))).toEqual(
    new Set(Object.keys(ShardingConfig.defaults))
  );
});

it("publishes one compatibility identity for runners and clients", () => {
  expect(clientClusterTopology().compatibility).toEqual(runnerTopology.compatibility);
  expect(runnerTopology.compatibility).toEqual({
    protocolGeneration: clusterProtocolGeneration,
    shardsPerGroup: 300,
    availableShardGroups: ["default"],
    serialization: clusterSerialization,
    serializationMaxBufferSize: clusterSerializationMaxBufferSizeBytes,
    messageStoragePrefix: clusterStoragePrefix,
    runnerStoragePrefix: clusterStoragePrefix,
    shardLockDisableAdvisory: true,
    shardLockExpirationMillis: 35_000,
  });
});

it("keeps process-local addresses out of the compatibility identity", () => {
  const otherRunner = productionRunnerTopology({
    advertisedHost: "other.internal",
    listenHost: "127.0.0.1",
    port: 40000,
  });

  expect(otherRunner.compatibility).toEqual(runnerTopology.compatibility);
  expect(Option.isNone(clientClusterTopology().sharding.runnerAddress)).toBe(true);
});

it("derives the identity from the effective shard count and groups", () => {
  const identity = clusterCompatibilityIdentity({
    ...ShardingConfig.defaults,
    shardsPerGroup: 16,
    availableShardGroups: ["beta", "alpha", "beta"],
  });

  expect(identity.shardsPerGroup).toBe(16);
  expect(identity.availableShardGroups).toEqual(["alpha", "beta"]);
});

it("names every compatibility field that differs without reporting address or capacity changes", () => {
  const published = runnerTopology.compatibility;
  const local = {
    ...published,
    protocolGeneration: published.protocolGeneration + 1,
    shardsPerGroup: published.shardsPerGroup + 1,
    availableShardGroups: [...published.availableShardGroups, "secondary"],
    serializationMaxBufferSize: published.serializationMaxBufferSize * 2,
    messageStoragePrefix: "other",
    runnerStoragePrefix: "other",
    shardLockDisableAdvisory: !published.shardLockDisableAdvisory,
    shardLockExpirationMillis: published.shardLockExpirationMillis + 1,
  };

  expect(clusterCompatibilityDifferences(published, local)).toEqual([
    "protocolGeneration",
    "shardsPerGroup",
    "availableShardGroups",
    "serializationMaxBufferSize",
    "messageStoragePrefix",
    "runnerStoragePrefix",
    "shardLockDisableAdvisory",
    "shardLockExpirationMillis",
  ]);
  expect(clusterCompatibilityDifferences(published, { ...published })).toEqual([]);
  expect(clusterCompatibilityFields).toEqual(
    expect.arrayContaining([...clusterCompatibilityDifferences(published, local)])
  );
});
