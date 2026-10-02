import { browseDashboard as browse } from "./internal/dashboard";
import {
  prepareDashboard as prepare,
  presentDashboard as present,
  dashboardRefusal as refusal,
} from "./internal/dashboard-mutation";

/**
 * Execute the caller's canonical Dashboard operation under live credential and User authority.
 * Document creation and edits use the shared canonical mutation unit; views expose only complete,
 * validated projections from the Categories, Transactions and Budgets published operations.
 * The caller applies canonical scope policy and dispatches document calls through the same User's
 * coordinator. Its turn covers every projection read, so a Correction cannot split a chart snapshot.
 * A subject identity is never a reusable authorization grant.
 */
export const browseDashboard: typeof browse = (input) => browse(input);

/**
 * Prepare first use or one validated edit for the shared one-User atomic unit. The caller owns
 * the commit boundary; live credential, revision and accountability guards are rechecked there.
 * An invalid initial edit leaves no document; batch collision and failure attribution stay intact.
 */
export const prepareDashboard: typeof prepare = (input) => prepare(input);

/** Present an owner-encoded committed value identically for individual and atomic-batch calls. */
export const presentDashboard: typeof present = (value) => present(value);

/** Record and present a closed owner refusal under the same live caller's authority. */
export const dashboardRefusal: typeof refusal = (input) => refusal(input);
