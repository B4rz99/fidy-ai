import { DateTime, Effect, Option, Schema } from "effect";
import {
  RecurringWorkspace,
  type RecurringWorkspaceQuery,
} from "../../../src/shell/recurring-plans/contract";
import {
  type RecurringDocument,
  type RecurringSchedule,
} from "../../../src/core/recurring-plans/contract";
import {
  filterRecurring,
  planAt,
  projectRecurringMonth,
  recurringMatchCandidates,
  summarizeRecurring,
  uniqueRecurringMatches,
  validRecurringFulfillment,
} from "../../../src/core/recurring-plans/operations";

import { type UserPreferences } from "../../../src/core/identity/contract";
import type {
  PlanningTransactionFacts,
  PlanningTransactionRange,
  PlanningTransactionSnapshot,
} from "../../transactions/contract";

import { planningFact } from "./facts";
import { RecurringPlanningUnavailable, type RecurringReadProjection } from "../contract";
import { workspaceMonths } from "./read-projection";
import { type Transaction } from "../../../src/core/transactions/contract";

type Query = typeof RecurringWorkspaceQuery.Type;

const monthLength = 7;

export const previousMonth = (month: string): string =>
  DateTime.formatIsoDateUtc(
    DateTime.subtract(DateTime.makeUnsafe(`${month}-01`), { months: 1 })
  ).slice(0, monthLength);

type CheckedSchedule = Readonly<{
  document: RecurringSchedule;
  invalid: ReadonlyArray<string>;
}>;

const checkedDocument = ({
  document,
  transactions,
}: Readonly<{
  document: RecurringSchedule;
  transactions: ReadonlyArray<Transaction>;
}>): CheckedSchedule => {
  const invalid = document.fulfillments
    .filter((mark) => {
      if (mark.transactionId === undefined) return false;
      const transaction = transactions.find((entry) => entry.id === mark.transactionId);
      const plan = document.plans.find((entry) => entry.id === mark.planId);

      if (transaction === undefined || plan === undefined) return true;
      const settings = retainedOccurrencePlan(document, plan, mark.date);

      return !validRecurringFulfillment({
        mark,
        fact: planningFact({ transaction, timeZone: settings.timeZone }),
        plan: settings,
      });
    })
    .map((mark) => mark.id);

  return {
    document: {
      ...document,
      fulfillments: document.fulfillments.filter((mark) => !invalid.includes(mark.id)),
    },
    invalid,
  };
};

export type AutomaticProjection = Readonly<{
  document: RecurringSchedule;
  matches: (typeof RecurringWorkspace.Type)["matches"];
}> &
  (Readonly<{ complete: false }> | Readonly<{ complete: true; unambiguous: boolean }>);

export const matchingRange = (month: string): PlanningTransactionRange => {
  const start = DateTime.makeUnsafe(`${month}-01`);

  return {
    from: DateTime.formatIso(DateTime.subtract(start, { days: 4 })),
    through: DateTime.formatIso(DateTime.add(start, { months: 1, days: 4 })),
  };
};

export const automaticFromFacts = ({
  document,
  allocations,
  month,
  now,
  selection,
}: Readonly<{
  document: RecurringSchedule;
  month: string;
  now: DateTime.Utc;
  selection: Option.Option<PlanningTransactionFacts>;
  allocations: RecurringSchedule;
}>): AutomaticProjection => {
  if (document.plans.length === 0) {
    return { document, complete: true, unambiguous: true, matches: [] };
  }

  if (Option.isNone(selection) || !selection.value.complete) {
    return { document, complete: false, matches: [] };
  }

  const start = DateTime.makeUnsafe(`${month}-01`);

  const nextMonth = DateTime.formatIsoDateUtc(DateTime.add(start, { months: 1 })).slice(
    0,
    monthLength
  );

  const items = [previousMonth(month), month, nextMonth].flatMap((selected) =>
    projectRecurringMonth({ document, month: selected, now })
  );

  const candidates = matchCandidates({
    document: allocations,
    items,
    transactions: selection.value.transactions,
  });

  const matches = uniqueRecurringMatches(candidates);

  return matchedProjection(document, matches, matches.length === candidates.length);
};

const matchCandidates = ({
  document,
  items,
  transactions,
}: Readonly<{
  document: RecurringSchedule;
  items: Parameters<typeof recurringMatchCandidates>[0]["items"];
  transactions: ReadonlyArray<Transaction>;
}>): ReturnType<typeof recurringMatchCandidates> => {
  const factsByTimeZone = new Map<string, ReadonlyArray<ReturnType<typeof planningFact>>>();

  const allocatedOccurrences = new Set(
    document.fulfillments.map((mark) => `${mark.planId}:${mark.date}`)
  );

  const pairs = items
    .filter((item) => !allocatedOccurrences.has(`${item.planId}:${item.date}`))
    .flatMap((item) => {
      const timeZone = item.plan.timeZone;
      let facts = factsByTimeZone.get(timeZone);

      if (facts === undefined) {
        facts = transactions.map((transaction) => planningFact({ transaction, timeZone }));
        factsByTimeZone.set(timeZone, facts);
      }

      return recurringMatchCandidates({ document, items: [item], facts });
    });

  return pairs;
};

export const automaticMatches = (
  input: Parameters<typeof matchCandidates>[0]
): ReturnType<typeof uniqueRecurringMatches> => uniqueRecurringMatches(matchCandidates(input));

type ObservedProjection = Readonly<{
  preferences: UserPreferences;
  transactions: ReadonlyArray<Transaction>;
  invalid: ReadonlyArray<string>;
  earlier: AutomaticProjection;
  matched: AutomaticProjection;
}>;

const projectWorkspaceSnapshot = ({
  document,
  query,
  now,
  observed,
}: Readonly<{
  document: RecurringSchedule;
  query: Query;
  now: DateTime.Utc;
  observed: PlanningTransactionSnapshot<UserPreferences>;
}>): ObservedProjection => {
  const checked = checkedDocument({ document, transactions: observed.selected });

  const projection = (selected: string, index: number): AutomaticProjection =>
    automaticFromFacts({
      document: checked.document,
      allocations: document,
      month: selected,
      now,
      selection: observed.ranges[index] ?? Option.none(),
    });

  return {
    preferences: observed.snapshot,
    transactions: [
      ...observed.selected,
      ...observed.ranges.flatMap((range) => (Option.isSome(range) ? range.value.transactions : [])),
    ],
    invalid: checked.invalid,
    earlier: projection(query.previousMonth ?? previousMonth(query.month), 0),
    matched: projection(query.month, 1),
  };
};

export const workspaceFromReadProjection = ({
  projection,
  ...input
}: Readonly<{
  projection: RecurringReadProjection;
  query: Query;
  now: DateTime.Utc;
  observed: PlanningTransactionSnapshot<UserPreferences>;
}>): Effect.Effect<
  typeof RecurringWorkspace.Type,
  Schema.SchemaError | RecurringPlanningUnavailable
> =>
  workspaceMonths(input.query).every((month) => projection.months.includes(month))
    ? workspaceFromFacts({ ...input, document: projection.schedule, editing: projection.editing })
    : Effect.fail(new RecurringPlanningUnavailable({ cause: Option.none() }));

const workspaceFromFacts = ({
  document,
  editing,
  query,
  now,
  observed,
}: Readonly<{
  document: RecurringSchedule;
  editing: RecurringDocument;
  query: Query;
  now: DateTime.Utc;
  observed: PlanningTransactionSnapshot<UserPreferences>;
}>): Effect.Effect<typeof RecurringWorkspace.Type, Schema.SchemaError> =>
  Effect.gen(function* () {
    const prior = query.previousMonth ?? previousMonth(query.month);

    const { preferences, transactions, earlier, matched, invalid } = projectWorkspaceSnapshot({
      document,
      query,
      now,
      observed,
    });

    const previous = filterRecurring({
      items: projectRecurringMonth({ document: earlier.document, month: prior, now }),
      filters: query,
    }).filter((item) => item.status !== "completed" && item.status !== "skipped");

    const earliest = earliestMonth(document, query.month);

    const items = filterRecurring({
      items: projectRecurringMonth({ document: matched.document, month: query.month, now }),
      filters: query,
    });

    const workspace = {
      document: editing,
      month: query.month,
      today: DateTime.formatIsoDate(
        DateTime.makeZonedUnsafe(now, { timeZone: preferences.timeZone })
      ),
      occurrences: items,
      previous,
      summary: summarizeRecurring(items),
      linkedTransactions: transactionSummaries({
        transactions,
        marks: [...items, ...previous].flatMap((item) => item.fulfillments),
        invalid: document.fulfillments.filter((mark) => invalid.includes(mark.id)),
      }),
      invalidFulfillmentIds: invalid,
      matches: matched.matches.filter(({ item }) => item.expectedDate.startsWith(query.month)),
      matchesComplete:
        matched.complete && earlier.complete && matched.unambiguous && earlier.unambiguous,
    };

    return yield* Schema.decodeEffect(Schema.toType(RecurringWorkspace))(
      prior > earliest ? { ...workspace, previousMonth: previousMonth(prior) } : workspace
    );
  });

const matchedProjection = (
  document: RecurringSchedule,
  matches: AutomaticProjection["matches"],
  unambiguous: boolean
): AutomaticProjection => ({
  complete: true,
  unambiguous,
  matches,
  document: {
    ...document,
    fulfillments: [
      ...document.fulfillments,
      ...matches.map(({ item, fact }) => ({
        id: fact.id,
        planId: item.planId,
        date: item.date,
        actualDate: fact.date,
        money: fact.money,
        transactionId: fact.id,
        settled: true,
        automatic: true,
      })),
    ],
  },
});

const earliestMonth = (document: RecurringSchedule, month: string): string =>
  document.plans
    .reduce(
      (first, plan) => (plan.revisions[0].from < first ? plan.revisions[0].from : first),
      `${month}-01`
    )
    .slice(0, monthLength);

const retainedOccurrencePlan = (
  document: RecurringSchedule,
  plan: RecurringSchedule["plans"][number],
  date: string
): RecurringSchedule["plans"][number]["revisions"][number]["plan"] =>
  document.exceptions.find((entry) => entry.planId === plan.id && entry.date === date)
    ?.replacement ?? planAt({ plan, date });

const transactionSummaries = ({
  transactions,
  marks,
  invalid,
}: Readonly<{
  transactions: ReadonlyArray<Transaction>;
  marks: RecurringSchedule["fulfillments"];
  invalid: RecurringSchedule["fulfillments"];
}>): (typeof RecurringWorkspace.Type)["linkedTransactions"] => {
  const ids = new Set([...marks, ...invalid].map((mark) => mark.transactionId));

  return [
    ...new Map(transactions.map((transaction) => [transaction.id, transaction])).values(),
  ].flatMap(({ id, money, counterparty, direction, categoryId, notes, occurredAt }) =>
    ids.has(id) ? [{ id, money, counterparty, direction, categoryId, notes, occurredAt }] : []
  );
};
