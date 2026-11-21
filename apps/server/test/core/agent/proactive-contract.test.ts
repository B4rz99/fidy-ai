import { expect, it } from "vitest";
import { DateTime, Schema } from "effect";
import {
  ProactiveInsightTranscriptEntry,
  ProactiveMessageTranscriptEntry,
  ProactiveTranscriptEntry,
} from "~/core/agent/contract";

it("round-trips actual proactive transcript entries without inventing a requested Turn", () => {
  const wire = {
    id: "10000000-0000-4000-8000-000000000001",
    occurredAt: "2026-10-22T12:00:00.000Z",
    text: "Your reminder is ready",
  };

  const identity = {
    id: Schema.decodeSync(ProactiveInsightTranscriptEntry.fields.id)(wire.id),
    occurredAt: DateTime.makeUnsafe(wire.occurredAt),
    text: Schema.decodeSync(ProactiveInsightTranscriptEntry.fields.text)(wire.text),
  };

  const codec = Schema.toCodecJson(ProactiveTranscriptEntry);

  const entries = [
    ProactiveInsightTranscriptEntry.make({
      ...identity,
      insightEventId: Schema.decodeSync(ProactiveInsightTranscriptEntry.fields.insightEventId)(
        wire.id
      ),
    }),
    ...(["budget-offer", "reminder-offer", "recurring-offer", "reminder-question"] as const).map(
      (role) =>
        ProactiveMessageTranscriptEntry.make({
          ...identity,
          deliveryId: Schema.decodeSync(ProactiveMessageTranscriptEntry.fields.deliveryId)(wire.id),
          role,
        })
    ),
  ];

  for (const value of entries) {
    const encoded = Schema.encodeSync(codec)(value);

    expect(encoded).toMatchObject(wire);
    expect(Schema.decodeSync(codec)(encoded)).toEqual(value);
    expect(Schema.encodeSync(codec)(Schema.decodeSync(codec)(encoded))).toEqual(encoded);
  }
});
