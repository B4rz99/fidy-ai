import { Option, Schema } from "effect";
import { UserId } from "../../../src/core/identity/contract";
import {
  HostedAgentSessionId,
  TranscriptText,
  TranscriptTurnId,
} from "../../../src/core/agent/contract";

export const Turn = Schema.Struct({
  id: TranscriptTurnId,
  user_id: UserId,
  session_id: HostedAgentSessionId,
  browser_id: Schema.OptionFromNullOr(Schema.String),
  start_ms: Schema.Int,
  deadline_ms: Schema.Int,
  request_text: TranscriptText,
});

export type LocalTurn = typeof Turn.Type;

export const channelAuthority = (
  turn: LocalTurn
): "verified-whatsapp" | "no-verified-whatsapp-authority" =>
  Option.isNone(turn.browser_id) ? "verified-whatsapp" : "no-verified-whatsapp-authority";
