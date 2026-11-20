import type { OwnedStatement } from "~/shell/owner-write/contract";
import type { FreshSessionSubject, WebSessionAuthority, WebSessionSubject } from "./contract";

const freshSessionConditionSql = `EXISTS (SELECT 1 FROM web_sessions WHERE id = ? AND user_id = ? AND revoked_at_ms IS NULL
  AND fresh_until_ms > ? AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?)`;

export const freshSessionExists: string = freshSessionConditionSql;

export const freshSessionParams = ({
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

export const webSessionCredentialAuthority = ({
  subject,
  current,
}: Readonly<{
  subject: WebSessionSubject;
  current: number;
}>): WebSessionAuthority => ({
  table: "web_sessions",
  predicate: `id = ? AND user_id = ? AND token_digest = ? AND revoked_at_ms IS NULL
    AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?`,
  bindings: [subject.id, subject.userId, subject.digest, current, current],
});

export const liveSessionConditions = ({
  session,
  current,
}: Readonly<{
  session: FreshSessionSubject;
  current: number;
}>): OwnedStatement => ({
  sql: `EXISTS (SELECT 1 FROM web_sessions WHERE id = ? AND user_id = ?
    AND revoked_at_ms IS NULL AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?)`,
  params: [session.id, session.user_id, current, current],
});

export const freshSessionConditions = ({
  session,
  current,
}: Readonly<{ session: FreshSessionSubject; current: number }>): OwnedStatement => ({
  sql: freshSessionConditionSql,
  params: freshSessionParams({ session, time: current }),
});

export const sessionOwnershipQuery = ({
  sessionId,
  userId,
}: Readonly<{
  sessionId: string;
  userId: string;
}>): OwnedStatement => ({
  sql: "SELECT 1 FROM web_sessions WHERE id = ? AND user_id = ?",
  params: [sessionId, userId],
});

export const freshSessionQuery = ({
  subject,
  current,
}: Readonly<{
  subject: OwnedStatement;
  current: number;
}>): OwnedStatement => ({
  sql: `SELECT fresh_session.id, fresh_session.user_id AS userId FROM web_sessions AS fresh_session
    WHERE (fresh_session.id, fresh_session.user_id) IN (SELECT sessionId, userId FROM (${subject.sql}))
      AND fresh_session.revoked_at_ms IS NULL AND fresh_session.fresh_until_ms > ?
      AND fresh_session.idle_expires_at_ms > ? AND fresh_session.hard_expires_at_ms > ?`,
  params: [...subject.params, current, current, current],
});

export const retainedSessionPairingsQuery = (): OwnedStatement => ({
  sql: "SELECT pairing_id AS pairingId FROM web_sessions",
  params: [],
});
