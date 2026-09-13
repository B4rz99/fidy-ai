import { expect, it } from "@effect/vitest";
import { Runner, RunnerAddress, ShardingConfig } from "effect/unstable/cluster";
import { expectedShardsFor } from "./cluster-shard-coverage";

const testRunner = (
  port: number,
  overrides: Partial<{ readonly groups: ReadonlyArray<string>; readonly weight: number }> = {}
): Runner.Runner =>
  Runner.make({
    address: RunnerAddress.make("127.0.0.1", port),
    groups: overrides.groups ?? ["default"],
    weight: overrides.weight ?? 1,
  });

const config: ShardingConfig.ShardingConfig["Service"] = {
  ...ShardingConfig.defaults,
  assignedShardGroups: ["default"],
  shardsPerGroup: 300,
};

const addressKey = (port: number): string => `127.0.0.1:${port}`;

it("pins the weighted share of the healthy ring for a fixed runner set", () => {
  const runners = [
    [testRunner(1), true],
    [testRunner(2), true],
    [testRunner(3, { weight: 2 }), true],
  ] as const;

  // Golden counts captured from the public weighted-ring algorithm. An upstream assignment change
  // shifts them and fails here instead of silently moving `expectedShards`.
  const unitShare = expectedShardsFor({ runners, config, selfKey: addressKey(1) });
  const otherUnitShare = expectedShardsFor({ runners, config, selfKey: addressKey(2) });
  const heavyShare = expectedShardsFor({ runners, config, selfKey: addressKey(3) });
  expect(unitShare).toBe(75);
  expect(otherUnitShare).toBe(75);
  expect(heavyShare).toBe(150);
  expect(unitShare + otherUnitShare + heavyShare).toBe(300);
  expect(heavyShare).toBeGreaterThan(unitShare);
});

it("ignores unhealthy runners and runners outside the assigned groups", () => {
  const runners = [
    [testRunner(1), true],
    [testRunner(2), false],
    [testRunner(3, { groups: ["other"] }), true],
  ] as const;

  expect(expectedShardsFor({ runners, config, selfKey: addressKey(1) })).toBe(300);
  expect(expectedShardsFor({ runners, config, selfKey: addressKey(2) })).toBe(0);
  expect(expectedShardsFor({ runners, config, selfKey: addressKey(3) })).toBe(0);
});
