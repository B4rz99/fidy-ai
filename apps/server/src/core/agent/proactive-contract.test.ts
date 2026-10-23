import { expect, it } from "vitest";
import { Schema } from "effect";
import { ProactiveTranscriptEntry } from "./contract";

it("round-trips actual proactive transcript entries without inventing a requested Turn", () => {
  const identity = {
    id: "10000000-0000-4000-8000-000000000001",
    occurredAt: "2026-10-22T12:00:00.000Z",
    text: "Your reminder is ready",
  };
  const codec = Schema.toCodecJson(ProactiveTranscriptEntry);
  const entries = [
    { ...identity, _tag: "ProactiveInsightTranscriptEntry", insightEventId: identity.id },
    ...["budget-offer", "reminder-offer", "recurring-offer", "reminder-question"].map((role) => ({
      ...identity,
      _tag: "ProactiveMessageTranscriptEntry",
      deliveryId: identity.id,
      role,
    })),
  ];
  for (const value of entries) {
    expect(Schema.encodeSync(codec)(Schema.decodeSync(codec)(value))).toEqual(value);
  }
});
