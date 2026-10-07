import type { OwnedStatement } from "~/shell/owner-write/contract";
import type { FreshSessionSubject, WebSessionAuthority, WebSessionSubject } from "./contract";

const freshSessionConditionSql = `EXISTS (SELECT 1 FROM web_sessions WHERE id = ? AND user_id = ? AND revoked_at_ms IS NULL
  AND fresh_until_ms > ? AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?)`;

/** Recheck a fresh User-owned WebSession within the same D1 unit as an authority change. */
export const freshSessionExists: string = freshSessionConditionSql;

/** Bind one resolved session and decision instant to the fresh-session condition, in order. */
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

/** WebSession credential alone, without Consent: allows classification after Consent revocation. */
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

/**
 * Require a resolved User-owned WebSession to remain unrevoked and before both expiry deadlines.
 * The caller must already have authenticated this session and commit the condition with its
 * protected work; this recheck does not prove bearer possession or current Consent.
 */
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

/**
 * Require a resolved User-owned WebSession to remain live and strictly before its fresh deadline.
 * Commit the condition in the same D1 unit as the authority change; current Consent is separate.
 */
export const freshSessionConditions = ({
  session,
  current,
}: Readonly<{ session: FreshSessionSubject; current: number }>): OwnedStatement => ({
  sql: freshSessionConditionSql,
  params: freshSessionParams({ session, time: current }),
});

/**
 * Prove the retained session belongs to this User for historical accountability, including after
 * revocation or expiry. This proves ownership only and must never authorize new protected work.
 */
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

/**
 * Select at most the addressed session's id and semantic userId while it remains live and fresh.
 * The caller-owned subject statement must select only the intended sessionId and userId, with
 * trusted SQL and parameterized values. Compose it within the protected D1 work; the query cannot
 * grant authority for a different subject, and its result grants no reusable permit or Consent.
 */
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

/**
 * Select retained WebSessions' pairingId references as a subquery for BrowserLogin expiry pruning.
 * A referenced pairing must remain retained even after its WebSession expires or is revoked.
 */
export const retainedSessionPairingsQuery = (): OwnedStatement => ({
  sql: "SELECT pairing_id AS pairingId FROM web_sessions",
  params: [],
});
