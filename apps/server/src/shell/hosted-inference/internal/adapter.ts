import type { Effect, Option, Schema } from "effect";
import type { Prompt } from "effect/ai";
import type { TranscriptEntry } from "~/core/agent/contract";
import type {
  HostedActiveRequest,
  HostedInferenceError,
  HostedTextResult,
  HostedTextToolPolicy,
} from "~/shell/hosted-inference/contract";

export type HostedPromptProjection = Readonly<{
  prefix: ReadonlyArray<Prompt.MessageEncoded>;
  continuationTail: ReadonlyArray<Prompt.MessageEncoded>;
  suffix: ReadonlyArray<Prompt.MessageEncoded>;
  activeRequest: HostedActiveRequest;
}>;

export type PreparedStructuredExecution<Output, Requirements = never> = Readonly<{
  execute: Effect.Effect<Output, HostedInferenceError, Requirements>;
}>;

export type HostedStructuredAdapter<Requirements = never> = Readonly<{
  prepare: <Output, Encoded extends Readonly<Record<string, unknown>>>(
    input: Readonly<{
      messages: ReadonlyArray<Prompt.MessageEncoded>;
      objectName: string;
      outputSchema: Schema.Codec<Output, Encoded, never, never>;
    }>
  ) => Effect.Effect<PreparedStructuredExecution<Output, Requirements>, HostedInferenceError>;
}>;

export type HostedInferenceAdapter<Request, Continuation, Requirements = never> = Readonly<{
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
    HostedInferenceError,
    Requirements
  >;
  structured: HostedStructuredAdapter<Requirements>;
}>;
