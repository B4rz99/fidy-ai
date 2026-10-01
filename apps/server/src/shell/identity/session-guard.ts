import { protectConsentAuthority } from "~/shell/consent/operations";

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
  return protectConsentAuthority({
    authority: credential,
    subject: { _tag: "Owner", column: "web_sessions.user_id" },
    requirement: "unrevoked",
  });
};
