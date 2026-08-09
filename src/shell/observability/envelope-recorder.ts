import { Context, Effect, Layer } from "effect";
import { type RecordingTransportOutcome, makeSentryRecordingClient } from "./sentry-adapter";
import type { EnabledCapture } from "./telemetry-config";
import { Telemetry, makeTelemetryService } from "./telemetry";

/** Exact bytes passed to the isolated Sentry transport after SDK serialization. */
export type EnvelopeRecorderService = {
  readonly serializedEnvelopes: Effect.Effect<ReadonlyArray<Uint8Array>>;
  readonly clear: Effect.Effect<void>;
};

/** Test observer for complete serialized Sentry envelopes. */
export class EnvelopeRecorder extends Context.Service<EnvelopeRecorder, EnvelopeRecorderService>()(
  "fidy-ai/shell/observability/envelope-recorder/EnvelopeRecorder"
) {}

/** Deterministic capture, sampling, and transport controls for serialized-envelope tests. */
export type TelemetryEnvelopeRecordingOptions = Readonly<{
  capture: EnabledCapture;
  rootTraceRate: number;
  randomUnitInterval: () => number;
  transportOutcome: RecordingTransportOutcome;
}>;

/**
 * Provides Telemetry with an isolated no-network Sentry client and exposes only its complete
 * serialized transport bytes. Layer scope closes and flushes the private client.
 */
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

/** Default complete-capture recording layer with a successful isolated transport. */
export const TelemetryEnvelopeRecording = telemetryEnvelopeRecording();
