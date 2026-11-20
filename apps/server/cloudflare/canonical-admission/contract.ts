import type { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Data, type Effect, type Option, type Schema } from "effect";
import type { WebSessionAuthority } from "../../src/shell/web-session/contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import type { OAuthCaller } from "../../src/shell/oauth-agents/contract";
import type { AuthorizedPAT } from "../tokens/contract";
import type { AuthenticatedWebSession } from "../web-session/contract";

export type PreparedCanonicalBrowserRead = Readonly<{
  statements: ReadonlyArray<D1PreparedStatement>;
  present: (results: ReadonlyArray<D1Result>) => Effect.Effect<Response>;
}>;

export type CanonicalBrowserRead = (
  input: Readonly<{
    db: D1Database;
    authority: WebSessionAuthority;
    reservation: OwnedStatement;
    current: number;
  }>
) => PreparedCanonicalBrowserRead;

export type AuthorizedCanonicalCaller = Readonly<
  | { _tag: "PAT"; value: AuthorizedPAT }
  | { _tag: "WebSession"; value: AuthenticatedWebSession }
  | { _tag: "OAuth"; value: OAuthCaller }
>;

export class CanonicalAdmissionUnavailable extends Data.TaggedError(
  "CanonicalAdmissionUnavailable"
)<{ readonly cause: unknown }> {}

export const canonicalRequestProtection = {
  intervalMs: 100,
  burst: 10,
  concurrency: 2,
  leaseMs: 90000,
  retryAfterSeconds: 1,
} as const;

export type CanonicalReadCompletion = Readonly<{ leaseId: string }>;

export type CanonicalReadFinalization = () => Effect.Effect<
  Readonly<{
    statements: ReadonlyArray<D1PreparedStatement>;
    committed: (rows: ReadonlyArray<D1Result>) => void;
  }>
>;

export const canonicalReadCompletionHeader = "fidy-internal-read-completion";

export type CanonicalBrowserSourceRead = (input: Parameters<CanonicalBrowserRead>[0]) => Readonly<{
  statements: ReadonlyArray<D1PreparedStatement>;
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
  | "budgets.getBudgetStatus"
  | "ingestion.getReviewWorkspace"
  | "ingestion.getReviewPageContext"
  | "ingestion.getReviewItem";

export type LocalMutationResult = Readonly<{
  status: number;
  outcome: "success" | "validation_failed" | "not_found" | "resource_limit";
  body: Schema.Json;
}>;

export type LocalReviewFacts = { effect: string; revision: string };
export type LocalMutationPlan = Readonly<{
  review: Option.Option<
    Effect.Effect<LocalReviewFacts, CanonicalAdmissionUnavailable, SqliteClient>
  >;
  premises: ReadonlyArray<string>;
  targets: ReadonlyArray<string>;
  removedTarget: Option.Option<string>;
  commit: Effect.Effect<LocalMutationResult, CanonicalAdmissionUnavailable, SqliteClient>;
}>;
export type LocalMutationPreparation = LocalMutationResult | LocalMutationPlan;
