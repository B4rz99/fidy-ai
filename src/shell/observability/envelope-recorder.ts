import { Context, Effect, Layer } from "effect";
import { makeSentryRecordingClient } from "./sentry-adapter";
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

/**
 * Provides Telemetry with an isolated no-network Sentry client and exposes only its complete
 * serialized transport bytes. Layer scope closes and flushes the private client.
 */
export const TelemetryEnvelopeRecording = Layer.effectContext(
  Effect.map(
    Effect.acquireRelease(Effect.sync(makeSentryRecordingClient), (recording) => recording.close),
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
