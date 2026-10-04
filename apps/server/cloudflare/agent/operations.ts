import { Effect, type Option } from "effect";
import {
  expireProactiveTranscript as expireProactiveTranscriptOwned,
  prepareProactiveTranscript as prepareProactiveTranscriptOwned,
  readProactiveTranscript as readProactiveTranscriptOwned,
} from "./internal/proactive-transcript";
import type { OnboardingConsentBasis } from "../../src/shell/consent/contract";
import type { TranscriptTurnId } from "../../src/core/agent/contract";
import { readAdmittedBasis } from "./internal/admitted-consent";
import { AgentUnavailable, type HostedCommitFence } from "./contract";
import type { UserId } from "../../src/core/identity/contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import {
  channelContinuationQuery,
  channelTurnObservation,
  channelTurnQuery,
  channelUserEntryQuery,
  prepareChannelTurn,
} from "./internal/channel-evidence";

/** Copy only the channel's exact protected verified text into the User Transcript, without inventing a Turn or session. Commit alongside Insight settlement. */
export const prepareProactiveTranscript: typeof prepareProactiveTranscriptOwned = (input) =>
  prepareProactiveTranscriptOwned(input);
/** Read one same-User, unexpired proactive Transcript entry under current processing Consent for an ordinary correlated reply. */
export const readProactiveTranscript = (
  input: Parameters<typeof readProactiveTranscriptOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof readProactiveTranscriptOwned>>,
  AgentUnavailable
> => readProactiveTranscriptOwned(input).pipe(Effect.mapError(() => new AgentUnavailable()));
/** Execute the fixed proactive Transcript retention policy independently of later User messages. */
export const expireProactiveTranscript = (
  input: Parameters<typeof expireProactiveTranscriptOwned>[0]
): Effect.Effect<void, AgentUnavailable> =>
  expireProactiveTranscriptOwned(input).pipe(Effect.mapError(() => new AgentUnavailable()));

/** Same-User Turn lifecycle metadata, with id, user_id, hosted_session_id, status, started_at_ms, terminal_at_ms and failure_reason; no Transcript content or credential. */
export const hostedChannelTurnQuery = (userId: UserId): OwnedStatement => channelTurnQuery(userId);
/** Same-User lifecycle and exact retained User entry for channel continuation; absence after compaction cannot create new work. */
export const hostedChannelContinuationQuery = (userId: UserId): OwnedStatement =>
  channelContinuationQuery(userId);
/** Exact User entries only for this User's retained Turns; use solely for authenticated same-message replay comparison. */
export const hostedChannelUserEntryQuery = (userId: UserId): OwnedStatement =>
  channelUserEntryQuery(userId);
/** Secret-free Turn lifecycle relation for bounded private operational sampling or identity-only dispatch; never includes Transcript content. */
export const hostedChannelTurnObservation = (): string => channelTurnObservation();
/** Compose this User's lifecycle as channel_turns inside the caller's existing atomic statement; preparation grants no Turn authority. */
export const prepareHostedChannelTurn: typeof prepareChannelTurn = (input) =>
  prepareChannelTurn(input);

/**
 * Bind one canonical mutation commit to the exact pending Turn and tool call of its stable User.
 * The caller must include this statement and every mutation in the same uninterruptible D1 batch.
 * Recovery winning first, a foreign Turn, or a repeated call aborts that entire batch; a successful
 * commit leaves the owner's durable evidence used to recover a reply lost after mutation.
 */
export const prepareHostedMutationCommit = ({
  db,
  userId,
  turnId,
  toolCallId,
  current,
}: HostedCommitFence &
  Readonly<{
    db: D1Database;
    /** The established stable User carried by the caller's resolved authority. */
    userId: string;
    /** One Worker-owned decision instant, in UTC epoch milliseconds. */
    current: number;
  }>): D1PreparedStatement =>
  db
    .prepare(`INSERT INTO hosted_mutation_commits
              (turn_id, tool_call_id, user_id, committed_at_ms, valid)
              VALUES (?, ?, ?, ?, CASE WHEN EXISTS (
                SELECT 1 FROM hosted_turns WHERE id = ? AND user_id = ? AND status = 'pending'
              ) THEN 1 ELSE 0 END)`)
    .bind(turnId, toolCallId, userId, current, turnId, userId);

/**
 * Read the captured Consent basis only for the exact explicit User and still-Pending Turn.
 * Absence is None; malformed or unavailable persistence fails closed. This grants no egress or
 * lifecycle authority: Consent retains its current-standing comparison immediately before egress.
 */
export const readAdmittedHostedConsent = (
  input: Readonly<{ db: D1Database; userId: UserId; turnId: TranscriptTurnId }>
): Effect.Effect<Option.Option<OnboardingConsentBasis>, AgentUnavailable> =>
  readAdmittedBasis(input);
