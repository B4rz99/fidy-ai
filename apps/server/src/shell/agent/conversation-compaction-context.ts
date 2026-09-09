import { Option } from "effect";
import type { TranscriptEntry } from "~/core/transcript/model";
import type { HostedStructuredContext } from "./hosted-inference";
import { exactTranscriptPrompt } from "./model-boundary";

const systemInstruction =
  "Replace the prior compacted conversation and exact transcript with one faithful concise conversation record.";

/** Constructs the complete semantic Compaction context without exposing its prompt fragments. */
export const makeConversationCompactionContext = (input: {
  readonly prior: Option.Option<string>;
  readonly entries: ReadonlyArray<TranscriptEntry>;
}): HostedStructuredContext => ({
  messages: [
    { role: "system", content: systemInstruction },
    ...Option.match(input.prior, {
      onNone: () => [],
      onSome: (text) => [{ role: "user" as const, content: text }],
    }),
    ...exactTranscriptPrompt(input.entries),
  ],
});

/** Production-shaped synthetic context used only by the explicit hosted conformance workflow. */
export const makeSyntheticConversationCompactionContext = (): Readonly<{
  messages: readonly [
    Readonly<{ role: "system"; content: string }>,
    Readonly<{ role: "user"; content: string }>,
    Readonly<{ role: "user"; content: string }>,
    Readonly<{ role: "assistant"; content: string }>,
  ];
}> => ({
  messages: [
    { role: "system", content: systemInstruction },
    { role: "user", content: "Earlier compacted conversation: the User tracks a grocery budget." },
    { role: "user", content: "User: I paid COP 48,900 for groceries." },
    { role: "assistant", content: "Assistant: I recorded the grocery purchase." },
  ],
});
