import { Data, Effect, Function as Fn, Result } from "effect";
import { DisabledTelemetryResource } from "./disabled";
import type {
  NonProductionTelemetryConfig,
  ProductionTelemetryConfig,
  TelemetryConfig,
} from "./telemetry-config";
import type { TelemetryResource } from "./telemetry";

type EnabledConfig = ProductionTelemetryConfig | NonProductionTelemetryConfig;

type EnabledTelemetry = Readonly<{
  client: unknown;
  resource: TelemetryResource;
}>;

/** Single preload-owned handoff consumed by runtime assembly. */
export type TelemetryBootstrap =
  | Readonly<{
      _tag: "Disabled";
      config: Extract<TelemetryConfig, { readonly _tag: "Disabled" }>;
      resource: TelemetryResource;
    }>
  | Readonly<{
      _tag: "Enabled";
      config: EnabledConfig;
      client: unknown;
      resource: TelemetryResource;
    }>;

/** Signals an attempted replacement of the process telemetry handoff. */
export class TelemetryAlreadyInitialized extends Data.TaggedError("TelemetryAlreadyInitialized") {}

/** Signals runtime assembly without the required early telemetry preload. */
export class TelemetryPreloadMissing extends Data.TaggedError("TelemetryPreloadMissing") {}

/**
 * Selects the disabled resource or asks the caller for one enabled client/resource pair. The
 * enabled callback is never evaluated for disabled configuration.
 */
export const makeTelemetryBootstrap = (options: {
  readonly config: TelemetryConfig;
  readonly makeEnabled: (config: EnabledConfig) => Effect.Effect<EnabledTelemetry>;
}): Effect.Effect<TelemetryBootstrap> => {
  const { config } = options;
  if (config._tag === "Disabled") {
    return Effect.succeed<TelemetryBootstrap>({
      _tag: "Disabled",
      config,
      resource: DisabledTelemetryResource,
    });
  }
  return Effect.map(options.makeEnabled(config), (enabled): TelemetryBootstrap => ({
    _tag: "Enabled",
    config,
    ...enabled,
  }));
};

const bootstrapKey = Symbol.for("@fidy/server/shell/observability/telemetry-bootstrap");

/** Installs the preload-owned client/resource exactly once for runtime assembly. */
export const installTelemetryBootstrap = (
  bootstrap: TelemetryBootstrap
): Result.Result<void, TelemetryAlreadyInitialized> => {
  if (Reflect.has(globalThis, bootstrapKey)) {
    return Result.fail(new TelemetryAlreadyInitialized());
  }
  Reflect.set(globalThis, bootstrapKey, bootstrap);
  return Result.succeed(undefined);
};

/** Reads the preload handoff without ever falling back to late SDK initialization. */
export const getTelemetryBootstrap = (): Result.Result<
  TelemetryBootstrap,
  TelemetryPreloadMissing
> => {
  const globals = Fn.cast<unknown, Readonly<Record<PropertyKey, unknown>>>(globalThis);
  const value = globals[bootstrapKey];
  return value === undefined
    ? Result.fail(new TelemetryPreloadMissing())
    : Result.succeed(Fn.cast<unknown, TelemetryBootstrap>(value));
};
