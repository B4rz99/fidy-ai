import type { OwnedStatement } from "~/shell/owner-write/contract";
import type {
  FreshSessionSubject,
  WebSessionAuthority,
  WebSessionSubject,
} from "~/shell/web-session/contract";

const freshSessionConditionSql = `EXISTS (SELECT 1 FROM web_sessions WHERE id = ? AND user_id = ? AND revoked_at_ms IS NULL
  AND fresh_until_ms > ? AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?)`;

export const freshSessionConditionParams = ({
  session,
  time,
}: Readonly<{
  session: FreshSessionSubject;
  time: number;
}>): readonly [string, string, number, number, number] => [
  session.id,
  session.user_id,
  time,
  time,
  time,
];

export const sessionCredentialAuthority = ({
  subject,
  current,
}: Readonly<{ subject: WebSessionSubject; current: number }>): WebSessionAuthority => ({
  table: "web_sessions",
  predicate: `id = ? AND user_id = ? AND token_digest = ? AND revoked_at_ms IS NULL
    AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?`,
  bindings: [subject.id, subject.userId, subject.digest, current, current],
});

export const liveSessionCondition = ({
  session,
  current,
}: Readonly<{ session: FreshSessionSubject; current: number }>): OwnedStatement => ({
  sql: `EXISTS (SELECT 1 FROM web_sessions WHERE id = ? AND user_id = ?
    AND revoked_at_ms IS NULL AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?)`,
  params: [session.id, session.user_id, current, current],
});

export const historicalSessionQuery = ({
  sessionId,
  userId,
}: Readonly<{ sessionId: string; userId: string }>): OwnedStatement => ({
  sql: "SELECT 1 FROM web_sessions WHERE id = ? AND user_id = ?",
  params: [sessionId, userId],
});

export const freshSessionRead = ({
  subject,
  current,
}: Readonly<{ subject: OwnedStatement; current: number }>): OwnedStatement => ({
  sql: `SELECT fresh_session.id, fresh_session.user_id AS userId FROM web_sessions AS fresh_session
    WHERE (fresh_session.id, fresh_session.user_id) IN (SELECT sessionId, userId FROM (${subject.sql}))
      AND fresh_session.revoked_at_ms IS NULL AND fresh_session.fresh_until_ms > ?
      AND fresh_session.idle_expires_at_ms > ? AND fresh_session.hard_expires_at_ms > ?`,
  params: [...subject.params, current, current, current],
});

export const retainedPairingsQuery = (): OwnedStatement => ({
  sql: "SELECT pairing_id AS pairingId FROM web_sessions",
  params: [],
});

export const sessionFreshnessCondition = (): string => freshSessionConditionSql;
