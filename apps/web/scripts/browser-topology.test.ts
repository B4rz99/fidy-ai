import { expect, it } from "vitest";
import { Predicate, Record } from "effect";

const listTests = (
  config: string,
  mode: "shared" | "cli",
  args: ReadonlyArray<string> = []
): string => {
  const result = Bun.spawnSync(
    [process.execPath, "--bun", "playwright", "test", "--config", config, "--list", ...args],
    {
      env: Record.filter(
        { PATH: Bun.env.PATH, HOME: Bun.env.HOME, CLI_ACCEPTANCE_MODE: mode },
        Predicate.isString
      ),
    }
  );
  expect(result.exitCode).toBe(0);
  return new TextDecoder().decode(result.stdout);
};

it("keeps the native CLI mutation journey out of the shared User's browser suite", () => {
  const shared = listTests("playwright.config.ts", "shared");
  expect(shared).toContain("real-core-journeys.spec.ts:");
  expect(shared).not.toContain("cli-login.spec.ts:");
});

it("partitions the complete browser suite across both runners without dropping or repeating tests", () => {
  const cases = (output: string): ReadonlyArray<string> =>
    output.split("\n").filter((line) => line.includes(".spec.ts:"));
  const complete = cases(listTests("playwright.config.ts", "shared"));
  const shards = ["1/2", "2/2"].map((shard) =>
    cases(listTests("playwright.config.ts", "shared", [`--shard=${shard}`]))
  );
  for (const shard of shards) expect(shard.length).toBeGreaterThan(0);
  const browser = (tests: ReadonlyArray<string>): ReadonlyArray<string> =>
    tests.filter((line) => line.includes("[browser]"));
  const admission = (tests: ReadonlyArray<string>): ReadonlyArray<string> =>
    tests.filter((line) => line.includes("[admission]") || line.includes("[performance]"));
  // Every runner proves real admission before starting its own concurrent browser shard.
  expect(admission(complete)).toHaveLength(3);
  for (const shard of shards) expect(admission(shard)).toEqual(admission(complete));
  expect(browser(shards.flat()).toSorted()).toEqual([...browser(complete)].sort());
  expect(new Set(browser(shards.flat())).size).toBe(browser(complete).length);
});

it("selects only the native CLI journey for its isolated public/Core and Audit fixture", () => {
  const isolated = listTests("playwright.cli.config.ts", "cli");
  expect(isolated).toContain("cli-login.spec.ts:");
  expect(isolated).not.toContain("real-core-journeys.spec.ts:");
  expect(isolated).toContain("Total: 1 test in 1 file");
});
