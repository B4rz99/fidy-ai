import { Function } from "effect";

/** Recheck a fresh User-owned WebSession within the same D1 unit as an authority change. */
export const freshSessionExists = `EXISTS (SELECT 1 FROM web_sessions WHERE id = ? AND user_id = ? AND revoked_at_ms IS NULL
  AND fresh_until_ms > ? AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?)`;

export type FreshSessionSubject = Readonly<{ id: string; user_id: string }>;
type WebSessionSubject = Readonly<{ id: string; userId: string; digest: Uint8Array }>;
type WebSessionAuthority = Readonly<{
  table: "web_sessions";
  predicate: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
}>;

/** D1 predicate that is re-evaluated with a protected browser canonical read. */
export const liveWebSessionAuthority = Function.dual<
  (current: number) => (subject: WebSessionSubject) => WebSessionAuthority,
  (subject: WebSessionSubject, current: number) => WebSessionAuthority
>(2, (subject, current) => ({
  table: "web_sessions",
  predicate: `id = ? AND user_id = ? AND token_digest = ? AND revoked_at_ms IS NULL
    AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?
    AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = web_sessions.user_id)`,
  bindings: [subject.id, subject.userId, subject.digest, current, current],
}));

type SessionParams = readonly [string, string, number, number, number];
export const freshSessionParams = Function.dual<
  (time: number) => (session: FreshSessionSubject) => SessionParams,
  (session: FreshSessionSubject, time: number) => SessionParams
>(2, (session, time) => [session.id, session.user_id, time, time, time]);
