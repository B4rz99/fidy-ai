import { Effect, Result } from "effect";
import {
  TelemetryAlreadyInitialized,
  getTelemetryBootstrap,
  installTelemetryBootstrap,
  makeTelemetryBootstrap,
} from "./telemetry-bootstrap";
import { telemetryConfig } from "./telemetry-config";

if (Result.isSuccess(getTelemetryBootstrap())) throw new TelemetryAlreadyInitialized();

const bootstrap = await Effect.runPromise(
  Effect.flatMap(telemetryConfig, (config) =>
    makeTelemetryBootstrap({
      config,
      makeEnabled: (enabledConfig) =>
        Effect.promise(() => import("./sentry-adapter")).pipe(
          Effect.map(({ makeSentryTelemetry }) => makeSentryTelemetry(enabledConfig))
        ),
    })
  )
);

Result.match(installTelemetryBootstrap(bootstrap), {
  onFailure: (error) => {
    throw error;
  },
  onSuccess: () => undefined,
});
