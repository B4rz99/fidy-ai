import { Context, Data, type Effect, Layer, type Option } from "effect";
import type { CompactedConversationOutput } from "~/core/transcript/compacted-conversation";
import type { TranscriptEntry } from "~/core/transcript/model";

/** Private failure that keeps hosted-provider details out of ConversationContinuity's interface. */
export class ConversationCompactionInferenceError extends Data.TaggedError(
  "ConversationCompactionInferenceError"
)<{ readonly cause: unknown }> {}

/** Hosted model behavior needed privately by ConversationContinuity's Compaction workflow. */
export type ConversationCompactionInferenceService = Readonly<{
  countTranscript: (entries: ReadonlyArray<TranscriptEntry>) => Effect.Effect<number>;
  countText: (text: string) => Effect.Effect<number>;
  generate: (
    prior: Option.Option<string>,
    entries: ReadonlyArray<TranscriptEntry>
  ) => Effect.Effect<CompactedConversationOutput, ConversationCompactionInferenceError>;
}>;

/** Private hosted-model seam used only by ConversationContinuity's Compaction workflow. */
export class ConversationCompactionInference extends Context.Service<
  ConversationCompactionInference,
  ConversationCompactionInferenceService
>()("fidy-ai/shell/transcript/conversation-compaction-inference/ConversationCompactionInference") {
  /** Derives the private Compaction adapter from a complete hosted-inference implementation. */
  static readonly layer = <E, R>(
    service: Effect.Effect<ConversationCompactionInferenceService, E, R>
  ): Layer.Layer<ConversationCompactionInference, E, R> => Layer.effect(this, service);
}
