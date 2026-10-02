import type {
  BrowserPairingApproval,
  BrowserPairingApprovalStatement,
  BrowserPairingClaim,
  BrowserPairingProof,
  PendingBrowserPairingQuery,
  PendingBrowserPairingRequest,
} from "./contract";
import type { Option } from "effect";
import type { OwnedStatement } from "../../src/shell/_shared/owned-statement";

import {
  pendingPairingQuery,
  prepareProvedApproval,
  provePendingPairing,
} from "./internal/email-approval";
import { prepareClaim } from "./internal/claim";

import {
  approveBrowserPairing as approve,
  redeemBrowserPairing as redeem,
  startBrowserPairing as start,
} from "./internal/pairing";

/** Create a bounded unbound pairing; disclose its private verifier only to the initiating browser. */
export const startBrowserPairing = (db: D1Database): Promise<Response> => start(db);

/** Bind a pending pairing only to the established User proved by this authenticated channel event. */
export const approveBrowserPairing = (input: BrowserPairingApproval): Promise<Response> =>
  approve(input);

/** Authenticate the browser-private verifier and redeem the approved pairing once. */
export const redeemBrowserPairing = (
  input: Readonly<{ request: Request; db: D1Database }>
): Promise<Response> => redeem(input);

/**
 * Prepare exact-verifier, unexpired one-use consumption and its established User projection.
 * Commit the consumption immediately before WebSession issuance in one D1 unit; the returned
 * statements do not run here and a projection alone grants no authority.
 */
export const prepareBrowserPairingClaim = (input: BrowserPairingProof): BrowserPairingClaim =>
  prepareClaim(input);

/** Check the browser-private verifier against the pending pairing and apply the bounded wrong-proof policy. */
export const provePendingBrowserPairing = (
  input: PendingBrowserPairingRequest
): Promise<Option.Option<number>> => provePendingPairing(input);
/** Project pairingId/expiresAt only for a currently pending, unexpired and unexhausted exact pairing subject. */
export const pendingBrowserPairingQuery = (input: PendingBrowserPairingQuery): OwnedStatement =>
  pendingPairingQuery(input);
/** Bind one pairing to its proving owner's current User projection; commit together with one-time proof consumption. */
export const prepareProvedBrowserPairingApproval = (
  input: BrowserPairingApprovalStatement
): D1PreparedStatement => prepareProvedApproval(input);
