import { expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { EnvelopeRecorder, TelemetryEnvelopeRecording } from "./envelope-recorder";
import { recordSentryAccountSmoke } from "./sentry-account-smoke";
import { Telemetry } from "./telemetry";

it.effect("emits one metadata-only defect through the ordinary Telemetry boundary", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(TelemetryEnvelopeRecording);
    const telemetry = Context.get(services, Telemetry);
    const recorder = Context.get(services, EnvelopeRecorder);

    yield* recordSentryAccountSmoke(telemetry);
    const envelopes = yield* recorder.serializedEnvelopes;
    const serialized = envelopes.map((envelope) => new TextDecoder().decode(envelope)).join("\n");

    expect(envelopes).toHaveLength(1);
    expect(serialized).toContain('"component":"ci"');
    expect(serialized).toContain('"operation":"observability.accountSmoke"');
    expect(serialized).toContain('"error":"unexpected_defect"');
    expect(serialized).not.toContain("SENTRY_AUTH_TOKEN");
    expect(serialized).not.toContain("SENTRY_DSN");
  })
);
