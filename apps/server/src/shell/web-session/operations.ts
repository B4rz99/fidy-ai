import type { FreshSessionSubject, WebSessionAuthority, WebSessionSubject } from "./contract";

/** Recheck a fresh User-owned WebSession within the same D1 unit as an authority change. */
export const freshSessionExists = `EXISTS (SELECT 1 FROM web_sessions WHERE id = ? AND user_id = ? AND revoked_at_ms IS NULL
  AND fresh_until_ms > ? AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?)`;

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
