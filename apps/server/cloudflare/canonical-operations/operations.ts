import {
  readAddressedLocalTransaction,
  readLocalTransactionPage,
} from "../transactions/operations";
import type { CanonicalAuthorityRoot } from "../../src/shell/canonical-policy/contract";
import { InsightEventId } from "../../src/core/insights/contract";
import {
  readLocalDigestReport,
  readLocalPendingInsights,
  readLocalReminder,
} from "../insights/operations";
import { readLocalMemories } from "../memory/operations";
import type { UserId } from "../../src/core/identity/contract";
import type { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import type { UserStoreBindings } from "../directory/contract";
import {
  readLocalReviewPage,
  readLocalSubmission,
  reserveBatchForwarding,
} from "../ingestion/operations";
import { queryLocalConnections } from "../connections/operations";
import { readLocalProfile } from "../identity/operations";
import { recurringDiscoveryIntervalMs } from "../recurring/contract";
import {
  batchOwnersFor,
  hostedOwners,
  localBatchOwners,
  localReviewBinding,
} from "./internal/local-owners";
import { keywordRuleIdFromPath, localKeywordRules } from "../categories/operations";
import {
  canonicalAdmissionUnavailable,
  commitLocalPlan,
  isNativeAccountQuery,
  localCanonicalArguments,
  prepareHostedBatch,
  prepareLocalRead,
  readNativeAccountQuery,
  runLocalBatch,
  runLocalMutation,
} from "../canonical-admission/operations";
import { preserveStoreAlarm } from "../runtime/sqlite/operations";
import { CanonicalAdmissionUnavailable, notFoundRejection } from "../canonical-admission/contract";
import { requestFor } from "./internal/canonical-request";

import { Effect, Option, Schema } from "effect";
import { type CatalogOperation } from "../../src/shell/canonical-catalog/contract";
import { atomicBatchOperation } from "../../src/shell/operations/contract";
import { operationCatalog } from "../../src/shell/api";
import { isHostedVisible } from "../../src/shell/canonical-policy/operations";
import { getCanonicalOperationInput } from "../../src/shell/canonical-operations/operations";

const successfulMutationStatus = 200;

export const isLocalBatchRoute = (id: string): boolean =>
  isNativeAccountQuery(id) ||
  id.startsWith("connections.") ||
  id === atomicBatchOperation ||
  id === "identity.updateUserPreferences" ||
  id === "identity.getCurrentUser" ||
  id === "transactions.updateTransactions" ||
  [
    "memory.remember",
    "memory.revise",
    "memory.forget",
    "memory.recall",
    "insights.getRecurringDigestReport",
    "insights.listPendingInsights",
    "insights.getReminderSchedule",
    "insights.updateReminderSchedule",
    "insights.markInsightDelivered",
    "insights.markInsightRead",
    "insights.dismissInsight",
    "categories.createKeywordRule",
    "categories.updateKeywordRule",
    "categories.deleteKeywordRule",
    "categories.listKeywordRules",
    "ingestion.applyReviewEdit",
    "ingestion.abandonStatementSubmission",
    "ingestion.skipNeedsReviewItem",
    "ingestion.resolveNeedsReviewItem",
  ].includes(id);

type ReadOwner =
  | typeof readLocalMemories
  | typeof readLocalReminder
  | typeof readLocalProfile
  | typeof localKeywordRules;

type ReadEffect = ReturnType<ReadOwner>;

type NativeRead = (
  user: Parameters<ReadOwner>[0]
) => Effect.Effect<
  Effect.Success<ReadEffect>,
  Effect.Error<ReadEffect>,
  Effect.Services<ReadEffect>
>;

const localReads = new Map<string, NativeRead>([
  ["memory.recall", readLocalMemories],
  ["insights.getReminderSchedule", readLocalReminder],
  ["identity.getCurrentUser", readLocalProfile],
  ["categories.listKeywordRules", localKeywordRules],
]);

const reserveForwardingRoute =
  (directory: UserStoreBindings["DIRECTORY"]) =>
  (user: UserId): Effect.Effect<void, CanonicalAdmissionUnavailable, SqliteClient> =>
    reserveBatchForwarding(user, directory).pipe(
      Effect.asVoid,
      Effect.mapError((cause) => new CanonicalAdmissionUnavailable({ cause }))
    );

type LocalBatchRoute = {
  directory: Pick<DurableObjectNamespace, "getByName">;
  operation: CatalogOperation;
  request: Request;
  storage: DurableObjectStorage;
  owns: (id: string) => boolean;
};

const pendingPageResponse = Effect.fn(function* (unit: LocalBatchRoute) {
  let continuation = Option.none<string>();

  const reply = yield* runLocalMutation({
    ...unit,
    input: Effect.succeedSome(true),
    work: (_input, user, current) =>
      readLocalPendingInsights(unit.request, user, current).pipe(
        Effect.map((page) => {
          continuation = page.next;

          return page.result;
        })
      ),
  });

  if (reply.ok && Option.isSome(continuation)) {
    reply.headers.set("link", "<" + continuation.value + '>; rel="next"');
  }

  return reply;
});

const localBatchQuery = Effect.fn(function* (unit: LocalBatchRoute) {
  if (isNativeAccountQuery(unit.operation.id)) {
    return Option.some(
      yield* runLocalMutation({
        ...unit,
        input: Effect.succeedSome(true),
        work: (_input, user, current) => readNativeAccountQuery(unit.operation.id, user, current),
      })
    );
  }

  if (unit.operation.id.startsWith("connections.") && unit.operation.policy.kind === "query") {
    return Option.some(
      yield* runLocalMutation({
        ...unit,
        input: Effect.succeedSome(true),
        work: (_input, user) => queryLocalConnections(unit.operation.id, unit.request, user),
      })
    );
  }

  if (unit.operation.id === "insights.getRecurringDigestReport") {
    const id = Schema.decodeUnknownOption(InsightEventId)(
      new URL(unit.request.url).pathname.split("/").at(-1)
    );

    return Option.some(
      yield* runLocalMutation({
        ...unit,
        input: Effect.succeed(id),
        work: (target, user) => readLocalDigestReport({ id: target, userId: user }),
      })
    );
  }

  if (unit.operation.id === "insights.listPendingInsights") {
    return Option.some(yield* pendingPageResponse(unit));
  }

  const read = localReads.get(unit.operation.id);

  if (read === undefined) return Option.none<Response>();

  return Option.some(
    yield* runLocalMutation({
      ...unit,
      input: Effect.succeedSome(true),
      work: (_input, user) => read(user),
    })
  );
});

export const dispatchLocalBatchRoute = Effect.fn(
  function* (unit: LocalBatchRoute) {
    if (unit.operation.id === atomicBatchOperation) {
      return yield* runLocalBatch(
        {
          ...unit,
          reserveChildRoute: reserveForwardingRoute(unit.directory),
        },
        batchOwnersFor(unit)
      );
    }

    const query = yield* localBatchQuery(unit);

    if (Option.isSome(query)) return query.value;
    const prepare = localBatchOwners.get(unit.operation.id);

    if (prepare === undefined) return canonicalAdmissionUnavailable();

    return yield* runLocalMutation(
      {
        ...unit,
        input: localCanonicalArguments(unit.request, unit.operation),
        work: (input, user, current) =>
          prepare(input, { user, current, storage: unit.storage }).pipe(
            Effect.flatMap(commitLocalPlan),
            Effect.tap((result) =>
              unit.operation.id === "transactions.updateTransactions" &&
              result.status === successfulMutationStatus
                ? preserveStoreAlarm(unit.storage, current + recurringDiscoveryIntervalMs)
                : Effect.void
            )
          ),
      },
      (unit.operation.id === "categories.updateKeywordRule" ||
        unit.operation.id === "categories.deleteKeywordRule") &&
        Option.isNone(keywordRuleIdFromPath(unit.request))
        ? Option.some(notFoundRejection("No keyword rule with that id belongs to you."))
        : Option.none()
    );
  },
  Effect.tapCause(() =>
    Effect.logWarning({
      component: "canonical-operations",
      operation: "localOwner",
      outcome: "unavailable",
    })
  ),
  Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
);

export const localOAuthReviewBinding: typeof localReviewBinding = (...args) =>
  localReviewBinding(...args);

const defaultReviewPageSize = 50;

const parameterizedReads = [
  "categories.listCategories",
  "quota.getQuota",
  "connections.listInstitutions",
  "connections.listConnections",
  "connections.getConnection",
  "connections.listAccounts",
  "insights.listPendingInsights",
  "transactions.listTransactions",
  "transactions.searchTransactions",
  "transactions.getTransaction",
  "ingestion.getStatementSubmission",
  "ingestion.listNeedsReviewItems",
];

export const nativeCanonicalOperations = (): ReadonlyArray<CatalogOperation> =>
  operationCatalog.operations.filter(
    (operation) =>
      operation.id === atomicBatchOperation ||
      hostedOwners.has(operation.id) ||
      localBatchOwners.has(operation.id) ||
      localReads.has(operation.id) ||
      parameterizedReads.includes(operation.id)
  );

export const localHostedCatalog = (
  authorityRoot: CanonicalAuthorityRoot
): ReadonlyArray<CatalogOperation> =>
  nativeCanonicalOperations().filter((operation) =>
    isHostedVisible(operation.policy.access, authorityRoot)
  );

const readParameter = Effect.fn(function* (
  operation: CatalogOperation,
  input: Schema.Json,
  context: Parameters<NonNullable<ReturnType<typeof localBatchOwners.get>>>[1]
) {
  const request = requestFor({ operation, input });

  if (Option.isNone(request)) {
    return yield* new CanonicalAdmissionUnavailable({ cause: "invalid_route" });
  }

  if (operation.id.startsWith("connections.")) {
    return yield* queryLocalConnections(operation.id, request.value, context.user);
  }

  if (["transactions.listTransactions", "transactions.searchTransactions"].includes(operation.id)) {
    return yield* readLocalTransactionPage(request.value, context.user);
  }

  if (operation.id === "insights.listPendingInsights") {
    return (yield* readLocalPendingInsights(request.value, context.user, context.current)).result;
  }

  const url = new URL(request.value.url);

  if (operation.id === "ingestion.listNeedsReviewItems") {
    const args = yield* Schema.decodeEffect(
      getCanonicalOperationInput("ingestion.listNeedsReviewItems")
    )(input);

    return yield* readLocalReviewPage(
      {
        ...context,
        status: args.query.status,
        limit: Option.getOrElse(args.query.limit, () => defaultReviewPageSize),
        offset: Option.getOrElse(args.query.offset, () => 0),
      },
      context.user,
      context.current
    );
  }

  const id = url.pathname.split("/").at(-1);

  if (id === undefined) return yield* new CanonicalAdmissionUnavailable({ cause: "missing_id" });

  return operation.id === "transactions.getTransaction"
    ? yield* readAddressedLocalTransaction(id, context.user)
    : yield* readLocalSubmission(
        context.user,
        id,
        Option.map(Option.fromUndefinedOr(context.hostedTurn), (turn) => ({
          turn,
          current: context.current,
        }))
      );
});

export const prepareHostedBatchOwner = Effect.fnUntraced(function* (
  input: Schema.Json,
  context: Parameters<typeof prepareHostedBatch>[1]
) {
  return yield* prepareHostedBatch(input, context, localBatchOwners);
});

export const prepareHostedOwner = Effect.fn(function* (
  operation: CatalogOperation,
  input: Schema.Json,
  context: Parameters<NonNullable<ReturnType<typeof localBatchOwners.get>>>[1]
) {
  if (parameterizedReads.includes(operation.id)) {
    return Option.some(
      prepareLocalRead({
        targets: [],
        commit: Effect.gen(function* () {
          if (isNativeAccountQuery(operation.id)) {
            return yield* readNativeAccountQuery(operation.id, context.user, context.current);
          }

          return yield* readParameter(operation, input, context);
        }),
      })
    );
  }

  const read = localReads.get(operation.id);

  if (read !== undefined) {
    return Option.some(
      prepareLocalRead({
        targets: [],
        commit: read(context.user),
      })
    );
  }

  const owner = hostedOwners.get(operation.id) ?? localBatchOwners.get(operation.id);

  if (owner === undefined) return Option.none();

  return Option.some(yield* owner(input, context));
});
