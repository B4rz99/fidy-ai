import { Data, type DateTime, type Effect, type Option, Schema } from "effect";
import type { Brand, Duration } from "effect";
import type { Response } from "effect/unstable/ai";
import type { CanonicalOperationId } from "~/core/canonical-operations/contract";
import type { User } from "~/core/identity/model";
import type { TranscriptEntry } from "~/core/transcript/model";

/** Ordered semantic material projected by Agent without exposing provider prompt fragments. */
export type HostedContextSection =
  | Readonly<{
      _tag: "AssistantPolicy";
      user: Pick<User, "serviceMarket" | "locale" | "timeZone">;
    }>
  | Readonly<{ _tag: "TurnStarted"; startedAt: DateTime.Utc }>
  | Readonly<{ _tag: "ContinuityBoundary"; boundary: "open" | "close" }>
  | Readonly<{ _tag: "Memory"; text: string }>
  | Readonly<{ _tag: "CompactedConversation"; text: string }>
  | Readonly<{ _tag: "Transcript"; entry: TranscriptEntry }>
  | Readonly<{
      _tag: "ToolResult";
      toolCallId: Extract<
        TranscriptEntry,
        { readonly _tag: "CanonicalToolResultEntry" }
      >["toolCallId"];
      operation: CanonicalOperationId;
      outcome: Extract<TranscriptEntry, { readonly _tag: "CanonicalToolResultEntry" }>["outcome"];
    }>
  | Readonly<{ _tag: "InvalidOutputFeedback"; description: string }>;

/** Immutable Agent-owned semantic ordering around provider-owned continuation state. */
export type HostedTextContext = Readonly<{
  sections: ReadonlyArray<HostedContextSection>;
  activeRequest: Readonly<{ _tag: "Absent" }> | Readonly<{ _tag: "Present"; text: string }>;
}>;

/** Initial hosted context constructed and ordered only by WorkingContext. */
export type HostedInitialTextContext = HostedTextContext &
  Readonly<{ activeRequest: Readonly<{ _tag: "Present"; text: string }> }> &
  Brand.Brand<"HostedInitialTextContext">;

/** Agent-owned semantic evidence for one structured conversation compaction. */
export type HostedStructuredContext = Readonly<{
  prior: Option.Option<string>;
  entries: ReadonlyArray<TranscriptEntry>;
}>;
/**
 * One-shot text authority. `execute` is valid initially and remains valid only after a retryable
 * ProviderUnavailable failure. InvalidOutput permits exactly one `recover`; terminal failures do
 * not. `discard` is valid before execution or after InvalidOutput and consumes the authority.
 */
export type PreparedHostedText = Readonly<{
  execute: Effect.Effect<HostedTextResult, HostedInferenceError>;
  recover: Effect.Effect<HostedTextContinuation, HostedInferenceError>;
  discard: Effect.Effect<void, HostedInferenceError>;
}> &
  Brand.Brand<"PreparedHostedText">;

/**
 * One-shot strict structured authority. `execute` is valid initially and can be retried only after
 * a retryable ProviderUnavailable failure. `discard` is valid before execution or after a retryable
 * ProviderUnavailable failure, and consumes the authority. Every other completion consumes it.
 */
export type PreparedHostedStructured<Output> = Readonly<{
  execute: Effect.Effect<Output, HostedInferenceError>;
  discard: Effect.Effect<void, HostedInferenceError>;
}> &
  Brand.Brand<"PreparedHostedStructured">;

/** Semantic evidence that may extend an already prepared hosted Turn. */
export type HostedContinuationEvent = Extract<
  HostedContextSection,
  { readonly _tag: "ToolResult" | "InvalidOutputFeedback" }
>;

/**
 * One-shot adapter-local continuation. `prepare` accepts only the next round's semantic evidence,
 * retains the prior provider state and remaining tool policy internally, and consumes this
 * continuation after successful preparation. A preparation failure restores it for retry.
 */
export type HostedTextContinuation = Readonly<{
  prepare: (
    events: ReadonlyArray<HostedContinuationEvent>
  ) => Effect.Effect<PreparedHostedText, HostedInferenceError>;
}> &
  Brand.Brand<"HostedTextContinuation">;

/** Provider-neutral structured generation purpose. */
export type HostedStructuredPurpose = "conversation-compaction";

/** Domain schema and semantic context for one strict structured generation. */
export type HostedStructuredRequest<
  Output,
  Encoded extends Readonly<Record<string, unknown>>,
> = Readonly<{
  context: HostedStructuredContext;
  purpose: HostedStructuredPurpose;
  outputSchema: Schema.Codec<Output, Encoded, never, never>;
}>;

/** Allowlisted invalid-output descriptions safe for retry feedback and telemetry. */
export type HostedInvalidOutputDescription =
  | "Semantic hosted text projection was invalid"
  | "Hosted provider response was invalid"
  | "Hosted tool arguments were invalid"
  | "Deterministic hosted output was invalid"
  | "Deterministic model exceeded the hosted tool-call limit"
  | "Hosted structured schema was invalid"
  | "Hosted structured provider response was invalid"
  | "Hosted structured output was malformed";

/** Closed hosted inference failure vocabulary. */
export type HostedInferenceFailureReason =
  | Readonly<{ _tag: "InvalidAuthority" }>
  | Readonly<{ _tag: "CapacityExceeded"; inputTokens: number }>
  | Readonly<{
      _tag: "ActiveRequestCapacityExceeded";
      inputTokens: number;
      maximumTokens: number;
    }>
  | Readonly<{ _tag: "InvalidOutput"; description: HostedInvalidOutputDescription }>
  | Readonly<{ _tag: "ProviderUnavailable" }>
  | Readonly<{ _tag: "StructuredOutputExceeded" }>
  | Readonly<{ _tag: "StructuredOutputTimedOut" }>;

const hostedInferenceErrorMessages: Readonly<Record<HostedInferenceFailureReason["_tag"], string>> =
  {
    InvalidAuthority: "The hosted inference authority is invalid for this adapter",
    CapacityExceeded: "The complete hosted request exceeds provider capacity",
    ActiveRequestCapacityExceeded: "The active User request exceeds its token capacity",
    InvalidOutput: "The hosted provider returned invalid output",
    ProviderUnavailable: "The hosted provider is unavailable",
    StructuredOutputExceeded: "The hosted structured response exceeded its bound",
    StructuredOutputTimedOut: "The hosted structured request timed out",
  };

/** Safe failure returned by preparation or execution without exposing provider request content. */
export class HostedInferenceError extends Data.TaggedError("HostedInferenceError")<{
  readonly reason: HostedInferenceFailureReason;
  readonly retryable: boolean;
  readonly retryAfter: Option.Option<Duration.Duration>;
}> {
  override get message(): string {
    return hostedInferenceErrorMessages[this.reason._tag];
  }
}

/** Positive maximum for one tools-enabled hosted request. */
export const HostedToolCallMaximum = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("HostedToolCallMaximum")
);
export type HostedToolCallMaximum = typeof HostedToolCallMaximum.Type;

/** Caller-visible canonical operations plus whether calls are forbidden or bounded. */
export type HostedTextToolPolicy = Readonly<{
  availableOperations: ReadonlyArray<CanonicalOperationId>;
}> &
  (
    | Readonly<{ toolChoice: "none" }>
    | Readonly<{ toolChoice: "auto"; maximumToolCalls: HostedToolCallMaximum }>
  );

/** One initial semantic request; later rounds are prepared directly by their continuation. */
export type HostedTextRequest = Readonly<{ context: HostedInitialTextContext }> &
  HostedTextToolPolicy;

/**
 * One semantic context whose complete provider request is capacity-checked without creating
 * executable authority. Initial and continuation contexts both validate through it.
 */
export type HostedTextValidationRequest = Readonly<{ context: HostedTextContext }> &
  HostedTextToolPolicy;

/** Provider-neutral usage needed by bounded telemetry. */
export type HostedTextUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}>;

/** Provider-neutral function call returned for canonical validation and execution. */
export type HostedTextToolCall = Readonly<{
  id: string;
  operation: CanonicalOperationId;
  params: unknown;
}>;

/** Provider-neutral reason that hosted generation stopped, derived from the Effect AI finish reason. */
export type HostedFinishReason = Response.FinishReason;

/** Accepted hosted text generation plus an opaque adapter-local continuation. */
export type HostedTextResult = Readonly<{
  text: unknown;
  toolCalls: ReadonlyArray<HostedTextToolCall>;
  finishReason: HostedFinishReason;
  usage: HostedTextUsage;
  continuation: HostedTextContinuation;
}>;

/** Provider-neutral hosted inference interface shared by live turns and startup validation. */
export type HostedInferenceService = Readonly<{
  /** Counts one canonical plain-text aggregate using provider-owned tokenization. */
  countText: (text: string) => Effect.Effect<number>;
  /** Counts exact semantic Transcript messages using provider-owned tokenization and framing. */
  countTranscript: (entries: ReadonlyArray<TranscriptEntry>) => Effect.Effect<number>;
  /** Prepares semantic context as a one-shot exact complete request. */
  prepareText: (
    request: HostedTextRequest
  ) => Effect.Effect<PreparedHostedText, HostedInferenceError>;
  /** Prepares and capacity-checks a request without creating executable authority. */
  validateText: (request: HostedTextValidationRequest) => Effect.Effect<void, HostedInferenceError>;
  /** Stores one exact strict request with its matching decoder as one-shot executable work. */
  prepareStructured: <Output, Encoded extends Readonly<Record<string, unknown>>>(
    request: HostedStructuredRequest<Output, Encoded>
  ) => Effect.Effect<PreparedHostedStructured<Output>, HostedInferenceError>;
}>;

/** Provider-neutral deterministic behavior for cross-module hosted test doubles. */
export type HostedInferenceStubBehavior = Readonly<{
  countText: HostedInferenceService["countText"];
  countTranscript: HostedInferenceService["countTranscript"];
  validateText: HostedInferenceService["validateText"];
  prepareStructured: HostedInferenceService["prepareStructured"];
  generate: (
    contexts: ReadonlyArray<HostedTextContext>,
    policy: HostedTextToolPolicy
  ) => Effect.Effect<Omit<HostedTextResult, "continuation">, HostedInferenceError>;
}>;
