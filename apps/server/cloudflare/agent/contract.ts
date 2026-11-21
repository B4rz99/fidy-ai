import { Data } from "effect";
import { HostedTurnRequest } from "../../src/shell/agent/contract";
import { type ProactiveTranscriptEntry } from "../../src/core/agent/contract";
import { type UserId } from "../../src/core/identity/contract";

export type ProactiveReplyContext = Readonly<{ userId: UserId; entry: ProactiveTranscriptEntry }>;

export const deliveryAcknowledgmentWindowMs = 120_000;

export const hostedTranscriptRetentionMs = 2_592_000_000;

export const hostedTurnInput = HostedTurnRequest;

export class AgentUnavailable extends Data.TaggedError("AgentUnavailable")<{}> {}

export const pendingExecutionRecoveryMs = 135_000;
