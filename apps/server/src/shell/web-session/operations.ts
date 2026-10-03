import type { OwnedStatement } from "~/shell/owner-write/contract";
import type { FreshSessionSubject, WebSessionAuthority, WebSessionSubject } from "./contract";
import {
  freshSessionConditionParams,
  freshSessionRead,
  historicalSessionQuery,
  liveSessionCondition,
  retainedPairingsQuery,
  sessionCredentialAuthority,
  sessionFreshnessCondition,
} from "~/shell/web-session/internal/authority";

/** Recheck a fresh User-owned WebSession within the same D1 unit as an authority change. */
export const freshSessionExists: string = sessionFreshnessCondition();

/** Bind one resolved session and decision instant to the fresh-session condition, in order. */
export const freshSessionParams = (
  input: Readonly<{
    session: FreshSessionSubject;
    time: number;
  }>
): readonly [string, string, number, number, number] => freshSessionConditionParams(input);

/** WebSession credential alone, without Consent: allows classification after Consent revocation. */
export const webSessionCredentialAuthority = (
  input: Readonly<{
    subject: WebSessionSubject;
    current: number;
  }>
): WebSessionAuthority => sessionCredentialAuthority(input);

/**
 * Require a resolved User-owned WebSession to remain unrevoked and before both expiry deadlines.
 * The caller must already have authenticated this session and commit the condition with its
 * protected work; this recheck does not prove bearer possession or current Consent.
 */
export const liveSessionConditions = (
  input: Readonly<{
    session: FreshSessionSubject;
    current: number;
  }>
): OwnedStatement => liveSessionCondition(input);

/**
 * Require a resolved User-owned WebSession to remain live and strictly before its fresh deadline.
 * Commit the condition in the same D1 unit as the authority change; current Consent is separate.
 */
export const freshSessionConditions = ({
  session,
  current,
}: Readonly<{ session: FreshSessionSubject; current: number }>): OwnedStatement => ({
  sql: sessionFreshnessCondition(),
  params: freshSessionConditionParams({ session, time: current }),
});

/**
 * Prove the retained session belongs to this User for historical accountability, including after
 * revocation or expiry. This proves ownership only and must never authorize new protected work.
 */
export const sessionOwnershipQuery = (
  input: Readonly<{
    sessionId: string;
    userId: string;
  }>
): OwnedStatement => historicalSessionQuery(input);

/**
 * Select at most the addressed session's id and semantic userId while it remains live and fresh.
 * The caller-owned subject statement must select only the intended sessionId and userId, with
 * trusted SQL and parameterized values. Compose it within the protected D1 work; the query cannot
 * grant authority for a different subject, and its result grants no reusable permit or Consent.
 */
export const freshSessionQuery = (
  input: Readonly<{
    subject: OwnedStatement;
    current: number;
  }>
): OwnedStatement => freshSessionRead(input);

/**
 * Select retained WebSessions' pairingId references as a subquery for BrowserLogin expiry pruning.
 * A referenced pairing must remain retained even after its WebSession expires or is revoked.
 */
export const retainedSessionPairingsQuery = (): OwnedStatement => retainedPairingsQuery();
