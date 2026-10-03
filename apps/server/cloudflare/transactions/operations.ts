import {
  findSnapshot,
  readFacts,
  revisionGuard,
  revisionProjection,
} from "./internal/recurring-query";
import type { UserId } from "../../src/core/identity/contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import type { Effect, Option } from "effect";
import type {
  BudgetContributionCursor,
  RecurringFactPage,
  RecurringFactSnapshot,
  RecurringFactsUnavailable,
} from "./contract";
import { readBudgetContributions as ownerReadBudgetContributions } from "./internal/budget-query";
import { readDashboardTransactions as ownerReadDashboardTransactions } from "./internal/dashboard-read";
import { findDashboardAggregate as ownerFindDashboardAggregate } from "./internal/dashboard-projection";
import { browseTransactions as ownerBrowseTransactions } from "./internal/transaction-history";
import {
  correctionInput as ownerCorrectionInput,
  prepareCorrection as ownerPrepareCorrection,
} from "./internal/transaction-corrections";
import {
  prepareLink as ownerPrepareLink,
  prepareUnlink as ownerPrepareUnlink,
  transactionPairInput as ownerTransactionPairInput,
} from "./internal/transaction-reconciliation";
import {
  prepareCapture as ownerPrepareCapture,
  transactionInput as ownerTransactionInput,
  transactionSession as ownerTransactionSession,
} from "./internal/transactions";
import { repairDashboardProjection as ownerRepairDashboardProjection } from "./internal/dashboard-repair";
import {
  findTransactionValue as ownerFindTransactionValue,
  transactionBudgetRefusal as ownerTransactionBudgetRefusal,
  transactionMovementRefusal as ownerTransactionMovementRefusal,
  transactionRefusal as ownerTransactionRefusal,
  transactionTriggerRefusal as ownerTransactionTriggerRefusal,
} from "./internal/transaction-outcome";
import {
  prepareNotificationEmailCapture as ownerPrepareNotificationEmailCapture,
  prepareStatementCapture as ownerPrepareStatementCapture,
} from "./internal/ingestion-capture";

export * from "./contract";

/** Read one User's effective-fact revision under current processing Consent; absence is no authorized history. */
export const findRecurringSnapshot = (
  input: Readonly<{ db: D1Database; userId: UserId }>
): Effect.Effect<Option.Option<RecurringFactSnapshot>, RecurringFactsUnavailable> =>
  findSnapshot(input);
/** Read at most 128 decoded effective outflows; None means the expected revision or authority changed. */
export const readRecurringFacts = (
  input: Readonly<{
    db: D1Database;
    userId: UserId;
    revision: number;
    cursor: BudgetContributionCursor;
  }>
): Effect.Effect<Option.Option<RecurringFactPage>, RecurringFactsUnavailable> => readFacts(input);
/** Assert current processing Consent and the evaluated revision in the caller's atomic commit; refusal rolls it back. */
export const prepareRecurringFactGuard = (
  input: Readonly<{ db: D1Database; userId: UserId; revision: number }>
): D1PreparedStatement => revisionGuard(input);
/** Compose minimal fact-revision identities with a peer-owned bounded discovery; identities grant no access. */
export const prepareFactRevisionProjection = (
  input: Readonly<{ db: D1Database; statement: OwnedStatement }>
): D1PreparedStatement => revisionProjection(input);

/** Browse the same bounded canonical Transaction projection under live WebSession or PAT authority. */
export const browseTransactions: typeof ownerBrowseTransactions = (...args) =>
  ownerBrowseTransactions(...args);

/** Decode a bounded correction without treating omitted facts as explicit decisions. */
export const correctionInput: typeof ownerCorrectionInput = (...args) =>
  ownerCorrectionInput(...args);

/** Decode one bounded canonical pair without treating either id as authority. */
export const transactionPairInput: typeof ownerTransactionPairInput = (...args) =>
  ownerTransactionPairInput(...args);

/** Decode bounded canonical input before dispatching a mutation to the User coordinator. */
export const transactionInput: typeof ownerTransactionInput = (...args) =>
  ownerTransactionInput(...args);

/** Resolve a live WebSession on every canonical call; neither an object id nor a User id is authority. */
export const transactionSession: typeof ownerTransactionSession = (...args) =>
  ownerTransactionSession(...args);

/** Repair one User's projection in bounded pages; views stay unavailable until guarded cutover. */
export const repairDashboardProjection: typeof ownerRepairDashboardProjection = (...args) =>
  ownerRepairDashboardProjection(...args);

/** Record a metadata-only Transaction refusal under its child authority and render its own response. */
export const transactionRefusal: typeof ownerTransactionRefusal = (...args) =>
  ownerTransactionRefusal(...args);

/**
 * Decide one canonical Transaction capture against live caller authority, User context, and the
 * Category taxonomy. The returned statements are guard-chained writes; the caller's D1 unit
 * commits them or none of them.
 */
export const prepareCapture: typeof ownerPrepareCapture = (...args) => ownerPrepareCapture(...args);

/**
 * Decide one canonical Transaction correction against live caller authority and the revision the
 * caller observed. The returned statements are guard-chained writes; the caller's D1 unit commits
 * them or none of them.
 */
export const prepareCorrection: typeof ownerPrepareCorrection = (...args) =>
  ownerPrepareCorrection(...args);

/** Decide one canonical link against live authority and both retained candidates. */
export const prepareLink: typeof ownerPrepareLink = (...args) => ownerPrepareLink(...args);

/** Decide one canonical unlink against live authority and the pair's current decision state. */
export const prepareUnlink: typeof ownerPrepareUnlink = (...args) => ownerPrepareUnlink(...args);

/**
 * Read the records one committed Transaction child presents, or None when the unit read back an
 * incomplete set. The individual response and the atomic-batch child output encode the same value.
 */
export const findTransactionValue: typeof ownerFindTransactionValue = (...args) =>
  ownerFindTransactionValue(...args);

/**
 * The refusal a Transaction child reports when the shared daily audit budget, not the child,
 * refused its unit. The canonical limited result is rendered without a refusal AuditLogEntry: the
 * budget that refused the work is the same one the record would consume.
 */
export const transactionBudgetRefusal: typeof ownerTransactionBudgetRefusal = (...args) =>
  ownerTransactionBudgetRefusal(...args);

/** Decide a proved Transaction trigger refusal under the prepared child's exact caller authority. */
export const transactionTriggerRefusal: typeof ownerTransactionTriggerRefusal = (input) =>
  ownerTransactionTriggerRefusal(input);

/** The refusal a capture child reports when the daily manual-movement budget aborts its unit. */
export const transactionMovementRefusal: typeof ownerTransactionMovementRefusal = (...args) =>
  ownerTransactionMovementRefusal(...args);

/**
 * Prepare one statement Transaction and historical SourceAttestation for the caller's existing
 * User-coordinated outcome batch. The source query projects user_id for eligible work at commit;
 * a foreign source cannot authorize this User. Commit both writes with the unique source outcome
 * and its assertion. Category assignment and admission Consent remain with the caller.
 */
export const prepareStatementCapture: typeof ownerPrepareStatementCapture = (input) =>
  ownerPrepareStatementCapture(input);

/**
 * Prepare one notification-email Transaction and its captured evidence for the caller's existing
 * User-coordinated outcome batch. Both writes recheck current Consent and a live source query
 * projecting the same user_id. Malformed evidence fails before writes; commit both with the unique
 * source outcome and its assertion. Category assignment remains with the caller.
 */
export const prepareNotificationEmailCapture: typeof ownerPrepareNotificationEmailCapture = (
  input
) => ownerPrepareNotificationEmailCapture(input);

/** Read a bounded ascending page of effective outflows for one User, Category, Currency and interval. */
export const readBudgetContributions: typeof ownerReadBudgetContributions = (input) =>
  ownerReadBudgetContributions(input);

/** Read ready, decoded effective Transaction lists atomically with a caller-owned context snapshot. */
export const readDashboardTransactions: typeof ownerReadDashboardTransactions = (input) =>
  ownerReadDashboardTransactions(input);

/** Read exact Currency-preserving contributions over a bounded half-open UTC interval. */
export const findDashboardAggregate: typeof ownerFindDashboardAggregate = (input) =>
  ownerFindDashboardAggregate(input);
