import type { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { User, UserId } from "~/core/identity/contract";
import type { Unavailable } from "~/shell/public-http/contract";
import { getCurrentUser as readCurrentUser } from "./internal/current-user";
import type {
  FreshSessionSubject,
  WebSessionAuthority,
  WebSessionSubject,
  WhatsAppAuthority,
  WhatsAppSubject,
} from "./contract";

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

/** Recheck a fresh User-owned WebSession within the same D1 unit as an authority change. */
export const freshSessionExists = `EXISTS (SELECT 1 FROM web_sessions WHERE id = ? AND user_id = ? AND revoked_at_ms IS NULL
  AND fresh_until_ms > ? AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?)`;

/** WebSession credential alone, without Consent: allows classification after Consent revocation. */
export const webSessionCredentialAuthority = ({
  subject,
  current,
}: Readonly<{ subject: WebSessionSubject; current: number }>): WebSessionAuthority => ({
  table: "web_sessions",
  predicate: `id = ? AND user_id = ? AND token_digest = ? AND revoked_at_ms IS NULL
    AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?`,
  bindings: [subject.id, subject.userId, subject.digest, current, current],
});

/** D1 predicate that is re-evaluated with a protected browser canonical read. */
export const liveWebSessionAuthority = (
  input: Readonly<{ subject: WebSessionSubject; current: number }>
): WebSessionAuthority => {
  const credential = webSessionCredentialAuthority(input);
  return {
    ...credential,
    predicate: `${credential.predicate}
    AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = web_sessions.user_id)`,
  };
};

type SessionParams = readonly [string, string, number, number, number];
export const freshSessionParams = ({
  session,
  time,
}: Readonly<{ session: FreshSessionSubject; time: number }>): SessionParams => [
  session.id,
  session.user_id,
  time,
  time,
  time,
];
