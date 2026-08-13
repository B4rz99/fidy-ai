import { Schema } from "effect";
import { CanonicalOperationId } from "~/core/_shared/canonical-operation";
import { UtcTimestamp } from "~/core/_shared/time";

const maximumToolCallIdLength = 256;
const maximumAgentIterationsPerTurn = 32;
const maximumTranscriptTextLength = 16_000;
const maximumCanonicalToolEvidenceBytes = 1_000_000;

const canonicalJsonStringIsValid = (value: string): boolean =>
  !value.includes("\u0000") && value.isWellFormed();

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray => Array.isArray(value);

const isCanonicalJsonString = Schema.makeFilter<string>((value) =>
  canonicalJsonStringIsValid(value) ? undefined : "Expected well-formed Unicode without NUL"
);
const isCanonicalUuid = Schema.makeFilter<string>((value) =>
  value === value.toLowerCase() ? undefined : "Expected canonical lowercase UUID spelling"
);

const canonicalJsonValueIsValid = (value: Schema.Json): boolean => {
  if (typeof value === "string") return canonicalJsonStringIsValid(value);
  if (typeof value === "number") return !Object.is(value, -0);
  if (isJsonArray(value)) return value.every(canonicalJsonValueIsValid);
  if (value !== null && typeof value === "object") {
    const object: Schema.JsonObject = value;
    return Object.entries(object).every(
      ([key, member]: readonly [string, Schema.Json]) =>
        canonicalJsonStringIsValid(key) && canonicalJsonValueIsValid(member)
    );
  }
  return true;
};

const canonicalToolEvidenceIsValid = Schema.makeFilter<Schema.Json>((value) => {
  if (!canonicalJsonValueIsValid(value)) return "Expected losslessly persistable JSON";
  const encodedBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  return encodedBytes <= maximumCanonicalToolEvidenceBytes
    ? undefined
    : `Expected at most ${maximumCanonicalToolEvidenceBytes} encoded UTF-8 bytes`;
});

/** Stable lowercase UUID identity for one append-only Transcript entry. */
export const TranscriptEntryId = Schema.String.check(Schema.isUUID(), isCanonicalUuid)
  .pipe(Schema.brand("TranscriptEntryId"))
  .annotate({ identifier: "TranscriptEntryId" });
export type TranscriptEntryId = typeof TranscriptEntryId.Type;

/** Stable lowercase UUID joining every entry produced by one hosted-agent turn. */
export const TranscriptTurnId = Schema.String.check(Schema.isUUID(), isCanonicalUuid)
  .pipe(Schema.brand("TranscriptTurnId"))
  .annotate({ identifier: "TranscriptTurnId" });
export type TranscriptTurnId = typeof TranscriptTurnId.Type;

/** Provider-issued identity linking one tool call to exactly one result. */
export const ToolCallId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(maximumToolCallIdLength),
  isCanonicalJsonString
)
  .pipe(Schema.brand("ToolCallId"))
  .annotate({ identifier: "ToolCallId" });
export type ToolCallId = typeof ToolCallId.Type;

/** A one-based model round within a hosted-agent turn. */
export const AgentIteration = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(maximumAgentIterationsPerTurn)
)
  .pipe(Schema.brand("AgentIteration"))
  .annotate({ identifier: "AgentIteration" });
export type AgentIteration = typeof AgentIteration.Type;

/** Exact user-visible text retained in a Transcript. */
export const TranscriptText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(maximumTranscriptTextLength),
  Schema.isPattern(/\S/u),
  isCanonicalJsonString
)
  .pipe(Schema.brand("TranscriptText"))
  .annotate({ identifier: "TranscriptText" });
export type TranscriptText = typeof TranscriptText.Type;

const TranscriptIdentity = {
  id: TranscriptEntryId,
  turnId: TranscriptTurnId,
  occurredAt: UtcTimestamp,
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

/**
 * Complete, losslessly persistable JSON evidence whose encoded form is at most
 * 1,000,000 UTF-8 bytes. NUL, ill-formed Unicode, and negative zero are outside
 * this canonical storage subset.
 */
export const CanonicalToolEvidence = Schema.Json.check(canonicalToolEvidenceIsValid).annotate({
  identifier: "CanonicalToolEvidence",
});
export type CanonicalToolEvidence = typeof CanonicalToolEvidence.Type;

/** Exact JSON arguments requested for one canonical operation. */
export const CanonicalToolCallEntry = Schema.TaggedStruct("CanonicalToolCallEntry", {
  ...TranscriptIdentity,
  iteration: AgentIteration,
  toolCallId: ToolCallId,
  operation: CanonicalOperationId,
  input: CanonicalToolEvidence,
});
export type CanonicalToolCallEntry = typeof CanonicalToolCallEntry.Type;

/** The mutually exclusive results a canonical tool invocation may retain. */
export const CanonicalToolOutcome = Schema.Union([
  Schema.TaggedStruct("Succeeded", { output: CanonicalToolEvidence }),
  Schema.TaggedStruct("ToolInputRejected", { failure: CanonicalToolEvidence }),
  Schema.TaggedStruct("ToolOutputRejected", { failure: CanonicalToolEvidence }),
  Schema.TaggedStruct("CanonicalOperationFailed", { failure: CanonicalToolEvidence }),
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

/** Allowlisted reason retained for a Failed Turn; arbitrary failure prose is forbidden. */
export const TurnFailureReason = Schema.Literals([
  "HostedInferenceFailed",
  "HostedInferenceTimedOut",
  "DeliveryFailed",
]);
export type TurnFailureReason = typeof TurnFailureReason.Type;

/** Fixed metadata-only evidence that a Turn ended in a handled failure. */
export const FailedTurnTranscriptEntry = Schema.TaggedStruct("FailedTurnTranscriptEntry", {
  ...TranscriptIdentity,
  reason: TurnFailureReason,
});
export type FailedTurnTranscriptEntry = typeof FailedTurnTranscriptEntry.Type;

/** Fixed metadata-only evidence recovered after a process abandoned a Pending Turn. */
export const InterruptedTurnTranscriptEntry = Schema.TaggedStruct(
  "InterruptedTurnTranscriptEntry",
  TranscriptIdentity
);
export type InterruptedTurnTranscriptEntry = typeof InterruptedTurnTranscriptEntry.Type;

/** Continuation evidence admitted only through an active Turn handle. */
export const TurnContinuationEntry = Schema.Union([
  CanonicalToolCallEntry,
  CanonicalToolResultEntry,
]).annotate({ identifier: "TurnContinuationEntry" });
export type TurnContinuationEntry = typeof TurnContinuationEntry.Type;

/** Transcript evidence carrying User, Assistant, or canonical tool content; excludes lifecycle markers. */
export const TranscriptContentEntry = Schema.Union([
  UserTranscriptEntry,
  AssistantTranscriptEntry,
  CanonicalToolCallEntry,
  CanonicalToolResultEntry,
]).annotate({ identifier: "TranscriptContentEntry" });
export type TranscriptContentEntry = typeof TranscriptContentEntry.Type;

/** The complete provider-neutral record retained for exact conversation history. */
export const TranscriptEntry = Schema.Union([
  UserTranscriptEntry,
  AssistantTranscriptEntry,
  CanonicalToolCallEntry,
  CanonicalToolResultEntry,
  FailedTurnTranscriptEntry,
  InterruptedTurnTranscriptEntry,
]).annotate({ identifier: "TranscriptEntry" });
export type TranscriptEntry = typeof TranscriptEntry.Type;

/** The User's sole lossy conversation-continuity replacement and its exact incorporated cursor. */
export const CompactedConversation = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1)),
  throughSequence: Schema.BigInt.check(
    Schema.makeFilter((value) => value >= 0n || "Expected a non-negative cursor")
  ),
  revision: Schema.BigInt.check(
    Schema.makeFilter((value) => value > 0n || "Expected a positive revision")
  ),
  updatedAt: Schema.DateTimeUtc,
});
export type CompactedConversation = typeof CompactedConversation.Type;

const terminalTimeIssue = (turn: {
  readonly startedAt: UtcTimestamp;
  readonly terminalAt: UtcTimestamp;
}): Schema.FilterOutput =>
  turn.terminalAt.epochMilliseconds >= turn.startedAt.epochMilliseconds
    ? undefined
    : { path: ["terminalAt"], issue: "Expected terminalAt not to precede startedAt" };

const PendingConversationTurn = Schema.TaggedStruct("Pending", {
  id: TranscriptTurnId,
  startedAt: UtcTimestamp,
});
const CompletedConversationTurnBase = Schema.TaggedStruct("Completed", {
  id: TranscriptTurnId,
  startedAt: UtcTimestamp,
  terminalAt: UtcTimestamp,
});
const CompletedConversationTurn = CompletedConversationTurnBase.check(
  Schema.makeFilter<typeof CompletedConversationTurnBase.Type>(terminalTimeIssue)
);
const FailedConversationTurnBase = Schema.TaggedStruct("Failed", {
  id: TranscriptTurnId,
  startedAt: UtcTimestamp,
  terminalAt: UtcTimestamp,
  reason: TurnFailureReason,
});
const FailedConversationTurn = FailedConversationTurnBase.check(
  Schema.makeFilter<typeof FailedConversationTurnBase.Type>(terminalTimeIssue)
);
const InterruptedConversationTurnBase = Schema.TaggedStruct("Interrupted", {
  id: TranscriptTurnId,
  startedAt: UtcTimestamp,
  terminalAt: UtcTimestamp,
});
const InterruptedConversationTurn = InterruptedConversationTurnBase.check(
  Schema.makeFilter<typeof InterruptedConversationTurnBase.Type>(terminalTimeIssue)
);

/** One explicit persisted Turn state; only Pending is non-terminal, and terminal time cannot precede start. */
export const ConversationTurn = Schema.Union([
  PendingConversationTurn,
  CompletedConversationTurn,
  FailedConversationTurn,
  InterruptedConversationTurn,
]).annotate({ identifier: "ConversationTurn" });
export type ConversationTurn = typeof ConversationTurn.Type;
