import type { OwnedStatement } from "~/shell/_shared/owned-statement";
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

/** Recheck the exact established association and current Consent within protected work's D1 unit. */
export const liveWhatsAppAuthority = (subject: WhatsAppSubject): WhatsAppAuthority => {
  const identity = whatsAppCredentialAuthority(subject);
  return {
    ...identity,
    predicate: `${identity.predicate}
          AND EXISTS (SELECT 1 FROM onboarding_consent_records WHERE user_id = whatsapp_identities.user_id)
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

/**
 * Embed one resolved User's original TrialPeriod activity in the caller's D1 unit. The UTC
 * decision instant is inclusive at the start and exclusive at the end. This grants no caller
 * authority, performs no write, and must be composed with the caller's own authorization guard.
 */
export const activeTrialPredicate = ({
  userId,
  nowEpochMs,
}: Readonly<{ userId: string; nowEpochMs: number }>): OwnedStatement => ({
  sql: `EXISTS (SELECT 1 FROM trial_periods AS trial
    WHERE trial.user_id = ? AND trial.started_at_ms <= ? AND trial.ends_at_ms > ?)`,
  params: [userId, nowEpochMs, nowEpochMs],
});
