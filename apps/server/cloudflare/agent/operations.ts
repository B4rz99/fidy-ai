import type { UserId } from "@fidy/server/agent-runtime";
import type { OwnedStatement } from "../../src/shell/_shared/owned-statement";
import {
  channelContinuationQuery,
  channelTurnObservation,
  channelTurnQuery,
  channelUserEntryQuery,
  prepareChannelTurn,
} from "./internal/channel-evidence";

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
