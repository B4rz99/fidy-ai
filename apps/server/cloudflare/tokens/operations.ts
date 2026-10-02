import { type CatalogOperation } from "@fidy/server/canonical-runtime";
import { type AuthorizedPAT, type PATAuthorizationDecision, type PATRequest } from "./contract";
import { authorizeCanonicalPAT as authorize } from "./internal/pat-authorization";
import {
  patBrowserRoute as browserRoute,
  patDirectRoute as directRoute,
  handlePATRequest as handle,
  patMethods as methods,
  patRoute as route,
} from "./internal/pat-routes";
import { listPATs as list } from "./internal/pat-management";
import { sweepExpiredPATPairings as expire } from "./internal/pat-pairing";
import { commitPATUnit as commit } from "./internal/pat-unit";

/** Admit one declared canonical operation using the exact bearer, User, lifetime, Consent and scope. Protected work rechecks the returned proof in its atomic unit. */
export const authorizeCanonicalPAT = (
  input: PATRequest & Readonly<{ operation: CatalogOperation }>
): Promise<AuthorizedPAT | Exclude<PATAuthorizationDecision, "accepted">> => authorize(input);

/** Dispatch only a declared PAT operation; private pairing proofs and persisted grants stay with Tokens. */
export const handlePATRequest = (input: PATRequest): Promise<Response> => handle(input);

/** List only safe active metadata for the presented WebSession's User after current Consent and Audit checks. */
export const listPATs = (input: PATRequest): Promise<Response> => list(input);

/** Apply both fixed PAT expiry and unclaimed approval expiry with their symmetric Consent evidence. */
export const sweepExpiredPATPairings = (db: D1Database): Promise<void> => expire(db);

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
