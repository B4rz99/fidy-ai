import { Schema } from "effect";
import { UtcTimestamp } from "~/core/_shared/time";
import { OnboardingConsentBasis } from "~/core/consent/contract";
import { UserId } from "~/core/identity/reference";
import { HostedAgentSessionId } from "./reference";

export { HostedAgentSessionId } from "./reference";

/** Exact onboarding Consent basis captured when a Hosted Agent Session begins. */
export const HostedAgentSessionConsentBasis = OnboardingConsentBasis;
export type HostedAgentSessionConsentBasis = typeof HostedAgentSessionConsentBasis.Type;

/** Durable lifecycle of one Fidy-owned hosted conversational session. */
export const HostedAgentSession = Schema.Struct({
  id: HostedAgentSessionId,
  subjectUserId: UserId,
  consentBasis: HostedAgentSessionConsentBasis,
  startedAt: UtcTimestamp,
  lastTerminalTurnAt: Schema.Option(UtcTimestamp),
  status: Schema.Literals(["active", "idle-ended", "revoked"]),
});
export type HostedAgentSession = typeof HostedAgentSession.Type;
