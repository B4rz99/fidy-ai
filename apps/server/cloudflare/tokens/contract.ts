import type { PATSubject } from "../../src/shell/tokens/contract";
import type { WebSessionSubject } from "../../src/shell/web-session/contract";
import { Data } from "effect";

/** A PAT operation could not decide or commit; no dependency details cross the boundary. */
export class PATUnavailable extends Data.TaggedError("PATUnavailable") {}

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

/** Admitted query proof; Tokens rechecks the exact WebSession and refuses PAT self-management. */
export type PATMetadataQuery = Readonly<{
  db: D1Database;
  subject: WebSessionSubject | AuthorizedPAT;
}>;
