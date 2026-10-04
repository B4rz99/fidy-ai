import { type CatalogOperation } from "../../src/shell/canonical-catalog/contract";
import {
  type AuthorizedPAT,
  type PATAuthorizationDecision,
  type PATMetadataQuery,
  type PATRequest,
} from "./contract";
import {
  authorizeCanonicalPAT as authorize,
  resolveCanonicalPATCredential as resolveCredential,
} from "./internal/pat-authorization";
import {
  patBrowserRoute as browserRoute,
  patDirectRoute as directRoute,
  handlePATRequest as handle,
  patMethods as methods,
  patRoute as route,
} from "./internal/pat-routes";
import { listPATsForCaller as list } from "./internal/pat-management";
import { commitPATUnit as commit } from "./internal/pat-unit";

/** Admit one declared canonical operation using the exact bearer, User, lifetime, Consent and scope. Protected work rechecks the returned proof in its atomic unit. */
export const authorizeCanonicalPAT = (
  input: PATRequest & Readonly<{ operation: CatalogOperation }>
): Promise<AuthorizedPAT | Exclude<PATAuthorizationDecision, "accepted">> => authorize(input);

/** Resolve only bearer ownership, lifetime and Consent; this proof grants no operation capability. The protected canonical coordinator and domain owner enforce the requested scope. */
export const resolveCanonicalPATCredential = (
  input: PATRequest & Readonly<{ operation: CatalogOperation }>
): Promise<AuthorizedPAT | "unauthenticated" | "user_action_required"> => resolveCredential(input);

/** Dispatch only a declared PAT operation; private pairing proofs and persisted grants stay with Tokens. */
export const handlePATRequest = (input: PATRequest): Promise<Response> => handle(input);

/** List safe active metadata under the exact caller proof, rechecking live WebSession and Consent in the audited D1 snapshot. PAT credentials cannot manage themselves. */
export const listPATs = (input: PATMetadataQuery): Promise<Response> => list(input);

/** Commit owner-composed PAT work with a final constraint that rolls back a skipped guard or Audit. */
export const commitPATUnit = (
  input: Readonly<{ db: D1Database; statements: ReadonlyArray<D1PreparedStatement> }>
): Promise<ReadonlyArray<D1Result>> => commit(input);

/** Whether a path belongs to either declared PAT API; no authority is implied. */
export const patRoute = (path: string): boolean => route(path);
/** Whether a path belongs to the direct, proof-bearing PATPairing API. */
export const patDirectRoute = (path: string): boolean => directRoute(path);
/** Whether a path belongs to the authenticated first-party PAT management API. */
export const patBrowserRoute = (path: string): boolean => browserRoute(path);
/** Declared methods for a recognized PAT path, without speculative endpoints. */
export const patMethods = (path: string): ReadonlyArray<string> => methods(path);
