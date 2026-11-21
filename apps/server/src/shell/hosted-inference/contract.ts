import {
  type Brand,
  type Cause,
  Data,
  type DateTime,
  type Duration,
  type Effect,
  type JsonSchema,
  type Option,
  Schema,
} from "effect";
import type { Response } from "effect/ai";
import type { CanonicalOperationId } from "~/core/canonical-operations/contract";
import type { User } from "~/core/identity/contract";
import {
  type ProactiveTranscriptEntry,
  type TranscriptEntry,
  maximumToolCallsPerTurn,
} from "~/core/agent/contract";

export type HostedConversationChannel = "web" | "whatsapp";

type CanonicalToolResultEntry = Data.TaggedEnum.Value<TranscriptEntry, "CanonicalToolResultEntry">;

export type HostedContextSection = Data.TaggedEnum<{
  AssistantPolicy: {
    readonly channel: HostedConversationChannel;
    readonly user: Pick<User, "serviceMarket" | "locale" | "timeZone">;
  };
  TurnStarted: { readonly startedAt: DateTime.Utc; readonly timeZone: string };
  ContinuityBoundary: { readonly boundary: "open" | "close" };
  Memory: { readonly text: string };
  CompactedConversation: { readonly text: string };
  Transcript: { readonly entry: TranscriptEntry };
  ProactiveReply: { readonly entry: ProactiveTranscriptEntry };
  ToolResult: {
    readonly toolCallId: CanonicalToolResultEntry["toolCallId"];
    readonly operation: CanonicalOperationId;
    readonly outcome: CanonicalToolResultEntry["outcome"];
  };
  InvalidOutputFeedback: { readonly description: string };
}>;

export const HostedContextSection = Data.taggedEnum<HostedContextSection>();

export type HostedActiveRequest = Data.TaggedEnum<{
  Absent: {};
  Present: { readonly text: string };
}>;

export const HostedActiveRequest = Data.taggedEnum<HostedActiveRequest>();

export type HostedTextContext = Readonly<{
  sections: ReadonlyArray<HostedContextSection>;
  activeRequest: HostedActiveRequest;
}>;

export type HostedInitialTextContext = HostedTextContext &
  Readonly<{ activeRequest: Data.TaggedEnum.Value<HostedActiveRequest, "Present"> }> &
  Brand.Brand<"HostedInitialTextContext">;

export type HostedStructuredContext = Readonly<{
  prior: Option.Option<string>;
  entries: ReadonlyArray<TranscriptEntry>;
}>;

export type PreparedHostedText = Readonly<{
  execute: Effect.Effect<HostedTextResult, HostedInferenceError>;
  repairInvalidOutput: Effect.Effect<PreparedHostedText, HostedInferenceError>;
  discard: Effect.Effect<void, HostedInferenceError>;
}> &
  Brand.Brand<"PreparedHostedText">;

export type PreparedHostedStructured<Output> = Readonly<{
  execute: Effect.Effect<Output, HostedInferenceError>;
  discard: Effect.Effect<void, HostedInferenceError>;
}> &
  Brand.Brand<"PreparedHostedStructured">;

export type HostedContinuationEvent = Data.TaggedEnum.Value<
  HostedContextSection,
  "ToolResult" | "InvalidOutputFeedback"
>;

export type HostedTextContinuation = Readonly<{
  prepare: (
    events: ReadonlyArray<HostedContinuationEvent>
  ) => Effect.Effect<PreparedHostedText, HostedInferenceError>;
}> &
  Brand.Brand<"HostedTextContinuation">;

export type HostedStructuredPurpose = "conversation-compaction";

export type HostedStructuredRequest<
  Output,
  Encoded extends Readonly<Record<string, unknown>>,
> = Readonly<{
  context: HostedStructuredContext;
  purpose: HostedStructuredPurpose;
  outputSchema: Schema.Codec<Output, Encoded, never, never>;
}>;

export type HostedInvalidOutputDescription =
  | "Semantic hosted text projection was invalid"
  | "Hosted provider response was invalid"
  | "Hosted tool arguments were invalid"
  | "Deterministic hosted output was invalid"
  | "Deterministic model exceeded the hosted tool-call limit"
  | "Hosted structured schema was invalid"
  | "Hosted structured provider response was invalid"
  | "Hosted structured output was malformed";

export type HostedInferenceFailureReason = Data.TaggedEnum<{
  InvalidAuthority: {};
  CapacityExceeded: { readonly inputTokens: number };
  ActiveRequestCapacityExceeded: { readonly inputTokens: number; readonly maximumTokens: number };
  InvalidOutput: { readonly description: HostedInvalidOutputDescription };
  ProviderUnavailable: {};
  ProviderQuotaExceeded: {};
  ResourceLimit: {};
  AdmissionUnavailable: {};
  StructuredOutputExceeded: {};
  StructuredOutputTimedOut: {};
}>;

export const HostedInferenceFailureReason = Data.taggedEnum<HostedInferenceFailureReason>();

const hostedInferenceErrorMessages: Readonly<Record<HostedInferenceFailureReason["_tag"], string>> =
  {
    InvalidAuthority: "The hosted inference authority is invalid for this adapter",
    CapacityExceeded: "The complete hosted request exceeds provider capacity",
    ActiveRequestCapacityExceeded: "The active User request exceeds its token capacity",
    InvalidOutput: "The hosted provider returned invalid output",
    ProviderUnavailable: "The hosted provider is unavailable",
    ProviderQuotaExceeded: "The hosted provider allocation is exhausted",
    ResourceLimit: "Hosted inference resource admission was refused",
    AdmissionUnavailable: "Hosted inference admission authority is unavailable",
    StructuredOutputExceeded: "The hosted structured response exceeded its bound",
    StructuredOutputTimedOut: "The hosted structured request timed out",
  };

export class HostedInferenceError extends Data.TaggedError("HostedInferenceError")<{
  readonly reason: HostedInferenceFailureReason;
  readonly retryable: boolean;
  readonly retryAfter: Option.Option<Duration.Duration>;
}> {
  override get message(): string {
    return hostedInferenceErrorMessages[this.reason._tag];
  }
}

export const HostedToolCallMaximum = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(maximumToolCallsPerTurn)
).pipe(Schema.brand("HostedToolCallMaximum"));

export type HostedToolCallMaximum = typeof HostedToolCallMaximum.Type;

export type HostedTextToolPolicy = Readonly<{
  availableOperations: ReadonlyArray<CanonicalOperationId>;
}> &
  (
    | Readonly<{ toolChoice: "none" }>
    | Readonly<{ toolChoice: "auto"; maximumToolCalls: HostedToolCallMaximum }>
  );

export type HostedTextRequest = Readonly<{ context: HostedInitialTextContext }> &
  HostedTextToolPolicy;

export type HostedTextValidationRequest = Readonly<{ context: HostedTextContext }> &
  HostedTextToolPolicy;

export type HostedTextUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}>;

export type HostedTextToolCall = Readonly<{
  id: string;
  operation: CanonicalOperationId;
  params: unknown;
}>;

export type HostedFinishReason = Response.FinishReason;

export type HostedTextResult = Readonly<{
  text: unknown;
  toolCalls: ReadonlyArray<HostedTextToolCall>;
  finishReason: HostedFinishReason;
  usage: HostedTextUsage;
  continuation: HostedTextContinuation;
}>;

export type HostedInferenceService = Readonly<{
  countText: (text: string) => Effect.Effect<number>;
  countTranscript: (entries: ReadonlyArray<TranscriptEntry>) => Effect.Effect<number>;
  prepareText: (
    request: HostedTextRequest
  ) => Effect.Effect<PreparedHostedText, HostedInferenceError>;
  validateText: (request: HostedTextValidationRequest) => Effect.Effect<void, HostedInferenceError>;
  prepareStructured: <Output, Encoded extends Readonly<Record<string, unknown>>>(
    request: HostedStructuredRequest<Output, Encoded>
  ) => Effect.Effect<PreparedHostedStructured<Output>, HostedInferenceError>;
}>;

export type HostedInferenceStubBehavior = Readonly<{
  countText: HostedInferenceService["countText"];
  countTranscript: HostedInferenceService["countTranscript"];
  validate: () => Effect.Effect<void, HostedInferenceError>;
  generate: (
    policy: HostedTextToolPolicy
  ) => Effect.Effect<Omit<HostedTextResult, "continuation">, HostedInferenceError>;
  generateStructured: <Output, Encoded extends Readonly<Record<string, unknown>>>(
    outputSchema: Schema.Codec<Output, Encoded, never, never>
  ) => Effect.Effect<Output, HostedInferenceError>;
}>;

const approvedOpenAiModelId = "gpt-6-luna" as const;

export const ApprovedOpenAiModel = Schema.Literal(approvedOpenAiModelId).pipe(
  Schema.brand("ApprovedOpenAiModel")
);

export type ApprovedOpenAiModel = typeof ApprovedOpenAiModel.Type;

export const approvedOpenAiModel = ApprovedOpenAiModel.make(approvedOpenAiModelId);

const ChatContent = Schema.NullOr(Schema.String);

type OpenAiFunctionCall = Readonly<{
  id: string;
  type: "function";
  function: Readonly<{ name: string; arguments: string }>;
}>;

type OpenAiInputItem =
  | Readonly<{ role: "system" | "user"; content: string }>
  | (Readonly<{
      role: "assistant";
      content: typeof ChatContent.Type;
    }> &
      Partial<Readonly<{ tool_calls: ReadonlyArray<OpenAiFunctionCall> }>>)
  | Readonly<{ role: "tool"; tool_call_id: string; content: string }>;

type OpenAiTool = Readonly<{
  type: "function";
  function: Readonly<{
    name: string;
    description: string;
    parameters: JsonSchema.JsonSchema;
    strict: false;
  }>;
}>;

type OpenAiRequestBase = Readonly<{
  messages: ReadonlyArray<OpenAiInputItem>;
  max_completion_tokens: number;
  temperature: 0;
  stream: false;
  reasoning_effort: "none";
  store: false;
}>;

export type OpenAiRequest = OpenAiRequestBase &
  (
    | (Readonly<{
        tool_choice: "auto";
        tools: ReadonlyArray<OpenAiTool>;
      }> &
        Partial<Readonly<{ response_format: never }>>)
    | (Readonly<{
        response_format: Readonly<{
          type: "json_schema";
          json_schema: Readonly<{
            name: string;
            schema: JsonSchema.JsonSchema;
            strict: true;
          }>;
        }>;
      }> &
        Partial<Readonly<{ tool_choice: never; tools: never }>>)
    | Partial<Readonly<{ tool_choice: never; tools: never; response_format: never }>>
  );

export type OpenAiTransportRun = (
  model: ApprovedOpenAiModel,
  request: OpenAiRequest,
  options: Readonly<{ signal: AbortSignal }>
) => Promise<Response>;

export type OpenAiRun = (
  model: ApprovedOpenAiModel,
  request: OpenAiRequest
) => Effect.Effect<Response, HostedInferenceError | Cause.UnknownError>;

export type OpenAiConfiguration = Readonly<{
  model: Option.Option<string>;
  run: Option.Option<OpenAiRun>;
}>;

export type HostedConformanceCheck =
  | "canonical_query"
  | "canonical_mutation"
  | "canonical_mutation_money"
  | "canonical_mutation_time"
  | "canonical_correction"
  | "canonical_deletion"
  | "canonical_date_only"
  | "canonical_recurring_lifecycle"
  | "canonical_recurring_read"
  | "invalid_output_recovery"
  | "structured_es_co"
  | "conversational_es_co";

export type HostedConformanceFailure = Readonly<{
  check: HostedConformanceCheck;
  category: HostedInferenceError["reason"]["_tag"];
}>;
