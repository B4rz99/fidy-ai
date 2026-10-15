import { fileURLToPath } from "node:url";
import { Config, Data, Effect } from "effect";
import { expect, it } from "vitest";

class PortFixtureFailure extends Data.TaggedError("PortFixtureFailure") {}

const enabled =
  process.platform === "darwin" &&
  Effect.runSync(Config.String("FIDY_BROWSER_SMOKE").pipe(Config.withDefault("0"))) === "1";
const root = fileURLToPath(new URL("../", import.meta.url));
const run = (...args: ReadonlyArray<string>): ReturnType<typeof Bun.spawnSync> =>
  Bun.spawnSync([process.execPath, "scripts/dev-browser.ts", ...args], { cwd: root });
const listeners = (): string =>
  new TextDecoder().decode(
    Bun.spawnSync(["lsof", "-t", "-iTCP:4173", "-iTCP:4174", "-iTCP:4175", "-sTCP:LISTEN"]).stdout
  );
const timeoutMilliseconds = 90_000;

it.runIf(enabled)(
  "keeps trusted HTTPS alive after startup exits, reuses it, and releases every listener on stop",
  () => {
    expect(run("stop").exitCode).toBe(0);
    expect(listeners()).toBe("");
    expect(run("status").exitCode).toBe(1);
    expect(run("start").exitCode).toBe(0);
    const first = listeners();
    expect(first).not.toBe("");
    expect(run("start").exitCode).toBe(0);
    expect(listeners()).toBe(first);
    expect(run("status").exitCode).toBe(0);
    expect(
      Bun.spawnSync([
        "curl",
        "--fail",
        "--silent",
        "--max-time",
        "2",
        "https://127.0.0.1:4174/health",
      ]).exitCode
    ).toBe(0);
    expect(run("stop").exitCode).toBe(0);
    expect(listeners()).toBe("");
    expect(run("status").exitCode).toBe(1);
    expect(run("start").exitCode).toBe(0);
  },
  timeoutMilliseconds
);

it.runIf(enabled)(
  "refuses an occupied port without claiming readiness or killing its unrelated owner",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(run("stop").exitCode).toBe(0);
        const blocker = Bun.spawn(
          [
            process.execPath,
            "--eval",
            'Bun.serve({hostname:"127.0.0.1",port:4173,fetch:()=>new Response("occupied")}); process.stdout.write("ready");',
          ],
          { stdout: "pipe", stderr: "ignore" }
        );
        const output = blocker.stdout.getReader();
        try {
          yield* Effect.tryPromise({
            try: () => output.read(),
            catch: () => new PortFixtureFailure(),
          });
          const result = run("start");
          expect(result.exitCode).toBe(1);
          expect(new TextDecoder().decode(result.stderr)).toContain("Port 4173 is occupied");
          expect(listeners()).toContain(`${blocker.pid}`);
          expect(run("stop").exitCode).toBe(0);
          expect(listeners()).toContain(`${blocker.pid}`);
        } finally {
          output.releaseLock();
          blocker.kill();
          yield* Effect.tryPromise({
            try: () => blocker.exited,
            catch: () => new PortFixtureFailure(),
          });
          expect(run("start").exitCode).toBe(0);
        }
      })
    ),
  timeoutMilliseconds
);
