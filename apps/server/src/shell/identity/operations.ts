import type { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { User, UserId } from "~/core/identity/contract";
import type { Unavailable } from "~/shell/public-http/contract";
import { getCurrentUser as readCurrentUser } from "./internal/current-user";
import type { WhatsAppAuthority, WhatsAppSubject } from "./contract";

/** Recheck all three association keys, including after revocation so the caller can classify refusal. */
export const whatsAppCredentialAuthority = (subject: WhatsAppSubject): WhatsAppAuthority => ({
  table: "whatsapp_identities",
  predicate: "user_id = ? AND portfolio_id = ? AND bsuid = ?",
  bindings: [subject.userId, subject.portfolioId, subject.bsuid],
});

/**
 * Recheck the exact User association and retained onboarding basis within browser approval's D1
 * unit. Revocation does not deny authentication needed for re-consent or data-rights access.
 */
export const establishedWhatsAppAuthority = (subject: WhatsAppSubject): WhatsAppAuthority => {
  const identity = whatsAppCredentialAuthority(subject);
  return {
    ...identity,
    predicate: `${identity.predicate}
          AND EXISTS (SELECT 1 FROM onboarding_consent_records WHERE user_id = whatsapp_identities.user_id)`,
  };
};

/** Recheck the exact established association and current Consent within protected work's D1 unit. */
export const liveWhatsAppAuthority = (subject: WhatsAppSubject): WhatsAppAuthority => {
  const identity = establishedWhatsAppAuthority(subject);
  return {
    ...identity,
    predicate: `${identity.predicate}
          AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = whatsapp_identities.user_id)`,
  };
};

/** Load authoritative stable User context; neither channel evidence nor a contact grants authority. */
export const getCurrentUser = (
  userId: UserId
): Effect.Effect<
  { readonly data: User; readonly next: ReadonlyArray<never> },
  Unavailable,
  SqlClient.SqlClient
> => readCurrentUser(userId);
