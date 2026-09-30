import { consentNotRevoked } from "~/shell/consent/runtime";

/** A BrowserLoginPairing candidate named by `id` must remain while any WebSession references it,
 * including expired or revoked sessions. Negate this predicate inside the pairing owner's atomic
 * cleanup; it conveys retention only, never authentication or authority. */
export const sessionPairingRetention = `id IN (SELECT pairing_id FROM web_sessions)`;

/** Recheck a fresh User-owned WebSession within the same D1 unit as an authority change. */
export const freshSessionExists = `EXISTS (SELECT 1 FROM web_sessions WHERE id = ? AND user_id = ? AND revoked_at_ms IS NULL
  AND fresh_until_ms > ? AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?)`;

export type FreshSessionSubject = Readonly<{ id: string; userId: string }>;
type WebSessionSubject = Readonly<{ id: string; userId: string; digest: Uint8Array }>;
/** One live-authority gate over the `web_sessions` table. */
export type WebSessionAuthority = Readonly<{
  table: "web_sessions";
  predicate: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
}>;

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
    AND ${consentNotRevoked("web_sessions.user_id")}`,
  };
};

type SessionParams = readonly [string, string, number, number, number];
export const freshSessionParams = ({
  session,
  time,
}: Readonly<{ session: FreshSessionSubject; time: number }>): SessionParams => [
  session.id,
  session.userId,
  time,
  time,
  time,
];
