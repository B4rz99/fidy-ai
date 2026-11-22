import {
  canonicalAdmissionUnavailable,
  commitLocalWrite,
  prepareLocalWrite,
  runLocalMutation,
} from "../../canonical-admission/operations";
import { localWorkspaceProjection } from "./read-projection";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { DateTime, Effect, Option, Schema } from "effect";
import { listLaunchCategories } from "../../../src/core/categories/operations";
import { type UserId, UserPreferences } from "../../../src/core/identity/contract";
import {
  type RecurringCommand,
  RecurringDocument,
} from "../../../src/core/recurring-plans/contract";
import { applyRecurringEdit } from "../../../src/core/recurring-plans/operations";
import type { CatalogOperation } from "../../../src/shell/canonical-catalog/contract";
import {
  ApplyRecurringCanonicalInput,
  RecurringWorkspace,
  RecurringWorkspaceQuery,
} from "../../../src/shell/recurring-plans/contract";
import {
  type CanonicalRejection,
  type LocalMutationResult,
  validationRejection,
} from "../../canonical-admission/contract";

import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";
import { ownsLocalRecurringSeries } from "../../recurring/operations";
import {
  readLocalPlanningMonths,
  readLocalPlanningRange,
  readLocalPlanningReferences,
} from "../../transactions/operations";
import { displayDocument } from "./display";
import { linkedTransactionIds } from "./facts";
import { validLinkedFulfillment, validPlanCategories } from "./mutation";
import {
  automaticFromFacts,
  matchingRange,
  previousMonth,
  workspaceFromReadProjection,
} from "./query";
import { retainCompletions } from "./snapshot";
import { readLocalDocument, writeLocalDocument } from "./store";

const operations = Schema.Literals([
  "recurringPlans.applyRecurringEdit",
  "recurringPlans.getRecurringWorkspace",
]);

export const isLocalRecurringPlan = Schema.is(operations);

const success = (data: Schema.Json): LocalMutationResult => ({
  status: 200,
  outcome: "success",
  body: { data, next: [] },
});

const invalid = (): CanonicalRejection =>
  validationRejection("Revisa los datos y actualiza los recurrentes antes de guardar.");

const categories = listLaunchCategories().map((entry) => entry.id);

const validReferences = Effect.fn(function* (
  user: UserId,
  command: RecurringCommand,
  document: RecurringDocument
) {
  if (!validPlanCategories({ document, categories })) return false;
  const { edit } = command;

  if ((edit.kind === "create" || edit.kind === "suggestion") && edit.seriesId !== undefined) {
    return yield* ownsLocalRecurringSeries(user, edit.seriesId);
  }

  if (edit.kind === "fulfill" && edit.fulfillment.transactionId !== undefined) {
    const [transaction] = yield* readLocalPlanningReferences(user, [
      edit.fulfillment.transactionId,
    ]);

    return validLinkedFulfillment({
      document,
      mark: edit.fulfillment,
      transaction: Option.fromUndefinedOr(transaction),
    });
  }

  return true;
});

export const prepareLocalRecurringEdit = Effect.fn(function* (
  command: typeof ApplyRecurringCanonicalInput.Type.payload,
  user: UserId,
  current: number
) {
  const now = DateTime.makeUnsafe(current);
  const base = yield* readLocalDocument(user);
  const edit = command.edit;

  if (
    edit.kind === "reverse" &&
    !base.fulfillments.some((mark) => mark.id === edit.fulfillmentId) &&
    (yield* readLocalPlanningReferences(user, [edit.fulfillmentId])).length === 0
  ) {
    return yield* invalid();
  }

  const retained = yield* retainCompletions({
    document: base,
    command,
    now,
    months: (from, through) => readLocalPlanningMonths(user, from, through),
    project: (document, month, now) =>
      readLocalPlanningRange(user, matchingRange(month)).pipe(
        Effect.map((facts) =>
          automaticFromFacts({
            document,
            allocations: document,
            month,
            now,
            selection: Option.some(facts),
          })
        )
      ),
  });

  const next = yield* applyRecurringEdit({ document: retained, command }).pipe(Effect.option);

  if (Option.isNone(next) || !(yield* validReferences(user, command, next.value))) {
    return yield* invalid();
  }

  return prepareLocalWrite({
    targets: ["recurring-document"],
    review: Effect.succeed({
      revision: String(base.revision),
      effect:
        "Actualizar el seguimiento recurrente según la decisión explícita siguiente. No mueve dinero ni cancela servicios.",
    }),
    commit: Effect.gen(function* () {
      yield* writeLocalDocument(user, base, next.value);

      return success(
        yield* Schema.encodeEffect(Schema.toCodecJson(RecurringDocument))(
          displayDocument({ document: next.value, compact: command.view === "compact", now })
        )
      );
    }),
  });
});

export const editLocalRecurringPlan = Effect.fnUntraced(function* (
  input: typeof ApplyRecurringCanonicalInput.Type.payload,
  user: UserId,
  current: number
) {
  return yield* prepareLocalRecurringEdit(input, user, current).pipe(
    Effect.flatMap(commitLocalWrite)
  );
});

export const workspace = Effect.fn(function* (
  query: typeof RecurringWorkspaceQuery.Type,
  user: UserId,
  current: number
) {
  if (query.previousMonth !== undefined && query.previousMonth >= query.month) {
    return yield* invalid();
  }

  const sql = yield* SqliteClient;
  const now = DateTime.makeUnsafe(current);
  const projection = yield* localWorkspaceProjection(user, query, now);
  const document = projection.schedule;
  const [context] = yield* sql`SELECT locale,time_zone AS timeZone FROM users WHERE id=${user}`;
  const snapshot = yield* Schema.decodeUnknownEffect(UserPreferences)(context);

  const ranges =
    document.plans.length === 0
      ? []
      : yield* Effect.forEach(
          [query.previousMonth ?? previousMonth(query.month), query.month],
          (month) => readLocalPlanningRange(user, matchingRange(month)).pipe(Effect.asSome)
        );

  const selected = yield* readLocalPlanningReferences(user, linkedTransactionIds(document));

  const result = yield* workspaceFromReadProjection({
    projection,
    query,
    now,
    observed: { ranges, selected, snapshot },
  });

  return success(yield* Schema.encodeEffect(Schema.toCodecJson(RecurringWorkspace))(result));
});

const bodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 16384,
  deadlineMilliseconds: 2000,
});

export const dispatchLocalRecurringPlans = Effect.fn(
  function* (unit: {
    request: Request;
    storage: DurableObjectStorage;
    owns: (user: string) => boolean;
    operation: CatalogOperation;
  }) {
    if (unit.operation.id === "recurringPlans.applyRecurringEdit") {
      const input = boundedJsonBody({
        request: unit.request,
        policy: bodyPolicy,
        schema: Schema.toCodecJson(ApplyRecurringCanonicalInput.fields.payload),
      });

      return yield* runLocalMutation({ ...unit, input, work: editLocalRecurringPlan });
    }

    const query = Schema.decodeUnknownOption(RecurringWorkspaceQuery)(
      Object.fromEntries(new URL(unit.request.url).searchParams)
    );

    return yield* runLocalMutation({ ...unit, input: Effect.succeed(query), work: workspace });
  },
  Effect.tapCause(Effect.logDebug),
  Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
);
