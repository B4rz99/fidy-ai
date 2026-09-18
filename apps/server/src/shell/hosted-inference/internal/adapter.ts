import type { Effect, Option, Schema } from "effect";
import type { Prompt } from "effect/unstable/ai";
import type { TranscriptEntry } from "~/core/transcript/model";
import type {
  HostedInferenceError,
  HostedTextResult,
  HostedTextToolPolicy,
} from "~/shell/hosted-inference/contract";

/** Provider-private prompt projection prepared from ordered semantic context. */
export type HostedPromptProjection = Readonly<{
  prefix: ReadonlyArray<Prompt.MessageEncoded>;
  continuationTail: ReadonlyArray<Prompt.MessageEncoded>;
  suffix: ReadonlyArray<Prompt.MessageEncoded>;
  activeRequest: Readonly<{ _tag: "Absent" }> | Readonly<{ _tag: "Present"; text: string }>;
}>;

/** Adapter-private executable retaining one exact request and output decoder. */
export type PreparedStructuredExecution<Output> = Readonly<{
  execute: Effect.Effect<Output, HostedInferenceError>;
}>;

/** Provider implementation of exact strict structured preparation. */
export type HostedStructuredAdapter = Readonly<{
  prepare: <Output, Encoded extends Readonly<Record<string, unknown>>>(
    input: Readonly<{
      messages: ReadonlyArray<Prompt.MessageEncoded>;
      objectName: string;
      outputSchema: Schema.Codec<Output, Encoded, never, never>;
    }>
  ) => Effect.Effect<PreparedStructuredExecution<Output>, HostedInferenceError>;
}>;

/** Private provider implementation of preparation, execution, and token measurement. */
export type HostedInferenceAdapter<Request, Continuation> = Readonly<{
  countText: (text: string) => Effect.Effect<number>;
  countTranscript: (entries: ReadonlyArray<TranscriptEntry>) => Effect.Effect<number>;
  prepare: (
    input: Readonly<{
      basePrefix: ReadonlyArray<Prompt.MessageEncoded>;
      projection: HostedPromptProjection;
      continuation: Option.Option<Continuation>;
    }> &
      HostedTextToolPolicy
  ) => Effect.Effect<Request, HostedInferenceError>;
  execute: (
    request: Request
  ) => Effect.Effect<
    Readonly<{ result: Omit<HostedTextResult, "continuation">; continuation: Continuation }>,
    HostedInferenceError
  >;
  structured: HostedStructuredAdapter;
}>;
