import { Function as Fn } from "effect";
import { makeSentryRecordingClient } from "~/shell/observability/sentry-adapter";
import { installTelemetryBootstrap } from "~/shell/observability/telemetry-bootstrap";
import type { NonProductionTelemetryConfig } from "~/shell/observability/telemetry-config";
import { installCompatibilityRecorder, requireInstalled } from "./handoff";

const transportOutcome = process.env["FIDY_COMPATIBILITY_TRANSPORT"];
if (
  transportOutcome !== "accepted" &&
  transportOutcome !== "rate-limited" &&
  transportOutcome !== "failed"
) {
  throw new Error("FIDY_COMPATIBILITY_TRANSPORT must name a supported fixture outcome");
}

const config: NonProductionTelemetryConfig = {
  _tag: "NonProductionEnabled",
  environment: "ci",
  project: "non-production",
  capture: { errors: true, traces: true },
  dsn: Fn.cast<string, NonProductionTelemetryConfig["dsn"]>("https://public@example.invalid/1"),
  release: "fidy@0000000000000000000000000000000000000000",
  errorSampleRate: 1,
  rootTraceRate: 1,
};

const recorder = makeSentryRecordingClient({ transportOutcome, bindCurrentClient: true });
requireInstalled(
  installTelemetryBootstrap({
    _tag: "Enabled",
    config,
    client: recorder.client,
    resource: recorder.resource,
  })
);
installCompatibilityRecorder(recorder);
