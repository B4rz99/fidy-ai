import { it } from "@effect/vitest";
import { Effect, Exit, Function as Fn, Layer, Option, Random, Result } from "effect";
import { describe, expect, vi } from "vitest";
import {
  getTelemetryBootstrap,
  installTelemetryBootstrap,
  makeTelemetryBootstrap,
} from "./telemetry-bootstrap";
import type { TelemetryConfig } from "./telemetry-config";
import { DisabledTelemetryResource } from "./disabled";
import { SentryLive } from "./sentry-live";
import type { TelemetrySpan } from "./telemetry";

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
      const span = Fn.cast<unknown, TelemetrySpan>({});
      expect(
        Option.isNone(yield* adapter.startSpan(Fn.cast<unknown, never>({}), Option.none()))
      ).toBe(true);
      yield* adapter.finishSpan(span, Exit.succeed(undefined));
      yield* adapter.recordOutcome(span, Fn.cast<unknown, never>({}));
      yield* adapter.captureFailure(Option.none(), Fn.cast<unknown, never>({}));
      yield* adapter.addBreadcrumb(span, Fn.cast<unknown, never>({}));
    })
  );

  it.effect("creates and exposes exactly one enabled client", () =>
    Effect.gen(function* () {
      const client = {};
      const config = Fn.cast<unknown, TelemetryConfig>({
        _tag: "NonProductionEnabled",
        environment: "local",
        project: "non-production",
        capture: { errors: true, traces: true },
        dsn: "https://public@o1.ingest.sentry.io/200",
        release: "fidy@0123456789abcdef0123456789abcdef01234567",
        errorSampleRate: 1,
        rootTraceRate: 1,
      });
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
