import { ownPerformanceReceipt as nativePerformanceReceipt } from "./internal/performance-receipt";
import { readPrivacyPage } from "./internal/sqlite-privacy";
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
  prepareConnectionMovement as prepareBankCapture,
  prepareLocalCapture as prepareNativeCapture,
  prepareSourcedCapture as prepareNativeSourcedCapture,
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

export const readCompletePeriodAggregates = (
  input: Readonly<{
    db: D1Database;
    userId: UserId;
    periods: readonly [TransactionPeriod, TransactionPeriod];
  }>
): Effect.Effect<Option.Option<CompletePeriodAggregates>, TransactionAggregatesUnavailable> =>
  readPeriodAggregates(input);

export const preparePeriodAggregateGuard = (
  input: Readonly<{ db: D1Database; userId: UserId; revision: number }>
): D1PreparedStatement => periodAggregateGuard(input);

export const findCapturedTransaction: typeof ownerFindCapturedTransaction = (input) =>
  ownerFindCapturedTransaction(input);

export const findRecurringSnapshot = (
  input: Readonly<{ db: D1Database; userId: UserId }>
): Effect.Effect<Option.Option<RecurringFactSnapshot>, RecurringFactsUnavailable> =>
  findSnapshot(input);

export const readRecurringFacts = (
  input: Readonly<{
    db: D1Database;
    userId: UserId;
    revision: number;
    cursor: BudgetContributionCursor;
  }>
): Effect.Effect<Option.Option<RecurringFactPage>, RecurringFactsUnavailable> => readFacts(input);

export const prepareRecurringFactGuard = (
  input: Readonly<{ db: D1Database; userId: UserId; revision: number }>
): D1PreparedStatement => revisionGuard(input);

export const prepareFactRevisionProjection = (
  input: Readonly<{ db: D1Database; statement: OwnedStatement }>
): D1PreparedStatement => revisionProjection(input);

export const browseTransactions: typeof ownerBrowseTransactions = (...args) =>
  ownerBrowseTransactions(...args);

export const readScopedPrivacyPage: typeof readPrivacyPage = (...args) => readPrivacyPage(...args);
export const readUserHistory: typeof readLocalHistory = (...args) => readLocalHistory(...args);

export const readPrivacyTransactions = (input: PrivacyTransactionsRead): Effect.Effect<Response> =>
  ownerReadPrivacyTransactions(input);

export const correctionInput: typeof ownerCorrectionInput = (...args) =>
  ownerCorrectionInput(...args);

export const transactionPairInput: typeof ownerTransactionPairInput = (...args) =>
  ownerTransactionPairInput(...args);

export const transactionInput: typeof ownerTransactionInput = (...args) =>
  ownerTransactionInput(...args);

export const transactionSession: typeof ownerTransactionSession = (...args) =>
  ownerTransactionSession(...args);

export const repairDashboardProjection: typeof ownerRepairDashboardProjection = (...args) =>
  ownerRepairDashboardProjection(...args);

export const transactionRefusal: typeof ownerTransactionRefusal = (...args) =>
  ownerTransactionRefusal(...args);

export const prepareCapture: typeof ownerPrepareCapture = (...args) => ownerPrepareCapture(...args);

export const prepareCorrection: typeof ownerPrepareCorrection = (...args) =>
  ownerPrepareCorrection(...args);

export const prepareLink: typeof ownerPrepareLink = (...args) => ownerPrepareLink(...args);

export const prepareUnlink: typeof ownerPrepareUnlink = (...args) => ownerPrepareUnlink(...args);

export const findTransactionValue: typeof ownerFindTransactionValue = (...args) =>
  ownerFindTransactionValue(...args);

export const prepareStatementCapture: typeof ownerPrepareStatementCapture = (input) =>
  ownerPrepareStatementCapture(input);

export const prepareNotificationEmailCapture: typeof ownerPrepareNotificationEmailCapture = (
  input
) => ownerPrepareNotificationEmailCapture(input);

export const readDashboardTransactions: typeof ownerReadDashboardTransactions = (input) =>
  ownerReadDashboardTransactions(input);

export const prepareTransactionAggregate: typeof ownerPrepareTransactionAggregate = (input) =>
  ownerPrepareTransactionAggregate(input);

export const prepareBoundTransactionAggregate: typeof ownerPrepareBoundTransactionAggregate = (
  input
) => ownerPrepareBoundTransactionAggregate(input);

export const findDashboardAggregate: typeof ownerFindDashboardAggregate = (input) =>
  ownerFindDashboardAggregate(input);

export const findDashboardAggregateRanges: typeof ownerFindDashboardAggregateRanges = (input) =>
  ownerFindDashboardAggregateRanges(input);

export const prepareDeletion: typeof ownerPrepareDeletion = (input) => ownerPrepareDeletion(input);

const PlanningMonthRow = Schema.Struct({
  month: Schema.String.check(Schema.isPattern(/^20[0-9]{2}-(?:0[1-9]|1[0-2])$/u)),
});
const maximumMonths = 1200;

export const readPlanningTransactions: typeof ownerReadPlanningTransactions = (input) =>
  ownerReadPlanningTransactions(input);

export const readPlanningTransactionSnapshot: typeof ownerReadPlanningTransactionSnapshot = (
  input
) => ownerReadPlanningTransactionSnapshot(input);

export const prepareBoundPlanningTransactions: typeof ownerPrepareBoundPlanningTransactions = (
  input
) => ownerPrepareBoundPlanningTransactions(input);

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

export const readBrowserTransactionPage = (
  input: Parameters<typeof ownerReadBrowserTransactionPage>[0]
): ReturnType<typeof ownerReadBrowserTransactionPage> => ownerReadBrowserTransactionPage(input);

export const prepareBrowserTransactionPage: typeof prepareInitialPage = (input) =>
  prepareInitialPage(input);

export const prepareGroupCorrection: typeof ownerPrepareGroupCorrection = (input) =>
  ownerPrepareGroupCorrection(input);

export const captureLocalTransaction: typeof captureNative = (input, userId, current) =>
  captureNative(input, userId, current);

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
export const prepareLocalCapture: typeof prepareNativeCapture = (...args) =>
  prepareNativeCapture(...args);
export const prepareLocalCorrection: typeof prepareNativeCorrection = (input, user, current) =>
  prepareNativeCorrection(input, user, current);
export const prepareLocalPair: typeof preparePair = (input, user, current) =>
  preparePair(input, user, current);
export const prepareLocalDeletion: typeof prepareDeletionInStore = (id, user, current) =>
  prepareDeletionInStore(id, user, current);

export const prepareSourcedCapture: typeof prepareNativeSourcedCapture = (...args) =>
  prepareNativeSourcedCapture(...args);

export const readAddressedLocalTransaction: typeof inspectLocalTransaction = (...args) =>
  inspectLocalTransaction(...args);
export const prepareConnectionMovement: typeof prepareBankCapture = (...args) =>
  prepareBankCapture(...args);

export const ownPerformanceReceipt: typeof nativePerformanceReceipt = (
  request,
  environment,
  owns
) => nativePerformanceReceipt(request, environment, owns);
