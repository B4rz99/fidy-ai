/**
 * Broad Observability harness for serialized-exporter and preload compatibility tests. Production
 * modules use Observability's contract, operations, or runtime interfaces directly.
 */
import { Context, Effect, Layer } from "effect";
import {
  type RecordingClient,
  type RecordingTransportOutcome,
  isCurrentSentryClient,
  makeSentryRecordingClient,
  sentryClientInitializationCount,
} from "~/shell/observability/internal/sentry-adapter";
import {
  type TelemetryBootstrap,
  getTelemetryBootstrap,
  installTelemetryBootstrap,
} from "~/shell/observability/internal/telemetry-bootstrap";
import type {
  EnabledCapture,
  NonProductionTelemetryConfig,
} from "~/shell/observability/internal/telemetry-config";
import { Telemetry, makeTelemetryService } from "~/shell/observability/operations";
import { SentryLive } from "~/shell/observability/runtime";

export {
  getTelemetryBootstrap,
  installTelemetryBootstrap,
  isCurrentSentryClient,
  makeSentryRecordingClient,
  sentryClientInitializationCount,
  SentryLive,
  type NonProductionTelemetryConfig,
  type RecordingClient,
  type RecordingTransportOutcome,
  type TelemetryBootstrap,
};

/** Exact bytes passed to the isolated exporter transport after SDK serialization. */
export type EnvelopeRecorderService = {
  readonly serializedEnvelopes: Effect.Effect<ReadonlyArray<Uint8Array>>;
  readonly clear: Effect.Effect<void>;
};

/** Test observer for complete serialized exporter envelopes. */
export class EnvelopeRecorder extends Context.Service<EnvelopeRecorder, EnvelopeRecorderService>()(
  "@fidy/server/shell/testing/telemetry-harness/EnvelopeRecorder"
) {}

/** Deterministic capture, sampling, and transport controls for serialized-envelope tests. */
export type TelemetryEnvelopeRecordingOptions = Readonly<{
  capture: EnabledCapture;
  rootTraceRate: number;
  randomUnitInterval: () => number;
  transportOutcome: RecordingTransportOutcome;
}>;

/** Provides an isolated no-network exporter and exposes only its complete serialized bytes. */
export const telemetryEnvelopeRecording = (
  options: Partial<TelemetryEnvelopeRecordingOptions> = {}
): Layer.Layer<Telemetry | EnvelopeRecorder> =>
  Layer.effectContext(
    Effect.map(
      Effect.acquireRelease(
        Effect.sync(() => makeSentryRecordingClient(options)),
        (recording) => recording.close
      ),
      (recording) =>
        Context.make(Telemetry, makeTelemetryService(recording.adapter)).pipe(
          Context.add(
            EnvelopeRecorder,
            EnvelopeRecorder.of({
              serializedEnvelopes: recording.serializedEnvelopes,
              clear: recording.clear,
            })
          )
        )
    )
  );

/** Default complete-capture recording Layer with a successful isolated transport. */
export const TelemetryEnvelopeRecording = telemetryEnvelopeRecording();
