import {
  effectiveHistoryPage,
  effectiveTransactionRelation,
} from "./internal/effective-transaction";
import { prepareDeletion as ownerPrepareDeletion } from "./internal/transaction-deletion";
import {
  findSnapshot,
  readFacts,
  revisionGuard,
  revisionProjection,
} from "./internal/recurring-query";
import type { UserId } from "../../src/core/identity/contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import { Effect, Option, Schema } from "effect";
import type {
  BudgetContributionCursor,
  PrivacyTransactionsRead,
  RecurringFactPage,
  RecurringFactSnapshot,
  RecurringFactsUnavailable,
  TransactionAggregatesUnavailable,
} from "./contract";
import { readDashboardTransactions as ownerReadDashboardTransactions } from "./internal/dashboard-read";
import {
  findDashboardAggregate as ownerFindDashboardAggregate,
  periodAggregateGuard,
  readPeriodAggregates,
} from "./internal/dashboard-projection";
import type {
  CompletePeriodAggregates,
  Transaction,
  TransactionPeriod,
} from "../../src/core/transactions/contract";
import {
  decodeTransactionRow,
  browseTransactions as ownerBrowseTransactions,
  findTransaction as ownerFindCapturedTransaction,
  readPrivacyTransactions as ownerReadPrivacyTransactions,
} from "./internal/transaction-history";
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
  transactionRefusal as ownerTransactionRefusal,
} from "./internal/transaction-outcome";
import {
  prepareNotificationEmailCapture as ownerPrepareNotificationEmailCapture,
  prepareReviewedCapture as ownerPrepareReviewedCapture,
  prepareStatementCapture as ownerPrepareStatementCapture,
} from "./internal/ingestion-capture";

export * from "./contract";

/** Read two complete exact selections at one financial revision; None is unavailable authority/readiness, never empty history. */
export const readCompletePeriodAggregates = (
  input: Readonly<{
    db: D1Database;
    userId: UserId;
    periods: readonly [TransactionPeriod, TransactionPeriod];
  }>
): Effect.Effect<Option.Option<CompletePeriodAggregates>, TransactionAggregatesUnavailable> =>
  readPeriodAggregates(input);

/** Recheck processing Consent, complete readiness and the observed revision in the caller's atomic publication batch. */
export const preparePeriodAggregateGuard = (
  input: Readonly<{ db: D1Database; userId: UserId; revision: number }>
): D1PreparedStatement => periodAggregateGuard(input);
/** Read one owned capture after a peer's atomic source decision commits. The caller owns authority. */
export const findCapturedTransaction: typeof ownerFindCapturedTransaction = (input) =>
  ownerFindCapturedTransaction(input);

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

/** Return bounded same-User financial history for an explicit Titular access request; every page requires fresh browser proof and atomic Audit, never renewed processing Consent. */
export const readPrivacyTransactions = (input: PrivacyTransactionsRead): Effect.Effect<Response> =>
  ownerReadPrivacyTransactions(input);

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

/** Decide a proved Transaction trigger refusal under the prepared child's exact caller authority. */

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
 * User-coordinated outcome batch. Both writes recheck a live same-User source query. Without
 * queuedAdmission they require current Consent. For bounded continuation after withdrawal, the
 * caller must supply the exact same-User unfinished, unexpired native admission originally queued
 * under active Consent. Malformed evidence fails before writes; commit both with the unique source
 * outcome and its assertion. Category assignment remains with the caller.
 */
export const prepareNotificationEmailCapture: typeof ownerPrepareNotificationEmailCapture = (
  input
) => ownerPrepareNotificationEmailCapture(input);

/** Read ready, decoded effective Transaction lists atomically with a caller-owned context snapshot. */
export const readDashboardTransactions: typeof ownerReadDashboardTransactions = (input) =>
  ownerReadDashboardTransactions(input);

/** Read exact Currency-preserving contributions over a bounded half-open UTC interval. */
export const findDashboardAggregate: typeof ownerFindDashboardAggregate = (input) =>
  ownerFindDashboardAggregate(input);

/** Prepare irreversible history removal under live authority and the observed revision. */
export const prepareDeletion: typeof ownerPrepareDeletion = (input) => ownerPrepareDeletion(input);

const PlanningMonthRow = Schema.Struct({
  month: Schema.String.check(Schema.isPattern(/^20[0-9]{2}-(?:0[1-9]|1[0-2])$/u)),
});
const maximumSelection = 128;
const maximumMonths = 1200;
/** Bounded same-User effective facts. The canonical coordinator owns live authority and serializes reads. */
export const readPlanningTransactions = ({
  db,
  userId,
  selection,
}: Readonly<{
  db: D1Database;
  userId: string;
  selection:
    | Readonly<{ kind: "ids"; ids: ReadonlyArray<string> }>
    | Readonly<{ kind: "range"; from: string; through: string }>;
}>): Effect.Effect<
  Option.Option<Readonly<{ transactions: ReadonlyArray<Transaction>; complete: boolean }>>
> =>
  Effect.gen(function* () {
    if (selection.kind === "ids" && selection.ids.length === 0) {
      return Option.some({ transactions: [], complete: true });
    }
    if (selection.kind === "ids" && selection.ids.length > maximumSelection) return Option.none();
    const selected =
      selection.kind === "ids"
        ? {
            where: `user_id = ? AND id IN (${selection.ids.map(() => "?").join(",")})`,
            bindings: [userId, ...selection.ids],
          }
        : {
            where: "user_id = ? AND occurred_at >= ? AND occurred_at < ?",
            bindings: [userId, selection.from, selection.through],
          };
    const query = effectiveHistoryPage({ userId, ...selected, limit: maximumSelection + 1 });
    const rows = yield* Effect.tryPromise(() =>
      db
        .prepare(query.sql)
        .bind(...query.bindings)
        .all()
    );
    const transactions = Option.all(
      rows.results.slice(0, maximumSelection).map(decodeTransactionRow)
    );
    return Option.map(transactions, (facts) => ({
      transactions: facts,
      complete: rows.results.length <= maximumSelection,
    }));
  }).pipe(Effect.orElseSucceed(() => Option.none()));

/** Complete bounded month identities, without transferring financial facts to a peer. */
export const readPlanningTransactionMonths = ({
  db,
  userId,
  from,
  through,
}: Readonly<{ db: D1Database; userId: string; from: string; through: string }>): Effect.Effect<
  Option.Option<ReadonlyArray<string>>
> =>
  Effect.gen(function* () {
    const relation = effectiveTransactionRelation(userId);
    const rows = yield* Effect.tryPromise(() =>
      db
        .prepare(`WITH ${relation.sql}
    SELECT DISTINCT substr(occurred_at, 1, 7) AS month FROM effective_transaction
    WHERE user_id = ? AND occurred_at >= ? AND occurred_at < ? ORDER BY month LIMIT 1201`)
        .bind(...relation.bindings, userId, from, through)
        .all()
    );
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(PlanningMonthRow))(rows.results);
    if (decoded.length > maximumMonths) return Option.none();
    return Option.some(decoded.map((row) => row.month));
  }).pipe(Effect.orElseSucceed(() => Option.none()));

export const prepareReviewedCapture: typeof ownerPrepareReviewedCapture = (input) =>
  ownerPrepareReviewedCapture(input);
