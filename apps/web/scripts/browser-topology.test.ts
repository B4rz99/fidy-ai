import { beforeAll, expect, it } from "vitest";
import { Data, Effect, Predicate, Record } from "effect";

class DiscoveryFailure extends Data.TaggedError("DiscoveryFailure") {}

const listed = new Map<string, string>();
const listTests = (
  config: string,
  mode: "shared" | "cli",
  args: ReadonlyArray<string> = []
): Effect.Effect<string, DiscoveryFailure> =>
  Effect.gen(function* () {
    const key = [config, mode, ...args].join(" ");
    const cached = listed.get(key);
    if (cached !== undefined) return cached;
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.spawn(
          [process.execPath, "--bun", "playwright", "test", "--config", config, "--list", ...args],
          {
            timeout: 30_000,
            killSignal: "SIGKILL",
            stdout: "pipe",
            stderr: "pipe",
            env: Record.filter(
              {
                PATH: Bun.env.PATH,
                HOME: Bun.env.HOME,
                CLI_ACCEPTANCE_MODE: mode,
                BROWSER_TEST_SHARD: args
                  .find((argument) => argument.startsWith("--shard="))
                  ?.slice("--shard=".length),
              },
              Predicate.isString
            ),
          }
        )
      ),
      (process) =>
        Effect.sync(() => {
          process.kill("SIGKILL");
        })
    );
    const [output, diagnostics, exitCode] = yield* Effect.tryPromise({
      try: () =>
        Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]),
      catch: () => new DiscoveryFailure(),
    });
    expect(exitCode, diagnostics).toBe(0);
    listed.set(key, output);
    return output;
  }).pipe(Effect.scoped);

beforeAll(
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* listTests("playwright.config.ts", "shared");
        yield* Effect.forEach(
          ["1/2", "2/2"],
          (shard) => listTests("playwright.config.ts", "shared", [`--shard=${shard}`]),
          { concurrency: 2 }
        );
        yield* listTests("playwright.cli.config.ts", "cli");
      })
    ),
  100_000
);

it("keeps the native CLI mutation journey out of the shared User's browser suite", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const shared = yield* listTests("playwright.config.ts", "shared");
      expect(shared).toContain("real-core-journeys.spec.ts:");
      expect(shared).not.toContain("cli-login.spec.ts:");
    })
  ));

it("partitions the complete browser suite across both runners without dropping or repeating tests", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const cases = (output: string): ReadonlyArray<string> =>
        output.split("\n").filter((line) => line.includes(".spec.ts:"));
      const complete = cases(yield* listTests("playwright.config.ts", "shared"));
      const shards = yield* Effect.forEach(["1/2", "2/2"], (shard) =>
        listTests("playwright.config.ts", "shared", [`--shard=${shard}`]).pipe(Effect.map(cases))
      );
      for (const shard of shards) expect(shard.length).toBeGreaterThan(0);
      const browser = (tests: ReadonlyArray<string>): ReadonlyArray<string> =>
        tests.filter((line) => line.includes("[browser]"));
      const admission = (tests: ReadonlyArray<string>): ReadonlyArray<string> =>
        tests.filter((line) => line.includes("[admission]"));
      const performance = (tests: ReadonlyArray<string>): ReadonlyArray<string> =>
        tests.filter((line) => line.includes("[performance]"));
      expect(admission(complete)).toHaveLength(4);
      for (const [index, shard] of shards.entries()) {
        expect(admission(shard)).toEqual(admission(complete));
        expect(performance(shard)).toHaveLength(index === 0 ? 3 : 4);
      }
      expect(performance(shards.flat()).toSorted()).toEqual([...performance(complete)].sort());
      expect(new Set(performance(shards.flat())).size).toBe(7);
      expect(browser(shards.flat()).toSorted()).toEqual([...browser(complete)].sort());
      expect(new Set(browser(shards.flat())).size).toBe(browser(complete).length);
    })
  ));

it("selects only the native CLI journey for its isolated public/Core and Audit fixture", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const isolated = yield* listTests("playwright.cli.config.ts", "cli");
      expect(isolated).toContain("cli-login.spec.ts:");
      expect(isolated).not.toContain("real-core-journeys.spec.ts:");
      expect(isolated).toContain("Total: 1 test in 1 file");
    })
  ));
