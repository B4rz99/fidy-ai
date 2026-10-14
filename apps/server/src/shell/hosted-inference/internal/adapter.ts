import type { Effect, Option, Schema } from "effect";
import type { Prompt } from "effect/ai";
import type { TranscriptEntry } from "~/core/agent/contract";
import type {
  HostedInferenceError,
  HostedTextResult,
  HostedTextToolPolicy,
} from "~/shell/hosted-inference/contract";

export type HostedPromptProjection = Readonly<{
  prefix: ReadonlyArray<Prompt.MessageEncoded>;
  continuationTail: ReadonlyArray<Prompt.MessageEncoded>;
  suffix: ReadonlyArray<Prompt.MessageEncoded>;
  activeRequest: Readonly<{ _tag: "Absent" }> | Readonly<{ _tag: "Present"; text: string }>;
}>;

export type PreparedStructuredExecution<Output> = Readonly<{
  execute: Effect.Effect<Output, HostedInferenceError>;
}>;

export type HostedStructuredAdapter = Readonly<{
  prepare: <Output, Encoded extends Readonly<Record<string, unknown>>>(
    input: Readonly<{
      messages: ReadonlyArray<Prompt.MessageEncoded>;
      objectName: string;
      outputSchema: Schema.Codec<Output, Encoded, never, never>;
    }>
  ) => Effect.Effect<PreparedStructuredExecution<Output>, HostedInferenceError>;
}>;

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
