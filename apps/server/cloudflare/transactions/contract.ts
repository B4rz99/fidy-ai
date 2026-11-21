import type { IanaTimeZone } from "../../src/core/_shared/context";
import {
  type EffectiveTransactionAggregate,
  type RecurringTransactionFact,
  type Transaction,
} from "../../src/core/transactions/contract";
import { Data, type DateTime, type Option } from "effect";
import { type Category, type CategoryId } from "../../src/core/categories/contract";

export class TransactionAggregatesUnavailable extends Data.TaggedError(
  "TransactionAggregatesUnavailable"
) {}

export class RecurringFactsUnavailable extends Data.TaggedError("RecurringFactsUnavailable") {}

export type PlanningTransactionRange = Readonly<{ from: string; through: string }>;

export type PlanningTransactionFacts = Readonly<{
  transactions: ReadonlyArray<Transaction>;
  complete: boolean;
}>;

export type PlanningTransactionSnapshot<A> = Readonly<{
  snapshot: A;
  ranges: ReadonlyArray<Option.Option<PlanningTransactionFacts>>;
  selected: ReadonlyArray<Transaction>;
}>;

export type RecurringFactSnapshot = Readonly<{
  revision: number;
  firstCapturedAt: DateTime.Utc;
  timeZone: IanaTimeZone;
}>;

export type RecurringFactPage = Readonly<{
  facts: ReadonlyArray<RecurringTransactionFact>;
  cursor: BudgetContributionCursor;
  complete: boolean;
}>;

export type BudgetContributionCursor = Readonly<{
  occurredAt: string;
  transactionId: string;
}>;

export type DashboardTransactionFact = Readonly<{ transaction: Transaction; category: Category }>;

export type DashboardTransactionList = Readonly<{
  categories: ReadonlyArray<CategoryId>;
  search: Option.Option<string>;
  limit: number;
}>;

export type DashboardTransactionSnapshot<A> = Readonly<{
  snapshot: A;
  lists: ReadonlyArray<ReadonlyArray<DashboardTransactionFact>>;
  ranges: ReadonlyArray<ReadonlyArray<EffectiveTransactionAggregate>>;
}>;
