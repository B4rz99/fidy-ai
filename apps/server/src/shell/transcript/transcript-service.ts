import { Effect } from "effect";
import type { UserId } from "~/core/identity/reference";
import type { HostedAgentSessionId } from "~/core/transcript/hosted-agent-session";
import { selectRecentTranscriptEntries as loadRecentTranscriptEntries } from "./repo";

/**
 * Loads the newest completed Transcript turns of one explicit Hosted Agent Session. This delegates
 * to `repo.ts` on purpose: the module-graph rule fences this module, so the runtime's continuity
 * read stays inside the fence while `repo.ts` stays open for tests asserting on committed rows.
 */
export const listRecentTranscriptEntries = Effect.fn("listRecentTranscriptEntries")(
  (userId: UserId, hostedAgentSessionId: HostedAgentSessionId, maxTurns: number) =>
    loadRecentTranscriptEntries(userId, hostedAgentSessionId, maxTurns)
);
