#!/usr/bin/env bun

// A Sentry release links telemetry to the exact deployed Fidy code and its source maps.
import { prepareSentryRelease } from "~/shell/observability/release-preparation";

try {
  const release = await prepareSentryRelease();
  process.stdout.write(`Prepared immutable Sentry release ${release}.\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "unexpected failure";
  process.stderr.write(`Sentry release preparation failed: ${message}\n`);
  process.exitCode = 1;
}
