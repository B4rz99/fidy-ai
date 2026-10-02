import { OnboardingConsentBasis } from "~/core/consent/contract";
import { UserId } from "~/core/identity/contract";
import { type Option, Schema, Struct } from "effect";
import { CanonicalOperationId } from "~/core/canonical-operations/contract";
import { UtcTimestamp } from "~/core/_shared/time";

/**
 * Hard upper bounds on one hosted Turn: its iteration count, its tool calls, and the wall-clock
 * bound on each model round. Native Turn execution and the provider adapter share these maxima so their
 * admission, iteration and deadline policies cannot drift apart.
 */
export const maximumHostedTurnIterations = 32;
/** Wall-clock limit for one admitted hosted model round, in milliseconds. */
export const maximumModelRoundMillis = 120_000;
/** Maximum canonical tool calls across all model rounds of one hosted Turn. */
export const maximumToolCallsPerTurn = 64;

const maximumToolCallIdLength = 256;
const maximumTranscriptTextLength = 16_000;
const maximumCanonicalToolEvidenceBytes = 1_000_000;

const canonicalJsonStringIsValid = (value: string): boolean =>
  !value.includes("\u0000") && value.isWellFormed();

const isCanonicalJsonString = Schema.makeFilter<string>((value) =>
  canonicalJsonStringIsValid(value) ? undefined : "Expected well-formed Unicode without NUL"
);
const isCanonicalUuid = Schema.makeFilter<string>((value) =>
  value === value.toLowerCase() ? undefined : "Expected canonical lowercase UUID spelling"
);

const canonicalJsonValueIsValid = (value: Schema.Json): boolean => {
  if (typeof value === "string") return canonicalJsonStringIsValid(value);
  if (typeof value === "number") return !Object.is(value, -0);
  if (value === null) return true;
  return Object.entries(value).every(
    ([key, member]: readonly [string, Schema.Json]) =>
      canonicalJsonStringIsValid(key) && canonicalJsonValueIsValid(member)
  );
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
  Schema.isLessThanOrEqualTo(maximumHostedTurnIterations)
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
  // A fenced mutation committed, but its canonical response was lost before retention.
  Schema.TaggedStruct("CommittedOutputUnavailable", {}),
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
  "DeliveryUnconfirmed",
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

/** Stable lowercase UUID identity for one Fidy-owned hosted conversational session. */
export const HostedAgentSessionId = Schema.String.check(
  Schema.isUUID(),
  Schema.makeFilter<string>((value) =>
    value === value.toLowerCase() ? undefined : "Expected canonical lowercase UUID spelling"
  )
)
  .pipe(Schema.brand("HostedAgentSessionId"))
  .annotate({ identifier: "HostedAgentSessionId" });
export type HostedAgentSessionId = typeof HostedAgentSessionId.Type;

/** Exact onboarding Consent basis captured when a Hosted Agent Session begins. */
export const HostedAgentSessionConsentBasis = OnboardingConsentBasis;
export type HostedAgentSessionConsentBasis = typeof HostedAgentSessionConsentBasis.Type;

/** Durable lifecycle of one Fidy-owned hosted conversational session. */
export const HostedAgentSession = Schema.Struct({
  id: HostedAgentSessionId,
  subjectUserId: UserId,
  consentBasis: HostedAgentSessionConsentBasis,
  startedAt: UtcTimestamp,
  lastTerminalTurnAt: Schema.Option(UtcTimestamp),
  status: Schema.Literals(["active", "idle-ended", "revoked"]),
});
export type HostedAgentSession = typeof HostedAgentSession.Type;

const CompactedConversationText = CompactedConversation.mapFields(Struct.pick(["text"]));

/** Strict hosted output derived from the canonical replacement text before token validation. */
export const CompactedConversationOutput = Schema.Struct({
  compactedConversation: CompactedConversationText.fields.text,
});
export type CompactedConversationOutput = typeof CompactedConversationOutput.Type;

/** The latest durable session and Turn facts read while holding one User's coordination lock. */
export type HostedAdmissionState = Readonly<{
  session: Option.Option<
    Readonly<{
      id: HostedAgentSessionId;
      userId: UserId;
      consentBasis: HostedAgentSessionConsentBasis;
      startedAtMs: number;
      lastActivityAtMs: Option.Option<number>;
      status: "active" | "idle-ended" | "revoked";
    }>
  >;
  pendingStartedAtMs: Option.Option<number>;
}>;

/** A current onboarding grant is required for every admission, even in an existing session. */
export type HostedAdmissionRequest = Readonly<{
  userId: UserId;
  nowMs: number;
  currentConsent: Option.Option<HostedAgentSessionConsentBasis>;
  revoked: boolean;
  state: HostedAdmissionState;
}>;

/** A pending Turn must be recovered as Interrupted before a new Turn can be admitted. */
export type HostedAdmissionDecision =
  | Readonly<{ _tag: "Refused"; reason: "ConsentRequired" | "InvalidState" }>
  | Readonly<{ _tag: "RecoverPending" }>
  | Readonly<{ _tag: "ContinueSession"; sessionId: HostedAgentSessionId }>
  | Readonly<{ _tag: "BeginSession"; consentBasis: HostedAgentSessionConsentBasis }>;

/** Provider-token trigger and bounded replacement output, both expressed as positive token counts. */
export const ConversationCompactionTokenCount = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("ConversationCompactionTokenCount")
);
export type ConversationCompactionTokenCount = typeof ConversationCompactionTokenCount.Type;
