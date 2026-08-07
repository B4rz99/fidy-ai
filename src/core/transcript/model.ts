import { Schema } from "effect";
import { CanonicalOperationId } from "~/core/_shared/canonical-operation";

const maximumToolCallIdLength = 256;
const maximumAgentIterationsPerTurn = 32;
const maximumTranscriptTextLength = 16_000;

/** Stable identity for one append-only Transcript entry. */
export const TranscriptEntryId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("TranscriptEntryId")
);
export type TranscriptEntryId = typeof TranscriptEntryId.Type;

/** Stable identity joining every entry produced by one hosted-agent turn. */
export const TranscriptTurnId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("TranscriptTurnId")
);
export type TranscriptTurnId = typeof TranscriptTurnId.Type;

/** Provider-issued identity linking one tool call to exactly one result. */
export const ToolCallId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(maximumToolCallIdLength)
).pipe(Schema.brand("ToolCallId"));
export type ToolCallId = typeof ToolCallId.Type;

/** A one-based model round within a hosted-agent turn. */
export const AgentIteration = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(maximumAgentIterationsPerTurn)
).pipe(Schema.brand("AgentIteration"));
export type AgentIteration = typeof AgentIteration.Type;

/** Exact user-visible text retained in a Transcript. */
export const TranscriptText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(maximumTranscriptTextLength),
  Schema.isPattern(/\S/u)
).pipe(Schema.brand("TranscriptText"));
export type TranscriptText = typeof TranscriptText.Type;

const TranscriptIdentity = {
  id: TranscriptEntryId,
  turnId: TranscriptTurnId,
  occurredAt: Schema.DateTimeUtc,
};

/** Exact text accepted from the User for one turn. */
export const UserTranscriptEntry = Schema.TaggedStruct("UserTranscriptEntry", {
  ...TranscriptIdentity,
  text: TranscriptText,
});
export type UserTranscriptEntry = typeof UserTranscriptEntry.Type;

/** User-visible text emitted by one model iteration. */
export const AssistantTranscriptEntry = Schema.TaggedStruct("AssistantTranscriptEntry", {
  ...TranscriptIdentity,
  iteration: AgentIteration,
  text: TranscriptText,
});
export type AssistantTranscriptEntry = typeof AssistantTranscriptEntry.Type;

/** Exact JSON arguments requested for one canonical operation. */
export const CanonicalToolCallEntry = Schema.TaggedStruct("CanonicalToolCallEntry", {
  ...TranscriptIdentity,
  iteration: AgentIteration,
  toolCallId: ToolCallId,
  operation: CanonicalOperationId,
  input: Schema.Json,
});
export type CanonicalToolCallEntry = typeof CanonicalToolCallEntry.Type;

/** The mutually exclusive results a canonical tool invocation may retain. */
export const CanonicalToolOutcome = Schema.Union([
  Schema.TaggedStruct("Succeeded", { output: Schema.Json }),
  Schema.TaggedStruct("ToolInputRejected", { failure: Schema.Json }),
  Schema.TaggedStruct("ToolOutputRejected", { failure: Schema.Json }),
  Schema.TaggedStruct("CanonicalOperationFailed", { failure: Schema.Json }),
]);
export type CanonicalToolOutcome = typeof CanonicalToolOutcome.Type;

/** One retained canonical or host-boundary outcome linked to its canonical tool call. */
export const CanonicalToolResultEntry = Schema.TaggedStruct("CanonicalToolResultEntry", {
  ...TranscriptIdentity,
  iteration: AgentIteration,
  toolCallId: ToolCallId,
  operation: CanonicalOperationId,
  outcome: CanonicalToolOutcome,
});
export type CanonicalToolResultEntry = typeof CanonicalToolResultEntry.Type;

/** The complete provider-neutral record retained for exact conversation history. */
export const TranscriptEntry = Schema.Union([
  UserTranscriptEntry,
  AssistantTranscriptEntry,
  CanonicalToolCallEntry,
  CanonicalToolResultEntry,
]).annotate({ identifier: "TranscriptEntry" });
export type TranscriptEntry = typeof TranscriptEntry.Type;
