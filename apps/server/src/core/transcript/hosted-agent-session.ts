import { Schema } from "effect";
import { UtcTimestamp } from "~/core/_shared/time";
import {
  ConsentRecordId,
  DisclosureRevision,
  PolicyRevision,
  Sha256Digest,
} from "~/core/consent/reference";
import { UserId } from "~/core/identity/reference";
import { HostedAgentSessionId } from "./reference";

export { HostedAgentSessionId } from "./reference";

/** Exact onboarding Consent basis captured when a Hosted Agent Session begins. */
export const HostedAgentSessionConsentBasis = Schema.Struct({
  grantId: ConsentRecordId,
  disclosureRevision: DisclosureRevision,
  disclosureSha256: Sha256Digest,
  policyRevision: PolicyRevision,
  policySha256: Sha256Digest,
});
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
