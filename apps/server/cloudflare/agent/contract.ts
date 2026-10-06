import { Data, type Effect, type Option, Schema } from "effect";
import {
  HostedTurnProgressRequest,
  HostedTurnReceipt,
  HostedTurnRequest,
} from "../../src/shell/agent/contract";
import type { ProactivityEnvironment } from "../insights/contract";
import type { WorkersAiEnvironment } from "../ai/contract";
import {
  type ProactiveTranscriptEntry,
  type ToolCallId,
  TranscriptText,
  type TranscriptTurnId,
} from "../../src/core/agent/contract";
import { UserId } from "../../src/core/identity/contract";
/** Same-User verified proactive Transcript context; never a fabricated requested Turn or session. */
export type ProactiveReplyContext = Readonly<{ userId: UserId; entry: ProactiveTranscriptEntry }>;
/** Maximum time from a hosted reply proposal to authenticated visible delivery, in milliseconds. */
export const deliveryAcknowledgmentWindowMs = 120_000;

/** Approved retention of exact terminal Transcript and channel evidence, in milliseconds. */
export const hostedTranscriptRetentionMs = 2_592_000_000;

/** One admitted Turn's exact canonical call identity; external callers cannot establish it. */
export type HostedCommitFence = Readonly<{ turnId: TranscriptTurnId; toolCallId: ToolCallId }>;

/** Decode a bounded User request; the authenticated channel owns its credential separately. */
export const hostedTurnInput = HostedTurnRequest;
/** Bounded Core-to-DO admission with explicit User identity and ephemeral credential proof. */
export const HostedTurnAdmission = Schema.Struct({
  userId: UserId,
  sessionId: Schema.String.check(Schema.isUUID()),
  digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
  text: TranscriptText,
});
/** The browser sends this receipt only after it has visibly rendered the exact reply. */
export const hostedDeliveryReceipt = HostedTurnReceipt;
/** A progress poll never admits or executes a second Turn. */
export const HostedProgressAdmission = Schema.Struct({
  userId: UserId,
  sessionId: Schema.String.check(Schema.isUUID()),
  digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
  ...HostedTurnProgressRequest.fields,
});

/** Receipt forwarded by Core with a fresh WebSession proof, never from public input. */
export const HostedDeliveryAdmission = Schema.Struct({
  userId: UserId,
  sessionId: Schema.String.check(Schema.isUUID()),
  digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
  ...hostedDeliveryReceipt.fields,
});

/** A closed failure from recovery or retention; no stored text, statement, credential or provider cause escapes. */
export class AgentUnavailable extends Data.TaggedError("AgentUnavailable")<{}> {}

/** Platform bindings supplied by the existing User coordinator; none establishes User authority. */
export type AgentEnvironment = Readonly<{ DB: D1Database }> &
  Partial<Readonly<{ STATEMENT_STAGING_BUCKET: R2Bucket; KAPSO_API_KEY: string }>> &
  WorkersAiEnvironment &
  ProactivityEnvironment;
/** Construct a hosted workflow for one explicit User; scheduleRecovery sets the coordinator's durable alarm. */
export type AgentServiceInput = Readonly<{
  environment: AgentEnvironment;
  userId: UserId;
  scheduleRecovery: (dueAtMs: number) => Promise<void>;
}>;
/** Observation of accepted work. Responses contain only the channel contract, with failures closed as unavailable. Settlement, not early HTTP response, releases the User queue. */
export type AgentWork = Readonly<{ response: Promise<Response>; settled: Promise<void> }>;
/** Complete hosted requests and recovery; no executable Turn, Transcript, Compaction or tool capability escapes. */
export type AgentService = Readonly<{
  /** Returns None without effects for another owner's route. The caller chains its shared queue through settled; progress reads preserve preceding unchanged. */
  accept: (
    input: Readonly<{ request: Request; preceding: Promise<void> }>
  ) => Option.Option<AgentWork>;
  /** Recover abandoned work and expire eligible content for this User; failures reject only as AgentUnavailable. */
  recover: () => Promise<void>;
}>;
/** Owner-bounded sweep; a decision instant cannot change its fixed retention policy. */
export type AgentRetention = Readonly<{
  sweep: (now: number) => Effect.Effect<void, AgentUnavailable>;
}>;

/** Maximum elapsed execution time before abandoned pending work is recoverable, in milliseconds. */
export const pendingExecutionRecoveryMs = 135_000;
