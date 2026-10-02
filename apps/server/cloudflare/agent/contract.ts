import type { ToolCallId, TranscriptTurnId } from "@fidy/server/agent-runtime";
/** Maximum time from a hosted reply proposal to authenticated visible delivery, in milliseconds. */
export const deliveryAcknowledgmentWindowMs = 120_000;

/** Approved retention of exact terminal Transcript and channel evidence, in milliseconds. */
export const hostedTranscriptRetentionMs = 2_592_000_000;

/** One admitted Turn's exact canonical call identity; external callers cannot establish it. */
export type HostedCommitFence = Readonly<{ turnId: TranscriptTurnId; toolCallId: ToolCallId }>;
