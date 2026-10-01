/// <reference types="bun-types" />

import { BunServices } from "@effect/platform-bun";
import { layer } from "@effect/vitest";
import { Data, Effect, FileSystem, Path, Schedule } from "effect";
import { expect } from "vitest";

const sourceDirectory = `${process.cwd()}/scripts`;
const initialGates = ["worker-boundary", "workers-ai", "static-artifact", "migration"];

class FixtureIoFailed extends Data.TaggedError("FixtureIoFailed")<{}> {}
const fixturePromise = <A>(work: () => Promise<A>): Effect.Effect<A, FixtureIoFailed> =>
  Effect.tryPromise({ try: work, catch: () => new FixtureIoFailed() });

const gateMarkers = Effect.fn(function* (directory: string, suffix: string) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  return yield* Effect.forEach(initialGates, (gate) =>
    fs.exists(paths.join(directory, `${gate}.${suffix}`))
  );
});
const waitForMarkers = Effect.fn(function* (directory: string, suffix: string) {
  const markers = yield* gateMarkers(directory, suffix).pipe(
    Effect.repeat({
      while: (values) => !values.every(Boolean),
      schedule: Schedule.spaced("20 millis"),
    }),
    Effect.timeout("3 seconds")
  );
  expect(markers).toEqual([true, true, true, true]);
});
type PreflightResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: ReadonlyArray<string>;
  readonly aiFinished: boolean;
  readonly buildFinished: boolean;
  readonly stopped: ReadonlyArray<boolean>;
};

// Substitute only the external command boundary; exercise the real orchestration and drift gate.
const fixtureCommand = `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *workers.test.ts) gate=worker-boundary ;;
  *test:workers-ai-conformance) gate=workers-ai ;;
  *build:production) gate=static-artifact ;;
  *check-applied-migration-drift.ts) gate=migration ;;
  *'provider cloudflare bootstrap'*) gate=bootstrap ;;
  *'drift --config'*) gate=drift ;;
  *) exit 99 ;;
esac
printf '%s\\n' "$gate" >> "$FIXTURE_DIRECTORY/calls"
case "$gate" in
  worker-boundary|workers-ai|static-artifact|migration)
    touch "$FIXTURE_DIRECTORY/$gate.started"
    concurrent=false
    for attempt in {1..100}; do
      if [[ -f "$FIXTURE_DIRECTORY/worker-boundary.started" &&
            -f "$FIXTURE_DIRECTORY/workers-ai.started" &&
            -f "$FIXTURE_DIRECTORY/static-artifact.started" &&
            -f "$FIXTURE_DIRECTORY/migration.started" ]]; then
        concurrent=true
        break
      fi
      sleep 0.02
    done
    if [[ "$concurrent" != true ]]; then exit 98; fi
    ;;
esac
if [[ "$FAILED_GATE" == interrupted ]]; then
  trap 'touch "$FIXTURE_DIRECTORY/$gate.stopped"; exit 143' TERM
  touch "$FIXTURE_DIRECTORY/$gate.waiting"
  sleep 30 &
  wait "$!"
fi
# Slow independent gates must still finish when the infrastructure lane fails.
if [[ "$gate" == workers-ai || "$gate" == static-artifact ]]; then sleep 0.1; fi
touch "$FIXTURE_DIRECTORY/$gate.finished"
if [[ "$gate" == "$FAILED_GATE" ]]; then exit 23; fi
if [[ "$gate" == drift ]]; then echo 'Plan: no changes'; fi
`;

const runPreflight = Effect.fn(function* (failedGate: string = "") {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "fidy-preflight-" });
  const scripts = paths.join(directory, "infra/cloudflare/scripts");
  const bin = paths.join(directory, "bin");
  yield* fs.makeDirectory(scripts, { recursive: true });
  yield* fs.makeDirectory(bin);
  yield* Effect.forEach(["production-preflight.sh", "check-topology-drift.sh"], (filename) =>
    fs
      .readFileString(paths.join(sourceDirectory, filename))
      .pipe(
        Effect.flatMap((contents) => fs.writeFileString(paths.join(scripts, filename), contents))
      )
  );
  yield* fs.writeFileString(paths.join(bin, "bun"), fixtureCommand);
  yield* fs.chmod(paths.join(bin, "bun"), 0o700);
  const child = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        Bun.spawn(["bash", paths.join(scripts, "production-preflight.sh")], {
          env: {
            ...Bun.env,
            PATH: `${bin}:${Bun.env.PATH}`,
            FIXTURE_DIRECTORY: directory,
            FAILED_GATE: failedGate,
            ALCHEMY_PROFILE: "fixture",
          },
          stdout: "pipe",
          stderr: "pipe",
        }),
      catch: () => new FixtureIoFailed(),
    }),
    (process) =>
      Effect.gen(function* () {
        process.kill("SIGTERM");
        yield* fixturePromise(() => process.exited).pipe(Effect.orDie);
      })
  );
  if (failedGate === "interrupted") {
    yield* waitForMarkers(directory, "waiting").pipe(
      Effect.ensuring(Effect.sync(() => child.kill("SIGTERM")))
    );
  }
  const { exitCode, stdout, stderr } = yield* Effect.all(
    {
      exitCode: fixturePromise(() => child.exited),
      stdout: fixturePromise(() => new Response(child.stdout).text()),
      stderr: fixturePromise(() => new Response(child.stderr).text()),
    },
    { concurrency: 3 }
  );
  const calls = (yield* fs.readFileString(paths.join(directory, "calls"))).trim().split("\n");
  const aiFinished = yield* fs.exists(paths.join(directory, "workers-ai.finished"));
  const buildFinished = yield* fs.exists(paths.join(directory, "static-artifact.finished"));
  if (failedGate === "interrupted") yield* waitForMarkers(directory, "stopped");
  const stopped = yield* gateMarkers(directory, "stopped");
  return {
    exitCode,
    stdout,
    stderr,
    calls,
    aiFinished,
    buildFinished,
    stopped,
  } satisfies PreflightResult;
});
// Subprocess polling observes real time, not the deterministic application TestClock.
layer(BunServices.layer, { excludeTestServices: true })("Production preflight barrier", (it) => {
  it.effect("overlaps all four gates while keeping migration, bootstrap and drift ordered", () =>
    Effect.gen(function* () {
      const result = yield* runPreflight();
      expect(result.exitCode, result.stderr).toBe(0);
      expect(
        result.calls.filter((gate) => ["migration", "bootstrap", "drift"].includes(gate))
      ).toEqual(["migration", "bootstrap", "drift"]);
      expect(result.aiFinished).toBe(true);
      expect(result.buildFinished).toBe(true);
      expect(result.stdout).toContain("cloudflare-state (passed)");
    })
  );

  it.effect("terminates every gate's descendants when the runner cancels preflight", () =>
    Effect.gen(function* () {
      const result = yield* runPreflight("interrupted");
      expect(result.exitCode).toBe(143);
      expect(result.stopped).toEqual([true, true, true, true]);
      expect(result.calls).not.toContain("bootstrap");
    })
  );

  it.effect.each([
    "worker-boundary",
    "workers-ai",
    "static-artifact",
    "migration",
    "bootstrap",
    "drift",
  ])("blocks release after %s fails and drains the other gates", (gate) =>
    Effect.gen(function* () {
      const result = yield* runPreflight(gate);
      expect(result.exitCode, result.stderr).toBe(1);
      expect(result.stdout).toContain("(failed)");
      expect(result.aiFinished).toBe(true);
      expect(result.buildFinished).toBe(true);
      if (gate === "migration") expect(result.calls).not.toContain("bootstrap");
      if (gate === "migration" || gate === "bootstrap") {
        expect(result.calls).not.toContain("drift");
      }
    })
  );
});
