import { browseDashboard as browse } from "./internal/dashboard";
import {
  prepareDashboard as prepare,
  presentDashboard as present,
  dashboardRefusal as refusal,
} from "./internal/dashboard-mutation";

/**
 * Execute the caller's canonical Dashboard operation under live credential and User authority.
 * Only explicit initialization and edits use the canonical mutation unit; queries never create or
 * repair domain state and return DashboardUninitialized for genuine absence. Views expose complete,
 * validated projections from the Categories, Transactions and Budgets published operations.
 * The caller applies canonical scope policy and dispatches document queries and mutations through the same User's
 * coordinator. Its turn covers every projection read, so a Correction cannot split a chart snapshot.
 * A subject identity is never a reusable authorization grant.
 */
export const browseDashboard: typeof browse = (input) => browse(input);

/**
 * Prepare explicit initialization or one validated edit for the shared one-User atomic
 * unit. Initialization returns an existing document without changing its content or revision.
 * The caller owns the commit boundary; live credential, revision and accountability guards are
 * rechecked there. An invalid initial edit leaves no document; batch collision and failure
 * attribution stay intact.
 */
export const prepareDashboard: typeof prepare = (input) => prepare(input);

/** Present an owner-encoded committed value identically for individual and atomic-batch calls. */
export const presentDashboard: typeof present = (value) => present(value);

/** Record and present a closed owner refusal under the same live caller's authority. */
export const dashboardRefusal: typeof refusal = (input) => refusal(input);
