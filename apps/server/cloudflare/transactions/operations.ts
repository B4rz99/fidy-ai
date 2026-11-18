import { CurrentOAuthInvocation } from "../oauth-agents/contract";
import { recurringDiscoveryIntervalMs } from "../recurring/contract";
import type { LocalMutationResult } from "../canonical-admission/contract";
import { preserveStoreAlarm } from "../runtime/sqlite/operations";
import * as planningFacts from "./internal/planning-read";
import { readLocalTransactionAggregate as localAggregate } from "./internal/sqlite-aggregate";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { dashboardListStatement, decodeDashboardTransactions } from "./internal/dashboard-query";
import {
  type BudgetContributionCursor,
  type DashboardTransactionRead,
  type PrivacyTransactionsRead,
  type RecurringFactPage,
  type RecurringFactSnapshot,
  type RecurringFactsUnavailable,
  TransactionAggregatesUnavailable,
} from "./contract";
import {
  type CompletePeriodAggregates,
  TransactionId,
  type TransactionPeriod,
} from "../../src/core/transactions/contract";
import {
  correctLocalTransaction,
  deleteLocalTransaction as deleteNative,
  inspectLocalTransaction,
  missingLocalTransaction,
  prepareLocalDeletion as prepareDeletionInStore,
  prepareLocalCorrection as prepareNativeCorrection,
  prepareLocalPair as preparePair,
  reconcileLocalTransactions,
} from "./internal/sqlite-corrections";
import { type CatalogOperation } from "../../src/shell/canonical-catalog/contract";
import { canonicalAdmissionUnavailable, runLocalMutation } from "../canonical-admission/operations";
import { rawPathId } from "../http/operations";
import {
  captureLocalTransaction as captureNative,
  prepareLocalCapture as prepareNativeCapture,
} from "./internal/sqlite-capture";
import { prepareGroupCorrection as ownerPrepareGroupCorrection } from "./internal/group-correction";
import { effectiveTransactionRelation } from "./internal/effective-transaction";
import {
  readLocalTransactionPage as nativeReadLocalTransactionPage,
  readUserHistory as readLocalHistory,
} from "./internal/sqlite-history";
import { prepareDeletion as ownerPrepareDeletion } from "./internal/transaction-deletion";
import {
  findSnapshot,
  localFactPage,
  localFactSnapshot,
  readFacts,
  revisionGuard,
  revisionProjection,
} from "./internal/recurring-query";
import type { UserId } from "../../src/core/identity/contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import { type Cause, DateTime, Effect, Option, Schema } from "effect";
import { readDashboardTransactions as ownerReadDashboardTransactions } from "./internal/dashboard-read";
import {
  prepareBoundPlanningTransactions as ownerPrepareBoundPlanningTransactions,
  readPlanningTransactionSnapshot as ownerReadPlanningTransactionSnapshot,
  readPlanningTransactions as ownerReadPlanningTransactions,
} from "./internal/planning-read";
import {
  localProjectionRange,
  localProjectionReady,
  findDashboardAggregate as ownerFindDashboardAggregate,
  findDashboardAggregateRanges as ownerFindDashboardAggregateRanges,
  prepareBoundTransactionAggregate as ownerPrepareBoundTransactionAggregate,
  prepareTransactionAggregate as ownerPrepareTransactionAggregate,
  periodAggregateGuard,
  readPeriodAggregates,
} from "./internal/dashboard-projection";
import {
  browseTransactions as ownerBrowseTransactions,
  findTransaction as ownerFindCapturedTransaction,
  readBrowserTransactionPage as ownerReadBrowserTransactionPage,
  readPrivacyTransactions as ownerReadPrivacyTransactions,
  prepareBrowserTransactionPage as prepareInitialPage,
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

/** Run the browser History query with live authority and accountability in the destination User's transaction. */
export const readUserHistory: typeof readLocalHistory = (...args) => readLocalHistory(...args);

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

/** Compose one exact interval with peer reads while retaining Transaction-owned SQL and decoding. */
export const prepareTransactionAggregate: typeof ownerPrepareTransactionAggregate = (input) =>
  ownerPrepareTransactionAggregate(input);

/** Compose exact aggregates under an admission-owned live same-User selection. */
export const prepareBoundTransactionAggregate: typeof ownerPrepareBoundTransactionAggregate = (
  input
) => ownerPrepareBoundTransactionAggregate(input);

/** Read exact Currency-preserving contributions over a bounded half-open UTC interval. */
export const findDashboardAggregate: typeof ownerFindDashboardAggregate = (input) =>
  ownerFindDashboardAggregate(input);

/** Read bounded ordered intervals through current Consent and consistent projection revisions. */
export const findDashboardAggregateRanges: typeof ownerFindDashboardAggregateRanges = (input) =>
  ownerFindDashboardAggregateRanges(input);

/** Prepare irreversible history removal under live authority and the observed revision. */
export const prepareDeletion: typeof ownerPrepareDeletion = (input) => ownerPrepareDeletion(input);

const PlanningMonthRow = Schema.Struct({
  month: Schema.String.check(Schema.isPattern(/^20[0-9]{2}-(?:0[1-9]|1[0-2])$/u)),
});
const maximumMonths = 1200;
/** Read bounded same-User matching facts through their native owner. */
export const readPlanningTransactions: typeof ownerReadPlanningTransactions = (input) =>
  ownerReadPlanningTransactions(input);
/** Compose caller-owned context and independently complete matching ranges. */
export const readPlanningTransactionSnapshot: typeof ownerReadPlanningTransactionSnapshot = (
  input
) => ownerReadPlanningTransactionSnapshot(input);

/** Prepare effective matching facts and owner-selected references without an independent submission. */
export const prepareBoundPlanningTransactions: typeof ownerPrepareBoundPlanningTransactions = (
  input
) => ownerPrepareBoundPlanningTransactions(input);

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

/** Return the canonical browser page before HTTP encoding; the owner retains authority and Audit. */
export const readBrowserTransactionPage = (
  input: Parameters<typeof ownerReadBrowserTransactionPage>[0]
): ReturnType<typeof ownerReadBrowserTransactionPage> => ownerReadBrowserTransactionPage(input);

/** Compose the existing initial history page and Audit in bootstrap's final snapshot. */
export const prepareBrowserTransactionPage: typeof prepareInitialPage = (input) =>
  prepareInitialPage(input);

/** Prepare an explicit revision-checked selection for one all-or-nothing correction. */
export const prepareGroupCorrection: typeof ownerPrepareGroupCorrection = (input) =>
  ownerPrepareGroupCorrection(input);

/** Native single or composed capture. Admission and completion belong to the enclosing User transaction. */
export const captureLocalTransaction: typeof captureNative = (input, userId, current) =>
  captureNative(input, userId, current);

/** Canonical operations whose financial authority lives in the destination UserStore. */
export const isLocalTransactionOperation = (id: string): boolean =>
  [
    "transactions.createTransaction",
    "transactions.searchTransactions",
    "transactions.listTransactions",
    "transactions.updateTransaction",
    "transactions.deleteTransaction",
    "transactions.getTransaction",
    "transactions.linkTransactions",
    "transactions.unlinkTransactions",
  ].includes(id);

const invalidTransactionTarget = (
  id: string
): Option.Option<ReturnType<typeof missingLocalTransaction>> =>
  Option.isNone(Schema.decodeOption(TransactionId)(id))
    ? Option.some(missingLocalTransaction())
    : Option.none();
type LocalTransactionRequest = Readonly<{
  storage: DurableObjectStorage;
  request: Request;
  operation: CatalogOperation;
  owns: (userId: string) => boolean;
}>;
const historyResponse = Effect.fn(function* (unit: LocalTransactionRequest) {
  return yield* Option.isSome(yield* CurrentOAuthInvocation) ||
  unit.request.headers.has("authorization")
    ? runLocalMutation({
        ...unit,
        input: Effect.succeedSome(unit.request),
        work: readLocalTransactionPage,
      })
    : readUserHistory(unit.request, unit.owns);
});
const wakeForFacts = <A, E>(
  storage: DurableObjectStorage,
  work: (
    input: A,
    user: UserId,
    current: number
  ) => Effect.Effect<LocalMutationResult, E, SqliteClient>
): ((
  input: A,
  user: UserId,
  current: number
) => Effect.Effect<LocalMutationResult, E | Cause.UnknownError, SqliteClient>) =>
  Effect.fn(function* (input: A, user: UserId, current: number) {
    const outcome = yield* work(input, user, current);
    if (outcome.outcome === "success") {
      yield* preserveStoreAlarm(storage, current + recurringDiscoveryIntervalMs);
    }
    return outcome;
  });
const dispatchTransaction = Effect.fn(function* (unit: LocalTransactionRequest) {
  const { request, operation } = unit;
  const id = rawPathId({ request });
  const invalidTarget = invalidTransactionTarget(id);
  switch (operation.id) {
    case "transactions.createTransaction":
      return yield* runLocalMutation({
        ...unit,
        input: transactionInput(request),
        work: wakeForFacts(unit.storage, captureLocalTransaction),
      });
    case "transactions.updateTransaction":
      return yield* runLocalMutation(
        {
          ...unit,
          input: correctionInput(request).pipe(Effect.map(Option.map((input) => ({ id, input })))),
          work: wakeForFacts(unit.storage, correctLocalTransaction),
        },
        invalidTarget
      );
    case "transactions.deleteTransaction":
      return yield* runLocalMutation(
        {
          ...unit,
          input: Effect.succeedSome(id),
          work: wakeForFacts(unit.storage, deleteLocalTransaction),
        },
        invalidTarget
      );
    case "transactions.getTransaction":
      return yield* runLocalMutation(
        { ...unit, input: Effect.succeedSome(id), work: inspectLocalTransaction },
        invalidTarget
      );
    case "transactions.linkTransactions":
    case "transactions.unlinkTransactions": {
      const link = operation.id === "transactions.linkTransactions";
      return yield* runLocalMutation({
        ...unit,
        input: transactionPairInput(request).pipe(
          Effect.map(Option.map((input) => ({ input, link })))
        ),
        work: wakeForFacts(unit.storage, reconcileLocalTransactions),
      });
    }
    default:
      return new Response(null, { status: 404 });
  }
});

export const dispatchLocalTransaction = Effect.fn(
  function* (unit: LocalTransactionRequest) {
    if (
      ["transactions.listTransactions", "transactions.searchTransactions"].includes(
        unit.operation.id
      )
    ) {
      return yield* historyResponse(unit);
    }
    return yield* dispatchTransaction(unit);
  },
  Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
);

export const readLocalTransactionAggregate: typeof localAggregate = (user, from, toExclusive) =>
  localAggregate(user, from, toExclusive);
/** Supply complete effective list selections and exact financial ranges in the caller's local unit. */
export const readLocalDashboardTransactions = Effect.fn(function* (
  user: UserId,
  input: Pick<DashboardTransactionRead<never>, "lists" | "ranges" | "categories">
) {
  const sql = yield* SqliteClient;
  if (!(yield* localProjectionReady(user))) return yield* new TransactionAggregatesUnavailable();
  const lists = yield* Effect.forEach(
    input.lists,
    Effect.fnUntraced(function* (list) {
      const query = dashboardListStatement({ userId: user, ...list });
      const rows = yield* sql.unsafe(query.sql, query.params);
      return yield* Effect.fromOption(
        decodeDashboardTransactions({ rows, categories: input.categories }),
        () => new TransactionAggregatesUnavailable()
      );
    })
  );
  const ranges = yield* Effect.forEach(input.ranges, (range) =>
    localProjectionRange(user, range.from, range.toExclusive)
  );
  return { lists, ranges };
});

/** Read Effective Transactions in the calling UserStore transaction. */
export const readLocalPlanningRange: typeof planningFacts.localPlanningRange = (user, range) =>
  planningFacts.localPlanningRange(user, range);
export const readLocalPlanningReferences: typeof planningFacts.localPlanningReferences = (
  user,
  ids
) => planningFacts.localPlanningReferences(user, ids);
export const readLocalPlanningMonths = Effect.fn(function* (
  user: string,
  from: string,
  through: string
) {
  const sql = yield* SqliteClient;
  const rows =
    yield* sql`SELECT DISTINCT substr(occurred_at,1,7) AS month FROM transaction_effective_source WHERE user_id=${user} AND occurred_at_ms>=${DateTime.makeUnsafe(from).epochMilliseconds} AND occurred_at_ms<${DateTime.makeUnsafe(through).epochMilliseconds} ORDER BY month LIMIT 1201`;
  const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(PlanningMonthRow))(rows);
  return decoded.length <= maximumMonths
    ? Option.some(decoded.map((row) => row.month))
    : Option.none<ReadonlyArray<string>>();
});

export const readLocalFactSnapshot: typeof localFactSnapshot = (user) => localFactSnapshot(user);
export const readLocalFactPage: typeof localFactPage = (user, cursor) =>
  localFactPage(user, cursor);
export const deleteLocalTransaction: typeof deleteNative = (id, user, current) =>
  deleteNative(id, user, current);
export const readLocalTransactionPage: typeof nativeReadLocalTransactionPage = (...args) =>
  nativeReadLocalTransactionPage(...args);
export const prepareLocalCapture: typeof prepareNativeCapture = (input, user, current) =>
  prepareNativeCapture(input, user, current);
export const prepareLocalCorrection: typeof prepareNativeCorrection = (input, user, current) =>
  prepareNativeCorrection(input, user, current);
export const prepareLocalPair: typeof preparePair = (input, user, current) =>
  preparePair(input, user, current);
export const prepareLocalDeletion: typeof prepareDeletionInStore = (id, user, current) =>
  prepareDeletionInStore(id, user, current);
