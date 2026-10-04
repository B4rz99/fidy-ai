import { expect, it } from "vitest";
import { Predicate, Record } from "effect";

const listTests = (config: string, mode: "shared" | "cli"): string => {
  const result = Bun.spawnSync(
    [process.execPath, "--bun", "playwright", "test", "--config", config, "--list"],
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

it("selects only the native CLI journey for its isolated public/Core and Audit fixture", () => {
  const isolated = listTests("playwright.cli.config.ts", "cli");
  expect(isolated).toContain("cli-login.spec.ts:");
  expect(isolated).not.toContain("real-core-journeys.spec.ts:");
  expect(isolated).toContain("Total: 1 test in 1 file");
});
