import { it } from "@effect/vitest";
import { Effect, Layer, Option, Random, Result } from "effect";
import { describe, expect, vi } from "vitest";
import {
  getTelemetryBootstrap,
  installTelemetryBootstrap,
  makeTelemetryBootstrap,
} from "./telemetry-bootstrap";
import { makeSpanDescriptor } from "~/shell/testing/telemetry-fixtures";
import type { TelemetryConfig } from "./telemetry-config";
import { DisabledTelemetryResource } from "./disabled";
import { SentryLive } from "./sentry-live";

const disabledConfig = {
  _tag: "Disabled",
  environment: "local",
  capture: { errors: false, traces: false },
} as const;

const runPreloadedProcess = (
  telemetryEnvironment: Readonly<Record<string, string>>
): Effect.Effect<Readonly<{ exitCode: number; stdout: string }>> =>
  Effect.gen(function* () {
    const sentryImportGuard = `/tmp/fidy-sentry-import-guard-${yield* Random.nextInt}.ts`;
    yield* Effect.promise(() =>
      Bun.write(
        sentryImportGuard,
        `import { plugin } from "bun";
plugin({
  name: "reject-sentry-import",
  setup(build) {
    build.onResolve({ filter: /^@sentry\\/bun$/ }, () => {
      throw new Error("disabled telemetry imported @sentry/bun");
    });
  },
});`
      )
    );
    const child = yield* Effect.sync(() =>
      Bun.spawn(
        [
          "bun",
          "--preload",
          sentryImportGuard,
          "--preload",
          "./src/shell/observability/preload.ts",
          "-e",
          'console.log("application-imported")',
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, ...telemetryEnvironment },
          stdout: "pipe",
          stderr: "ignore",
        }
      )
    );
    const [exitCode, stdout] = yield* Effect.all([
      Effect.promise(() => child.exited),
      Effect.promise(() => new Response(child.stdout).text()),
    ]);
    yield* Effect.promise(() => Bun.file(sentryImportGuard).delete());
    return { exitCode, stdout };
  });

describe("telemetry preload handoff", () => {
  it.effect("does not invoke the SDK factory when capture is disabled", () =>
    Effect.gen(function* () {
      const makeEnabled = vi.fn(() => Effect.die("disabled factory invoked"));

      const bootstrap = yield* makeTelemetryBootstrap({
        config: disabledConfig,
        makeEnabled,
      });

      expect(bootstrap._tag).toBe("Disabled");
      expect(makeEnabled).not.toHaveBeenCalled();
      const adapter = bootstrap.resource.adapter;
      expect(Option.isNone(yield* adapter.startSpan(makeSpanDescriptor(), Option.none()))).toBe(
        true
      );
    })
  );

  it.effect("creates and exposes exactly one enabled client", () =>
    Effect.gen(function* () {
      const client = {};
      const config = {
        _tag: "NonProductionEnabled",
        environment: "local",
        project: "non-production",
        capture: { errors: true, traces: true },
        dsn: "https://public@o1.ingest.sentry.io/200",
        release: "fidy@0123456789abcdef0123456789abcdef01234567",
        errorSampleRate: 1,
        rootTraceRate: 1,
      } satisfies TelemetryConfig;
      const makeEnabled = vi.fn(() =>
        Effect.succeed({ client, resource: DisabledTelemetryResource })
      );

      const bootstrap = yield* makeTelemetryBootstrap({ config, makeEnabled });

      expect(makeEnabled).toHaveBeenCalledOnce();
      expect(bootstrap).toMatchObject({ _tag: "Enabled", client });
    })
  );

  it.effect("runs disabled preload without loading the Sentry SDK before application imports", () =>
    Effect.gen(function* () {
      const result = yield* runPreloadedProcess({
        SENTRY_ENVIRONMENT: "local",
        SENTRY_CAPTURE_ERRORS: "false",
        SENTRY_CAPTURE_TRACES: "false",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("application-imported");
    })
  );

  it.effect("rejects invalid enabled configuration before application imports", () =>
    Effect.gen(function* () {
      const result = yield* runPreloadedProcess({
        SENTRY_ENVIRONMENT: "local",
        SENTRY_CAPTURE_ERRORS: "true",
        SENTRY_CAPTURE_TRACES: "false",
        SENTRY_NON_PRODUCTION_DSN: "https://public@o1.ingest.sentry.io/200",
        SENTRY_RELEASE: "malformed-release-sentinel",
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("application-imported");
    })
  );

  it.effect("shares the preload handoff across separately bundled entries", () =>
    Effect.gen(function* () {
      const fixtureRoot = `${process.cwd()}/.tmp/fidy-telemetry-bundle-${yield* Random.nextInt}`;
      const preloadEntry = `${fixtureRoot}/preload.ts`;
      const applicationEntry = `${fixtureRoot}/application.ts`;
      const bootstrapModule = `${process.cwd()}/src/shell/observability/telemetry-bootstrap.ts`;
      const disabledModule = `${process.cwd()}/src/shell/observability/disabled.ts`;
      yield* Effect.promise(() =>
        Promise.all([
          Bun.write(
            preloadEntry,
            `import { Result } from "effect";
import { DisabledTelemetryResource } from "${disabledModule}";
import { installTelemetryBootstrap } from "${bootstrapModule}";
if (Result.isFailure(installTelemetryBootstrap({ _tag: "Disabled", config: { _tag: "Disabled", environment: "local", capture: { errors: false, traces: false } }, resource: DisabledTelemetryResource }))) throw new Error("installation failed");`
          ),
          Bun.write(
            applicationEntry,
            `import { Result } from "effect";
import { getTelemetryBootstrap } from "${bootstrapModule}";
if (Result.isFailure(getTelemetryBootstrap())) throw new Error("preload handoff missing");
console.log("handoff-visible");`
          ),
        ])
      );
      const build = (entrypoint: string, naming: string): Effect.Effect<Bun.BuildOutput> =>
        Effect.promise(() =>
          Bun.build({ entrypoints: [entrypoint], outdir: fixtureRoot, naming, target: "bun" })
        );
      yield* build(preloadEntry, "preload.js");
      yield* build(applicationEntry, "application.js");
      const child = yield* Effect.sync(() =>
        Bun.spawn(
          ["bun", "--preload", `${fixtureRoot}/preload.js`, `${fixtureRoot}/application.js`],
          {
            stdout: "pipe",
            stderr: "pipe",
          }
        )
      );
      const [exitCode, stdout, stderr] = yield* Effect.all([
        Effect.promise(() => child.exited),
        Effect.promise(() => new Response(child.stdout).text()),
        Effect.promise(() => new Response(child.stderr).text()),
      ]);
      const cleanup = yield* Effect.sync(() => Bun.spawn(["rm", "-rf", fixtureRoot]));
      yield* Effect.promise(() => cleanup.exited);

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("handoff-visible");
    })
  );

  it.effect("installs one preload resource and rejects replacement", () =>
    Effect.gen(function* () {
      expect(Result.isFailure(getTelemetryBootstrap())).toBe(true);
      const bootstrap = yield* makeTelemetryBootstrap({
        config: disabledConfig,
        makeEnabled: () => Effect.die("disabled factory invoked"),
      });

      expect(Result.isSuccess(installTelemetryBootstrap(bootstrap))).toBe(true);
      expect(Result.isSuccess(getTelemetryBootstrap())).toBe(true);
      expect(Result.isFailure(installTelemetryBootstrap(bootstrap))).toBe(true);
      yield* Layer.build(SentryLive);
    })
  );
});
