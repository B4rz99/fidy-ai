import type { PATSubject } from "@fidy/server/tokens-contract";

/** Closed PAT admission outcomes; actual work must recheck the returned proof at commit. */
export type PATAuthorizationDecision =
  | "accepted"
  | "unauthenticated"
  | "scope_missing"
  | "user_action_required";
/** Exact PAT proof for rechecking one User and one operation, never reusable authority. */
export type AuthorizedPAT = PATSubject;

/** An incoming PAT request; the owner alone decodes proofs and accesses its persisted grants. */
export type PATRequest = Readonly<{ request: Request; db: D1Database }>;
