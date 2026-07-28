import { DateTime, Effect } from "effect";
import { AgentTokenIdleDuration } from "./model";

/**
 * Advances an AgentToken's idle deadline to 90 days after an authenticated use.
 * The shell persists this value atomically with `lastUsedAt`; no fixed lifetime
 * is imposed while the grant continues to be used.
 */
export const renewAgentTokenIdleExpiry = (
  usedAt: DateTime.Utc
): Effect.Effect<DateTime.Utc, never, never> =>
  Effect.succeed(DateTime.addDuration(usedAt, AgentTokenIdleDuration));
