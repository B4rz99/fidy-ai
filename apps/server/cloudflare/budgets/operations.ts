import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { detectLocalThresholds } from "./internal/native-thresholds";
import { CanonicalAdmissionUnavailable } from "../canonical-admission/contract";
import { preserveStoreAlarm } from "../runtime/sqlite/operations";
import { queryLocalBudget } from "./internal/sqlite-workspace";
import {
  dispatchLocalBudget as dispatchBudget,
  isLocalBudgetOperation as localBudget,
} from "./internal/sqlite-dispatch";
import {
  budgetUnavailable,
  plannedBudgets,
  prepareLocalBudget as prepareBudget,
  prepareLocalBudgetDeletion as prepareDeletionInStore,
} from "./internal/sqlite-planning";
import { BudgetMonth } from "../../src/core/budgets/contract";
import { DateTime, Effect, Option, Schema } from "effect";
import { type UserId } from "../../src/core/identity/contract";

export const dispatchLocalBudget: typeof dispatchBudget = (unit) => dispatchBudget(unit);

export const isLocalBudgetOperation: typeof localBudget = (id) => localBudget(id);

export const readLocalBudgetCaps = Effect.fn(function* (userId: UserId, month: string) {
  if (!Schema.is(BudgetMonth)(month)) return yield* budgetUnavailable();

  return (yield* plannedBudgets(userId, Option.some(month), Option.none())).budgets;
});

export const prepareLocalBudget: typeof prepareBudget = (save, user, current) =>
  prepareBudget(save, user, current);

export const prepareLocalBudgetDeletion: typeof prepareDeletionInStore = (id, user) =>
  prepareDeletionInStore(id, user);

export const readLocalBudget: typeof queryLocalBudget = (...args) => queryLocalBudget(...args);

export const retainLocalBudgetThresholds = Effect.fn(
  function* (user: UserId, current: number, storage: DurableObjectStorage) {
    const thresholds = yield* detectLocalThresholds(user, DateTime.makeUnsafe(current));
    const sql = yield* SqliteClient;

    const pendingOffer =
      yield* sql`SELECT 1 FROM category_opportunities WHERE user_id=${user} AND kind='budget-threshold' AND next_ms<=${current}`;

    if (thresholds || pendingOffer.length > 0) {
      yield* preserveStoreAlarm(storage, current);
    }
  },
  Effect.mapError((cause) => new CanonicalAdmissionUnavailable({ cause }))
);
