import { ownPerformanceEvidence as nativePerformanceEvidence } from "./internal/performance-receipt";
import { readPrivacyPage } from "./internal/sqlite-privacy";
import { CurrentOAuthInvocation } from "../oauth-agents/contract";
import { recurringDiscoveryIntervalMs } from "../recurring/contract";
import type { Category } from "../../src/core/categories/contract";
import type { LocalMutationResult } from "../canonical-admission/contract";
import { preserveStoreAlarm } from "../runtime/sqlite/operations";
import * as planningFacts from "./internal/planning-read";
import { readLocalTransactionAggregate as localAggregate } from "./internal/sqlite-aggregate";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { dashboardListStatement, decodeDashboardTransactions } from "./internal/dashboard-query";
import { type DashboardTransactionList, TransactionAggregatesUnavailable } from "./contract";
import { TransactionId } from "../../src/core/transactions/contract";
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
import {
  readLocalTransactionPage as nativeReadLocalTransactionPage,
  readUserHistory as readLocalHistory,
} from "./internal/sqlite-history";
import { localFactPage, localFactSnapshot } from "./internal/recurring-query";
import type { UserId } from "../../src/core/identity/contract";
import { type Cause, DateTime, Effect, Option, Schema } from "effect";
import { localProjectionRange, localProjectionReady } from "./internal/dashboard-projection";
import { correctionInput as ownerCorrectionInput } from "./internal/transaction-corrections";
import { transactionPairInput as ownerTransactionPairInput } from "./internal/transaction-reconciliation";
import { transactionInput as ownerTransactionInput } from "./internal/transactions";

export * from "./contract";

export const readScopedPrivacyPage: typeof readPrivacyPage = (...args) => readPrivacyPage(...args);

export const readUserHistory: typeof readLocalHistory = (...args) => readLocalHistory(...args);

export const correctionInput: typeof ownerCorrectionInput = (...args) =>
  ownerCorrectionInput(...args);

export const transactionPairInput: typeof ownerTransactionPairInput = (...args) =>
  ownerTransactionPairInput(...args);

export const transactionInput: typeof ownerTransactionInput = (...args) =>
  ownerTransactionInput(...args);

const PlanningMonthRow = Schema.Struct({
  month: Schema.String.check(Schema.isPattern(/^20[0-9]{2}-(?:0[1-9]|1[0-2])$/u)),
});

const maximumMonths = 1200;

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
): Option.Option<() => ReturnType<typeof missingLocalTransaction>> =>
  Option.isNone(Schema.decodeOption(TransactionId)(id))
    ? Option.some(() => missingLocalTransaction())
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

    yield* preserveStoreAlarm(storage, current + recurringDiscoveryIntervalMs);

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
  Effect.tapCause(Effect.logDebug),
  Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
);

export const readLocalTransactionAggregate: typeof localAggregate = (user, from, toExclusive) =>
  localAggregate(user, from, toExclusive);

export const readLocalDashboardTransactions = Effect.fn(function* (
  user: UserId,
  input: Readonly<{
    lists: ReadonlyArray<DashboardTransactionList>;
    ranges: ReadonlyArray<Readonly<{ from: number; toExclusive: number }>>;
    categories: ReadonlyArray<Category>;
  }>
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

export const ownPerformanceEvidence: typeof nativePerformanceEvidence = (
  request,
  environment,
  owns
) => nativePerformanceEvidence(request, environment, owns);
