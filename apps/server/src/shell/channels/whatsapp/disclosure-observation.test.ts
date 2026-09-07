import { expect, it } from "@effect/vitest";
import { Context, Effect, Exit, Layer, Option, Ref, Schema } from "effect";
import {
  EnvelopeRecorder,
  TelemetryEnvelopeRecording,
} from "~/shell/observability/envelope-recorder";
import { ProjectedErrorEvent, ProjectedTransaction } from "~/shell/observability/projectors";
import { decodeEnvelopeItems } from "~/shell/testing/telemetry-fixtures";
import { DisclosureDeliveryAttemptNumber } from "./disclosure-model";
import {
  observeConsentDisclosureAttempt,
  observeConsentDisclosureQueue,
  observeConsentDisclosureResume,
  recordConsentDisclosureOutcome,
} from "./disclosure-observation";

const payloadsOf = <Decoded, Encoded>(
  schema: Schema.Codec<Decoded, Encoded>,
  envelopes: ReadonlyArray<Uint8Array>
): ReadonlyArray<Decoded> =>
  envelopes
    .flatMap(decodeEnvelopeItems)
    .flatMap((item) => Option.toArray(Schema.decodeUnknownOption(schema)(item)));

const firstAttempt = DisclosureDeliveryAttemptNumber.make(1);
const protectedValues = [
  "exchange-secret",
  "correlation-secret",
  "provider-message-secret",
  "body-secret",
  "+573001234567",
  "routing-secret",
];

it.effect(
  "observes finite attempt, resume and both queue handlers without exporting successful payloads",
  () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(TelemetryEnvelopeRecording);
      const recorder = Context.get(services, EnvelopeRecorder);
      const work = Effect.succeed(protectedValues);
      expect(
        yield* observeConsentDisclosureAttempt(work, firstAttempt).pipe(Effect.provide(services))
      ).toEqual(protectedValues);
      yield* observeConsentDisclosureResume(work).pipe(Effect.provide(services));
      yield* observeConsentDisclosureQueue(work, "start").pipe(Effect.provide(services));
      yield* observeConsentDisclosureQueue(work, "evidence").pipe(Effect.provide(services));
      const envelopes = yield* recorder.serializedEnvelopes;
      const transactions = payloadsOf(ProjectedTransaction, envelopes);
      expect(transactions.map((transaction) => transaction.transaction)).toEqual([
        "whatsapp.disclosureAttempt",
        "whatsapp.disclosureResume",
        "whatsapp.disclosureStart",
        "whatsapp.disclosureEvidence",
      ]);
      expect(transactions[0]?.contexts.trace.data["fidy.attempt"]).toBe(1);
      const serialized = envelopes.map((envelope) => new TextDecoder().decode(envelope)).join("\n");
      for (const value of protectedValues) expect(serialized).not.toContain(value);
    })
);

it.effect(
  "captures escaped failure once at resume rather than its child attempt, and at each queue handler",
  () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(TelemetryEnvelopeRecording);
      const recorder = Context.get(services, EnvelopeRecorder);
      const failure = { _tag: "PrivateFailure", body: protectedValues };
      const result = yield* Effect.exit(
        observeConsentDisclosureResume(
          observeConsentDisclosureAttempt(Effect.fail(failure), firstAttempt)
        ).pipe(Effect.provide(services))
      );
      expect(Exit.isFailure(result)).toBe(true);
      yield* Effect.exit(
        observeConsentDisclosureResume(Effect.die(new Error(protectedValues.join(" ")))).pipe(
          Effect.provide(services)
        )
      );
      yield* Effect.exit(
        observeConsentDisclosureQueue(Effect.fail(failure), "start").pipe(Effect.provide(services))
      );
      yield* Effect.exit(
        observeConsentDisclosureQueue(Effect.die(failure), "evidence").pipe(
          Effect.provide(services)
        )
      );
      const envelopes = yield* recorder.serializedEnvelopes;
      const errors = payloadsOf(ProjectedErrorEvent, envelopes);
      expect(errors.map(({ tags }) => [tags.operation, tags.error])).toEqual([
        ["whatsapp.disclosureResume", "operational_failure"],
        ["whatsapp.disclosureResume", "unexpected_defect"],
        ["whatsapp.disclosureStart", "operational_failure"],
        ["whatsapp.disclosureEvidence", "unexpected_defect"],
      ]);
      const serialized = envelopes.map((envelope) => new TextDecoder().decode(envelope)).join("\n");
      for (const value of protectedValues) expect(serialized).not.toContain(value);
    })
);

it.effect("preserves exact exits and records pure interruption without reporting a failure", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(TelemetryEnvelopeRecording);
    const recorder = Context.get(services, EnvelopeRecorder);
    const exits: ReadonlyArray<Effect.Effect<string, string>> = [
      Effect.succeed("value"),
      Effect.fail("private-failure"),
      Effect.die("private-defect"),
      Effect.interrupt,
    ];
    for (const work of exits) {
      const inner = yield* Ref.make(Option.none<Exit.Exit<string, string>>());
      const result = yield* Effect.exit(
        observeConsentDisclosureResume(
          work.pipe(Effect.onExit((exit) => Ref.set(inner, Option.some(exit))))
        ).pipe(Effect.provide(services))
      );
      expect(result).toEqual(Option.getOrThrow(yield* Ref.get(inner)));
    }
    for (const work of [
      observeConsentDisclosureAttempt(Effect.interrupt, firstAttempt),
      observeConsentDisclosureQueue(Effect.interrupt, "start"),
      observeConsentDisclosureQueue(Effect.interrupt, "evidence"),
    ]) {
      yield* Effect.exit(work.pipe(Effect.provide(services)));
    }
    const envelopes = yield* recorder.serializedEnvelopes;
    expect(payloadsOf(ProjectedErrorEvent, envelopes)).toHaveLength(2);
    expect(
      payloadsOf(ProjectedTransaction, envelopes).filter(
        ({ contexts }) => contexts.trace.data["fidy.outcome"] === "interrupted"
      )
    ).toHaveLength(4);
  })
);

it.effect(
  "declares truthful owner evidence without treating rejected or exhausted as workflow defects",
  () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(TelemetryEnvelopeRecording);
      const recorder = Context.get(services, EnvelopeRecorder);
      for (const outcome of [
        "sent",
        "delivered",
        "not-current",
        "ambiguous",
        "retrying",
        "rejected",
        "retry-exhausted",
      ] as const) {
        yield* observeConsentDisclosureResume(recordConsentDisclosureOutcome(outcome)).pipe(
          Effect.provide(services)
        );
      }
      const envelopes = yield* recorder.serializedEnvelopes;
      expect(payloadsOf(ProjectedErrorEvent, envelopes)).toHaveLength(0);
      const transactions = payloadsOf(ProjectedTransaction, envelopes);
      expect(transactions.map(({ contexts }) => contexts.trace.data["fidy.outcome"])).toEqual([
        "succeeded",
        "succeeded",
        "rejected",
        "failed",
        "failed",
        "rejected",
        "failed",
      ]);
      expect(transactions.at(-1)?.tags.error).toBe("disclosure_retry_exhausted");
    })
);

it.effect("keeps existing fixtures independent of an optional Telemetry service", () =>
  Effect.gen(function* () {
    expect(yield* observeConsentDisclosureAttempt(Effect.succeed(1), firstAttempt)).toBe(1);
    expect(yield* observeConsentDisclosureResume(Effect.succeed(2))).toBe(2);
    expect(yield* observeConsentDisclosureQueue(Effect.succeed(3), "start")).toBe(3);
    yield* recordConsentDisclosureOutcome("ambiguous");
  })
);
