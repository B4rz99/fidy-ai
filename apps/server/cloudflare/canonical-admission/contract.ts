import { Data, type Effect, type Option } from "effect";
import type { WebSessionAuthority } from "../../src/shell/web-session/contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import type { OAuthCaller } from "../../src/shell/oauth-agents/contract";
import type { AuthorizedPAT } from "../tokens/contract";
import type { AuthenticatedWebSession } from "../web-session/contract";

/** An owner-prepared unmetered browser read; presentation follows the complete protected batch.
 * Closed to existing observations with unmetered browser policies.
 */
export type PreparedCanonicalBrowserRead = Readonly<{
  statements: ReadonlyArray<D1PreparedStatement>;
  /** Bounded decoding, pure calculation and encoding; no storage or provider work after the atomic snapshot. */
  present: (results: ReadonlyArray<D1Result>) => Effect.Effect<Response>;
}>;

export type CanonicalBrowserRead = (
  input: Readonly<{
    db: D1Database;
    authority: WebSessionAuthority;
    /** Admission-owned live credential selection, valid only in this native snapshot. */
    reservation: OwnedStatement;
    current: number;
  }>
) => PreparedCanonicalBrowserRead;

/** Authorization is supplied by the credential owner, never inferred from an allowance or a retry key. */
export type AuthorizedCanonicalCaller = Readonly<
  | { _tag: "PAT"; value: AuthorizedPAT }
  | { _tag: "WebSession"; value: AuthenticatedWebSession }
  | { _tag: "OAuth"; value: OAuthCaller }
>;

/** Private dependency failure without SQL or credential disclosure. */
export class CanonicalAdmissionUnavailable extends Data.TaggedError(
  "CanonicalAdmissionUnavailable"
)<{ readonly cause: unknown }> {}

/** One stable User shares the initial API protection envelope, irrespective of credentials or AccessTier. */
export const canonicalRequestProtection = {
  intervalMs: 100,
  burst: 10,
  concurrency: 2,
  leaseMs: 90000,
  retryAfterSeconds: 1,
} as const;

/** Server-owned continuation for a phased browser query; it grants no credential authority. */
export type CanonicalReadCompletion = Readonly<{ leaseId: string }>;

/** Final accounting is prepared at the last snapshot, never reused across native transactions. */
export type CanonicalReadFinalization = () => Effect.Effect<
  Readonly<{
    statements: ReadonlyArray<D1PreparedStatement>;
    committed: (rows: ReadonlyArray<D1Result>) => void;
  }>
>;

export const canonicalReadCompletionHeader = "fidy-internal-read-completion";

/** Source selection shares admission; dependent work must freshly fence final disclosure and settle its lease. */
export type CanonicalBrowserSourceRead = (input: Parameters<CanonicalBrowserRead>[0]) => Readonly<{
  statements: ReadonlyArray<D1PreparedStatement>;
  /** Preserve an owner's existing storage-failure response; authority and pressure refusals stay shared. */
  unavailable: Option.Option<() => Response>;
  present: (
    rows: ReadonlyArray<D1Result>,
    subject: AuthenticatedWebSession,
    completion: CanonicalReadCompletion
  ) => Effect.Effect<Response>;
}>;

export type PreparedCanonicalReadCompletion = Readonly<{
  statements: ReadonlyArray<D1PreparedStatement>;
  present: (rows: ReadonlyArray<D1Result>, response: Response) => Response;
}>;
export type CanonicalBrowserQueryFinalizer = Readonly<{
  finalization: CanonicalReadFinalization;
  present: (response: Response) => Response;
}>;

export type CanonicalBrowserSnapshotOperation =
  | "pats.listPATs"
  | "subscription.listSubscriptionOffers"
  | "subscription.getSubscriptionStatus"
  | "recurringPlans.getRecurringWorkspace"
  | "categories.listCategories"
  | "dashboard.listDashboardCatalog"
  | "transactions.listTransactions"
  | "budgets.getBudgetStatus"
  | "ingestion.getReviewWorkspace"
  | "ingestion.getReviewPageContext"
  | "ingestion.getReviewItem";
