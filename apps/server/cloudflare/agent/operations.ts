import { foldHostedReceipt } from "./internal/local-channel-receipt";
import { preparePredicateAssertion } from "../../src/shell/sql-assertions/operations";
import { Effect, type Option } from "effect";
import { mintHostedStatementCaller as statementCaller } from "./internal/statement-authority";
import {
  expireProactiveTranscript as expireProactiveTranscriptOwned,
  findMessageTranscript,
  prepareProactiveTranscript as prepareProactiveTranscriptOwned,
  readContextualProactiveReply as readContextualProactiveReplyOwned,
  readProactiveTranscript as readProactiveTranscriptOwned,
} from "./internal/proactive-transcript";
import type { OnboardingConsentBasis } from "../../src/shell/consent/contract";
import type { TranscriptTurnId } from "../../src/core/agent/contract";
import { readAdmittedBasis } from "./internal/admitted-consent";
import { AgentUnavailable, type HostedCommitFence, hostedTranscriptRetentionMs } from "./contract";
import type { UserId } from "../../src/core/identity/contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import {
  channelContinuationQuery,
  channelTurnObservation,
  channelTurnQuery,
  channelUserEntryQuery,
  prepareChannelTurn,
} from "./internal/channel-evidence";

export const prepareProactiveTranscript: typeof prepareProactiveTranscriptOwned = (input) =>
  prepareProactiveTranscriptOwned(input);

export const readAssociatedProactiveTranscript = (
  input: Parameters<typeof readProactiveTranscriptOwned>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof readProactiveTranscriptOwned>>,
  AgentUnavailable
> => readProactiveTranscriptOwned(input).pipe(Effect.mapError(() => new AgentUnavailable()));

export const readContextualProactiveReply: typeof readContextualProactiveReplyOwned = (input) =>
  readContextualProactiveReplyOwned(input);

export const readProactiveMessageTranscript: typeof findMessageTranscript = (input) =>
  findMessageTranscript(input);

export const expireProactiveTranscript = (
  input: Parameters<typeof expireProactiveTranscriptOwned>[0]
): Effect.Effect<void, AgentUnavailable> =>
  expireProactiveTranscriptOwned(input).pipe(Effect.mapError(() => new AgentUnavailable()));

export const mintHostedStatementCaller: typeof statementCaller = (input) => statementCaller(input);

export const hostedChannelTurnQuery = (userId: UserId): OwnedStatement => channelTurnQuery(userId);

export const hostedChannelContinuationQuery = (userId: UserId): OwnedStatement =>
  channelContinuationQuery(userId);

export const hostedChannelUserEntryQuery = (userId: UserId): OwnedStatement =>
  channelUserEntryQuery(userId);

export const hostedChannelTurnObservation = (): string => channelTurnObservation();

export const prepareHostedChannelTurn: typeof prepareChannelTurn = (input) =>
  prepareChannelTurn(input);

export const prepareHostedChannelRetention = ({
  db,
  userId,
  now,
  statement,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  now: number;
  statement: OwnedStatement;
}>): D1PreparedStatement =>
  db
    .prepare(`WITH channel_retention_turns AS (
    SELECT id,user_id FROM hosted_turns
    WHERE user_id=? AND retention_terminal_at_ms < ? ORDER BY retention_terminal_at_ms,id LIMIT 100
  ) ${statement.sql}`)
    .bind(userId, now - hostedTranscriptRetentionMs, ...statement.params);

export const prepareHostedMutationCommit = ({
  db,
  userId,
  turnId,
  toolCallId,
  current,
}: HostedCommitFence &
  Readonly<{
    db: D1Database;
    userId: string;
    current: number;
  }>): ReadonlyArray<D1PreparedStatement> => [
  preparePredicateAssertion({
    db,
    scope: "hosted_mutation",
    predicate: {
      sql: "SELECT 1 FROM hosted_turns WHERE id=? AND user_id=? AND status='pending'",
      params: [turnId, userId],
    },
  }),
  db
    .prepare(`INSERT INTO hosted_mutation_commits(turn_id,tool_call_id,user_id,committed_at_ms)
    VALUES(?,?,?,?)`)
    .bind(turnId, toolCallId, userId, current),
];

export const readAdmittedHostedConsent = (
  input: Readonly<{ db: D1Database; userId: UserId; turnId: TranscriptTurnId }>
): Effect.Effect<Option.Option<OnboardingConsentBasis>, AgentUnavailable> =>
  readAdmittedBasis(input);

export const reconcileLocalHostedReceipt: typeof foldHostedReceipt = (...args) =>
  foldHostedReceipt(...args);
