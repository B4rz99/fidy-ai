/*
 * DESIGN ARTIFACT — follow-up work for issue #137 (A7, A9, A11, A13).
 *
 * These declarations describe the proposed interfaces and invariants. They are not a parallel
 * production model and are intentionally outside tsconfig. Implementation must derive operation
 * variants from the canonical operation catalog rather than copying the illustrative unions below.
 */

import type { DateTime, Duration, Effect, Option, Schema } from "effect";
import type { Prompt, Response } from "effect/unstable/ai";
import type { SqlClient } from "effect/unstable/sql";
import type { CanonicalOperationId } from "../../src/core/_shared/canonical-operation";
import type {
  AgentIteration,
  TranscriptText,
  TranscriptTurnId,
} from "../../src/core/transcript/model";
import type { OperationPolicyValue } from "../../src/shell/_shared/operation-policy";
import type { AgentLimits } from "../../src/shell/agent/agent-service";

export type NonEmptyReadonlyArray<A> = readonly [A, ...ReadonlyArray<A>];

export type GeneratedOperationCall = Readonly<{
  id: string;
  name: string;
  params: unknown;
}>;

// -------------------------------------------------------------------------------------------------
// A7 — transient replay of assistant text accompanying tool calls
// -------------------------------------------------------------------------------------------------

/**
 * One accepted provider response. `parts` retains the original ordering of assistant text and tool
 * calls so Effect Prompt builders can replay it faithfully during this turn.
 */
export type AcceptedModelGeneration = Readonly<{
  parts: ReadonlyArray<Response.AnyPart>;
  finishReason: Response.FinishReason;
  usage: Response.Usage;
}>;

/** Provider messages retained only while one AgentService turn is running. */
export type TurnModelContinuation = Readonly<{
  turnId: TranscriptTurnId;
  parts: ReadonlyArray<Response.AnyPart>;
}>;

export type PreserveModelContinuation = (
  continuation: TurnModelContinuation,
  generated: AcceptedModelGeneration
) => TurnModelContinuation;

/**
 * Invariant: TurnModelContinuation is appended after durable Transcript history in the next model
 * prompt, but it is not persisted as a user-visible AssistantTranscriptEntry.
 */
export type BuildNextRoundPrompt = (input: {
  readonly durablePrompt: Prompt.Prompt;
  readonly continuation: TurnModelContinuation;
}) => Prompt.Prompt;

// -------------------------------------------------------------------------------------------------
// A9 — preflighted confirmation and canonical atomic batches
// -------------------------------------------------------------------------------------------------

export type AtomicBatchPolicy = "eligible" | "ineligible";

/** Proposed addition to canonical operation policy metadata. */
export type AtomicOperationPolicy = OperationPolicyValue &
  Readonly<{
    atomicBatch: AtomicBatchPolicy;
  }>;

/** Stable identity for one call inside a proposed batch. */
export type AtomicBatchCallId = string & { readonly AtomicBatchCallId: unique symbol };

/**
 * Conceptual member of a catalog-derived tagged union. `Input` must be the encoded input schema for
 * exactly `Operation`; production code must not weaken this relationship to `unknown`.
 */
export type AtomicBatchCall<
  Operation extends CanonicalOperationId = CanonicalOperationId,
  Input extends Schema.Json = Schema.Json,
> = Readonly<{
  callId: AtomicBatchCallId;
  operation: Operation;
  input: Input;
}>;

/**
 * Non-empty, ordered, and bounded. Its catalog-derived call union includes only eligible ordinary
 * operations, so `operations.executeAtomicBatch` cannot contain itself.
 */
export type AtomicBatchInput = Readonly<{
  calls: NonEmptyReadonlyArray<AtomicBatchCall>;
}>;

/** A normal canonical operation published on HTTP, OpenAPI, typed-client, MCP, CLI, and model tools. */
export type ExecuteAtomicBatchOperation = Readonly<{
  id: "operations.executeAtomicBatch";
  input: AtomicBatchInput;
  success: AtomicBatchOutput;
  failure: AtomicBatchRejected;
}>;

export type AtomicBatchSuccess<
  Operation extends CanonicalOperationId = CanonicalOperationId,
  Output extends Schema.Json = Schema.Json,
> = Readonly<{
  callId: AtomicBatchCallId;
  operation: Operation;
  output: Output;
}>;

export type AtomicBatchOutput = Readonly<{
  results: NonEmptyReadonlyArray<AtomicBatchSuccess>;
}>;

/** One actionable canonical failure; no child effects are committed when this is returned. */
export type AtomicBatchRejected = Readonly<{
  _tag: "AtomicBatchRejected";
  failedCallIndex: number;
  operation: CanonicalOperationId;
  code: string;
  userMessage: TranscriptText;
  fieldIssues: ReadonlyArray<Readonly<{ path: string; message: string }>>;
}>;

/**
 * Reusable implementation behind both an individual canonical operation and the atomic batch.
 * Supplying a transaction-scoped SqlClient makes every eligible implementation join one commit.
 */
export type AtomicOperationImplementation<Input, Output, Failure, Requirements = never> = (
  input: Input
) => Effect.Effect<Output, Failure, Requirements | SqlClient.SqlClient>;

/** Deep module seam: check and execute every child inside one transaction, or commit none. */
export type AtomicBatchExecutor = Readonly<{
  execute: (
    input: AtomicBatchInput
  ) => Effect.Effect<AtomicBatchOutput, AtomicBatchRejected, SqlClient.SqlClient>;
}>;

export type BatchConfirmationDigest = string & {
  readonly BatchConfirmationDigest: unique symbol;
};

export type BatchConfirmationChallenge = Readonly<{
  turnId: TranscriptTurnId;
  digest: BatchConfirmationDigest;
  calls: NonEmptyReadonlyArray<AtomicBatchCall>;
  challenge: TranscriptText;
  expiresAt: DateTime.Utc;
}>;

export type BatchConfirmationDecision =
  | Readonly<{ _tag: "NoConfirmationRequired"; batch: AtomicBatchInput }>
  | Readonly<{ _tag: "RequireBatchConfirmation"; challenge: BatchConfirmationChallenge }>
  | Readonly<{ _tag: "ConfirmedBatch"; batch: AtomicBatchInput }>;

/**
 * Required execution order: preflight all -> settle confirmation -> execute the canonical batch.
 * The batch performs authoritative checks and child execution inside one transaction; any failure
 * rolls the transaction back. No child operation executes during preflight.
 */
export type PreflightAtomicBatch = (
  calls: NonEmptyReadonlyArray<GeneratedOperationCall>
) => Effect.Effect<BatchConfirmationDecision, AtomicBatchRejected>;

// -------------------------------------------------------------------------------------------------
// A11 — one provider retry inside one model-round deadline
// -------------------------------------------------------------------------------------------------

export type ModelAttempt = "initial" | "retry";

export type ModelRoundRetryPolicy = Readonly<{
  maxAttempts: 2;
  roundTimeout: Duration.Duration; // Default: 30 seconds from AgentLimits.maxModelRoundMillis.
  fallbackDelay: Duration.Duration;
  minimumAttemptWindow: Duration.Duration;
}>;

/** Normalize AiError.retryAfter from undefined to Option at the provider seam. */
export type RetryableModelFailure = Readonly<{
  reason: string;
  isRetryable: boolean;
  retryAfter: Option.Option<Duration.Duration>;
}>;

export type ModelRetryDecision =
  | Readonly<{
      _tag: "Retry";
      nextAttempt: "retry";
      delay: Duration.Duration;
      deadline: DateTime.Utc;
    }>
  | Readonly<{
      _tag: "DoNotRetry";
      reason: "not-retryable" | "attempts-exhausted" | "insufficient-time";
    }>;

export type DecideModelRetry = (input: {
  readonly attempt: ModelAttempt;
  readonly failure: RetryableModelFailure;
  readonly now: DateTime.Utc;
  readonly deadline: DateTime.Utc;
  readonly policy: ModelRoundRetryPolicy;
}) => ModelRetryDecision;

/** Both attempts and any delay are enclosed by this one timeout. */
export type GenerateModelRound = (input: {
  readonly iteration: AgentIteration;
  readonly deadline: DateTime.Utc;
}) => Effect.Effect<AcceptedModelGeneration, RetryableModelFailure>;

// -------------------------------------------------------------------------------------------------
// A13 — project the remaining turn tool budget into each OpenAI request
// -------------------------------------------------------------------------------------------------

export type TurnToolBudget = Readonly<{
  maximum: AgentLimits["maxToolCallsPerTurn"];
  accepted: number;
}>;

/** Avoid sending max_tool_calls: 0; a zero budget becomes a tool-disabled finalization round. */
export type ModelRoundToolPolicy =
  | Readonly<{
      _tag: "ToolsEnabled";
      maxToolCalls: number;
    }>
  | Readonly<{
      _tag: "ToolsDisabled";
      reason: "turn-tool-budget-exhausted";
    }>;

export type DecideModelRoundToolPolicy = (budget: TurnToolBudget) => ModelRoundToolPolicy;

/** OpenAI-specific projection; host-side aggregate enforcement remains authoritative. */
export type OpenAiRoundToolConfig =
  | Readonly<{
      max_tool_calls: number;
      tool_choice: "auto";
    }>
  | Readonly<{
      tool_choice: "none";
    }>;

export type ToOpenAiRoundToolConfig = (policy: ModelRoundToolPolicy) => OpenAiRoundToolConfig;

// -------------------------------------------------------------------------------------------------
// Proposed turn orchestration interface
// -------------------------------------------------------------------------------------------------

export type ProposedHostedTurnFlow = Readonly<{
  continuation: TurnModelContinuation;
  toolBudget: TurnToolBudget;
  retryPolicy: ModelRoundRetryPolicy;
  generateRound: GenerateModelRound;
  preflightBatch: PreflightAtomicBatch;
  executeBatch: AtomicBatchExecutor["execute"];
}>;
