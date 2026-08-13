import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Exit, Schema } from "effect";
import { CompactedConversation, CompactedConversationOutput } from "./compacted-conversation";

const decodeConversation = Schema.decodeUnknownEffect(CompactedConversation);
const decodeOutput = Schema.decodeUnknownEffect(CompactedConversationOutput);

it.effect("accepts only positive revisions and non-negative cursors", () =>
  Effect.gen(function* () {
    const validConversation = {
      text: "resumen",
      throughSequence: 0n,
      revision: 1n,
      updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
    };
    expect(Exit.isSuccess(yield* Effect.exit(decodeConversation(validConversation)))).toBe(true);
    expect(
      Exit.isFailure(
        yield* Effect.exit(decodeConversation({ ...validConversation, throughSequence: -1n }))
      )
    ).toBe(true);
    expect(
      Exit.isFailure(yield* Effect.exit(decodeConversation({ ...validConversation, revision: 0n })))
    ).toBe(true);
  })
);

it.effect("rejects empty or structurally malformed hosted replacements", () =>
  Effect.gen(function* () {
    expect(
      Exit.isSuccess(yield* Effect.exit(decodeOutput({ compactedConversation: "fiel" })))
    ).toBe(true);
    expect(Exit.isFailure(yield* Effect.exit(decodeOutput({ compactedConversation: "" })))).toBe(
      true
    );
    expect(Exit.isFailure(yield* Effect.exit(decodeOutput({ compactedConversation: 42 })))).toBe(
      true
    );
  })
);
