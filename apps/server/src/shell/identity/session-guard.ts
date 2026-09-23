/** Recheck a fresh User-owned WebSession within the same D1 unit as an authority change. */
export const freshSessionExists = `EXISTS (SELECT 1 FROM web_sessions WHERE id = ? AND user_id = ? AND revoked_at_ms IS NULL
  AND fresh_until_ms > ? AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?)`;

export type FreshSessionSubject = Readonly<{ id: string; user_id: string }>;
/** D1 predicate that is re-evaluated with a protected browser canonical read. */
export const liveWebSessionAuthority = (
  subject: Readonly<{ id: string; userId: string; digest: Uint8Array }>,
  current: number
): Readonly<{
  table: "web_sessions";
  predicate: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
}> => ({
  table: "web_sessions",
  predicate: `id = ? AND user_id = ? AND token_digest = ? AND revoked_at_ms IS NULL
    AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?
    AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = web_sessions.user_id)`,
  bindings: [subject.id, subject.userId, subject.digest, current, current],
});

export const freshSessionParams = (
  session: FreshSessionSubject,
  time: number
): readonly [string, string, number, number, number] => [
  session.id,
  session.user_id,
  time,
  time,
  time,
];
