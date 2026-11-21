import { OnboardingConsentBasis } from "~/core/consent/contract";
import { InsightEventId } from "~/core/insights/contract";
import { UserId } from "~/core/identity/contract";
import { Data, type Option, Predicate, Schema, Struct } from "effect";
import { CanonicalOperationId } from "~/core/canonical-operations/contract";
import { UtcTimestamp } from "~/core/_shared/time";

export const maximumHostedTurnIterations = 32;

export const maximumModelRoundMillis = 120_000;

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
  if (Predicate.isString(value)) return canonicalJsonStringIsValid(value);

  if (Predicate.isNumber(value)) return !Object.is(value, -0);

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

export const TranscriptEntryId = Schema.String.check(Schema.isUUID(), isCanonicalUuid)
  .pipe(Schema.brand("TranscriptEntryId"))
  .annotate({ identifier: "TranscriptEntryId" });

export type TranscriptEntryId = typeof TranscriptEntryId.Type;

export const TranscriptTurnId = Schema.String.check(Schema.isUUID(), isCanonicalUuid)
  .pipe(Schema.brand("TranscriptTurnId"))
  .annotate({ identifier: "TranscriptTurnId" });

export type TranscriptTurnId = typeof TranscriptTurnId.Type;

export const ToolCallId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(maximumToolCallIdLength),
  isCanonicalJsonString
)
  .pipe(Schema.brand("ToolCallId"))
  .annotate({ identifier: "ToolCallId" });

export type ToolCallId = typeof ToolCallId.Type;

export const AgentIteration = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(maximumHostedTurnIterations)
)
  .pipe(Schema.brand("AgentIteration"))
  .annotate({ identifier: "AgentIteration" });

export type AgentIteration = typeof AgentIteration.Type;

export const TranscriptText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(maximumTranscriptTextLength),
  Schema.isPattern(/\S/u),
  isCanonicalJsonString
)
  .pipe(Schema.brand("TranscriptText"))
  .annotate({ identifier: "TranscriptText" });

export type TranscriptText = typeof TranscriptText.Type;

export const ProactiveInsightTranscriptEntry = Schema.TaggedStruct(
  "ProactiveInsightTranscriptEntry",
  {
    id: TranscriptEntryId,
    insightEventId: InsightEventId,
    occurredAt: UtcTimestamp,
    text: TranscriptText,
  }
);

export type ProactiveInsightTranscriptEntry = typeof ProactiveInsightTranscriptEntry.Type;

export const ProactiveDeliveryId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("ProactiveDeliveryId")
);

export type ProactiveDeliveryId = typeof ProactiveDeliveryId.Type;

export const ProactiveMessageTranscriptEntry = Schema.TaggedStruct(
  "ProactiveMessageTranscriptEntry",
  {
    id: TranscriptEntryId,
    deliveryId: ProactiveDeliveryId,
    role: Schema.Literals([
      "budget-offer",
      "reminder-offer",
      "recurring-offer",
      "reminder-question",
    ]),
    occurredAt: UtcTimestamp,
    text: TranscriptText,
  }
);

export type ProactiveMessageTranscriptEntry = typeof ProactiveMessageTranscriptEntry.Type;

export const ProactiveTranscriptEntry = Schema.Union([
  ProactiveInsightTranscriptEntry,
  ProactiveMessageTranscriptEntry,
]);

export type ProactiveTranscriptEntry = typeof ProactiveTranscriptEntry.Type;

const TranscriptIdentity = {
  id: TranscriptEntryId,
  turnId: TranscriptTurnId,
  occurredAt: UtcTimestamp,
};

export const UserTranscriptEntry = Schema.TaggedStruct("UserTranscriptEntry", {
  ...TranscriptIdentity,
  text: TranscriptText,
});

export type UserTranscriptEntry = typeof UserTranscriptEntry.Type;

export const AssistantTranscriptEntry = Schema.TaggedStruct("AssistantTranscriptEntry", {
  ...TranscriptIdentity,
  iteration: AgentIteration,
  text: TranscriptText,
});

export type AssistantTranscriptEntry = typeof AssistantTranscriptEntry.Type;

export const CanonicalToolEvidence = Schema.Json.check(canonicalToolEvidenceIsValid).annotate({
  identifier: "CanonicalToolEvidence",
});

export type CanonicalToolEvidence = typeof CanonicalToolEvidence.Type;

export const CanonicalToolCallEntry = Schema.TaggedStruct("CanonicalToolCallEntry", {
  ...TranscriptIdentity,
  iteration: AgentIteration,
  toolCallId: ToolCallId,
  operation: CanonicalOperationId,
  input: CanonicalToolEvidence,
});

export type CanonicalToolCallEntry = typeof CanonicalToolCallEntry.Type;

export const ToolOutputRejected = Schema.TaggedStruct("ToolOutputRejected", {
  failure: CanonicalToolEvidence,
});

export const ToolSucceeded = Schema.TaggedStruct("Succeeded", { output: CanonicalToolEvidence });

export const CanonicalToolOutcome = Schema.Union([
  ToolSucceeded,
  Schema.TaggedStruct("CommittedOutputUnavailable", {}),
  Schema.TaggedStruct("ToolInputRejected", { failure: CanonicalToolEvidence }),
  ToolOutputRejected,
  Schema.TaggedStruct("CanonicalOperationFailed", { failure: CanonicalToolEvidence }),
]);

export type CanonicalToolOutcome = typeof CanonicalToolOutcome.Type;

export const CanonicalToolResultEntry = Schema.TaggedStruct("CanonicalToolResultEntry", {
  ...TranscriptIdentity,
  iteration: AgentIteration,
  toolCallId: ToolCallId,
  operation: CanonicalOperationId,
  outcome: CanonicalToolOutcome,
});

export type CanonicalToolResultEntry = typeof CanonicalToolResultEntry.Type;

export const TurnFailureReason = Schema.Literals([
  "HostedInferenceFailed",
  "HostedInferenceTimedOut",
  "DeliveryFailed",
  "DeliveryUnconfirmed",
]);

export type TurnFailureReason = typeof TurnFailureReason.Type;

export const FailedTurnTranscriptEntry = Schema.TaggedStruct("FailedTurnTranscriptEntry", {
  ...TranscriptIdentity,
  reason: TurnFailureReason,
});

export type FailedTurnTranscriptEntry = typeof FailedTurnTranscriptEntry.Type;

export const InterruptedTurnTranscriptEntry = Schema.TaggedStruct(
  "InterruptedTurnTranscriptEntry",
  TranscriptIdentity
);

export type InterruptedTurnTranscriptEntry = typeof InterruptedTurnTranscriptEntry.Type;

export const TurnContinuationEntry = Schema.Union([
  CanonicalToolCallEntry,
  CanonicalToolResultEntry,
]).annotate({ identifier: "TurnContinuationEntry" });

export type TurnContinuationEntry = typeof TurnContinuationEntry.Type;

export const TranscriptContentEntry = Schema.Union([
  UserTranscriptEntry,
  AssistantTranscriptEntry,
  CanonicalToolCallEntry,
  CanonicalToolResultEntry,
]).annotate({ identifier: "TranscriptContentEntry" });

export type TranscriptContentEntry = typeof TranscriptContentEntry.Type;

export const TranscriptEntry = Schema.Union([
  UserTranscriptEntry,
  AssistantTranscriptEntry,
  CanonicalToolCallEntry,
  CanonicalToolResultEntry,
  FailedTurnTranscriptEntry,
  InterruptedTurnTranscriptEntry,
]).annotate({ identifier: "TranscriptEntry" });

export type TranscriptEntry = typeof TranscriptEntry.Type;

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

export const ConversationTurn = Schema.Union([
  PendingConversationTurn,
  CompletedConversationTurn,
  FailedConversationTurn,
  InterruptedConversationTurn,
]).annotate({ identifier: "ConversationTurn" });

export type ConversationTurn = typeof ConversationTurn.Type;

export const HostedAgentSessionId = Schema.String.check(
  Schema.isUUID(),
  Schema.makeFilter<string>((value) =>
    value === value.toLowerCase() ? undefined : "Expected canonical lowercase UUID spelling"
  )
)
  .pipe(Schema.brand("HostedAgentSessionId"))
  .annotate({ identifier: "HostedAgentSessionId" });

export type HostedAgentSessionId = typeof HostedAgentSessionId.Type;

export const HostedAgentSessionConsentBasis = OnboardingConsentBasis;

export type HostedAgentSessionConsentBasis = typeof HostedAgentSessionConsentBasis.Type;

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

export const CompactedConversationOutput = Schema.Struct({
  compactedConversation: CompactedConversationText.fields.text,
});

export type CompactedConversationOutput = typeof CompactedConversationOutput.Type;

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

export type HostedAdmissionRequest = Readonly<{
  userId: UserId;
  nowMs: number;
  currentConsent: Option.Option<HostedAgentSessionConsentBasis>;
  revoked: boolean;
  state: HostedAdmissionState;
}>;

export type HostedAdmissionDecision = Data.TaggedEnum<{
  Refused: { readonly reason: "ConsentRequired" | "InvalidState" };
  RecoverPending: {};
  ContinueSession: { readonly sessionId: HostedAgentSessionId };
  BeginSession: { readonly consentBasis: HostedAgentSessionConsentBasis };
}>;

export const HostedAdmissionDecision = Data.taggedEnum<HostedAdmissionDecision>();

export const ConversationCompactionTokenCount = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("ConversationCompactionTokenCount")
);

export type ConversationCompactionTokenCount = typeof ConversationCompactionTokenCount.Type;
