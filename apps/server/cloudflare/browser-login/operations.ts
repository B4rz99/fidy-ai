import { prepareClaim } from "./internal/claim";
import type { BrowserPairingApproval, BrowserPairingClaim, BrowserPairingProof } from "./contract";
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
