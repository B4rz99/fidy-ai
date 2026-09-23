/** Recheck a fresh User-owned WebSession within the same D1 unit as an authority change. */
export const freshSessionExists = `EXISTS (SELECT 1 FROM web_sessions WHERE id = ? AND user_id = ? AND revoked_at_ms IS NULL
  AND fresh_until_ms > ? AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?)`;

export type FreshSessionSubject = Readonly<{ id: string; user_id: string }>;
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
