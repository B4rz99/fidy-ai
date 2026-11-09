import type { CanonicalReadFinalization } from "../../canonical-admission/contract";
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

import { UserId, UserPreferences } from "../../../src/core/identity/contract";
import { prepareUserContext } from "../../identity/user-context/operations";
import {
  readPlanningTransactionSnapshot,
  readPlanningTransactions,
} from "../../transactions/operations";
import type {
  PlanningTransactionFacts,
  PlanningTransactionRange,
  PlanningTransactionSnapshot,
} from "../../transactions/contract";

import { linkedTransactionIds, planningFact } from "./facts";
import { RecurringPlanningUnavailable, type RecurringReadProjection } from "../contract";
import { workspaceMonths } from "./read-projection";
import { displayDocument } from "./display";
import { type Transaction } from "../../../src/core/transactions/contract";

type Query = typeof RecurringWorkspaceQuery.Type;
const monthLength = 7;
export const previousMonth = (month: string): string =>
  DateTime.formatIsoDateUtc(
    DateTime.subtract(DateTime.makeUnsafe(`${month}-01`), { months: 1 })
  ).slice(0, monthLength);
const checkedDocument = ({
  document,
  transactions,
}: Readonly<{ document: RecurringSchedule; transactions: ReadonlyArray<Transaction> }>): Readonly<{
  document: RecurringSchedule;
  invalid: ReadonlyArray<string>;
}> => {
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
type ProjectionWork = Readonly<{
  db: D1Database;
  userId: string;
  document: RecurringDocument;
  month: string;
  now: DateTime.Utc;
  finalization: Option.Option<CanonicalReadFinalization>;
}>;
type AutomaticProjection = Readonly<{
  document: RecurringSchedule;
  complete: boolean;
  matches: (typeof RecurringWorkspace.Type)["matches"];
}>;
export const matchingRange = (month: string): PlanningTransactionRange => {
  const start = DateTime.makeUnsafe(`${month}-01`);
  return {
    from: DateTime.formatIso(DateTime.subtract(start, { days: 4 })),
    through: DateTime.formatIso(DateTime.add(start, { months: 1, days: 4 })),
  };
};
const automaticFromFacts = ({
  document,
  month,
  now,
  selection,
}: Readonly<{
  document: RecurringSchedule;
  month: string;
  now: DateTime.Utc;
  selection: Option.Option<PlanningTransactionFacts>;
}>): AutomaticProjection => {
  if (document.plans.length === 0) return { document, complete: true, matches: [] };
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
  return matchedProjection(
    document,
    automaticMatches({ document, items, transactions: selection.value.transactions })
  );
};
export const automaticProjection = ({
  db,
  userId,
  document,
  month,
  now,
}: ProjectionWork): Effect.Effect<AutomaticProjection> =>
  Effect.gen(function* () {
    // No automatic matching candidate can exist without a retained plan.
    if (document.plans.length === 0) return { document, complete: true, matches: [] };
    const selection = yield* readPlanningTransactions({
      db,
      userId,
      selection: {
        kind: "range",
        ...matchingRange(month),
      },
    });
    return automaticFromFacts({ document, month, now, selection });
  });

const workspaceMatching = ({
  db,
  userId,
  document,
  month,
  prior,
  finalization,
}: Omit<ProjectionWork, "now"> & Readonly<{ prior: string }>): Effect.Effect<
  PlanningTransactionSnapshot<UserPreferences>,
  RecurringPlanningUnavailable | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const observed = yield* readPlanningTransactionSnapshot({
      finalization,
      db,
      userId,
      ranges: document.plans.length === 0 ? [] : [matchingRange(prior), matchingRange(month)],
      ids: linkedTransactionIds(document),
      snapshot: {
        statement: prepareUserContext({
          db,
          userId: yield* Schema.decodeEffect(UserId)(userId),
          statement: {
            sql: "SELECT locale, timeZone FROM identity_user_context",
            params: [],
          },
        }),
        decode: (rows) =>
          rows.length === 1 ? Schema.decodeUnknownOption(UserPreferences)(rows[0]) : Option.none(),
      },
    });
    if (Option.isNone(observed)) return yield* new RecurringPlanningUnavailable();
    return observed.value;
  });

/** Reuse date conversion only within this projection; never retain live facts between reads. */
export const automaticMatches = ({
  document,
  items,
  transactions,
}: Readonly<{
  document: RecurringSchedule;
  items: Parameters<typeof recurringMatchCandidates>[0]["items"];
  transactions: ReadonlyArray<Transaction>;
}>): ReturnType<typeof uniqueRecurringMatches> => {
  const factsByTimeZone = new Map<string, ReadonlyArray<ReturnType<typeof planningFact>>>();
  const pairs = items.flatMap((item) => {
    const timeZone = item.plan.timeZone;
    let facts = factsByTimeZone.get(timeZone);
    if (facts === undefined) {
      facts = transactions.map((transaction) => planningFact({ transaction, timeZone }));
      factsByTimeZone.set(timeZone, facts);
    }
    return recurringMatchCandidates({ document, items: [item], facts });
  });
  return uniqueRecurringMatches(pairs);
};

type WorkspaceWork = Readonly<{
  db: D1Database;
  userId: string;
  document: RecurringDocument;
  query: Query;
  finalization: Option.Option<CanonicalReadFinalization>;
}>;
export const workspaceValue = ({
  db,
  userId,
  document,
  query,
  finalization,
}: WorkspaceWork): Effect.Effect<
  typeof RecurringWorkspace.Type,
  RecurringPlanningUnavailable | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const observed = yield* workspaceMatching({
      db,
      userId,
      document,
      month: query.month,
      prior: query.previousMonth ?? previousMonth(query.month),
      finalization,
    });
    return yield* workspaceFromSnapshot({ document, query, now, observed });
  });

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
}>): Readonly<{
  preferences: UserPreferences;
  transactions: ReadonlyArray<Transaction>;
  invalid: ReadonlyArray<string>;
  earlier: AutomaticProjection;
  matched: AutomaticProjection;
}> => {
  const checked = checkedDocument({ document, transactions: observed.selected });
  const projection = (selected: string, index: number): AutomaticProjection =>
    automaticFromFacts({
      document: checked.document,
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

export const workspaceFromSnapshot = (
  input: Readonly<{
    document: RecurringDocument;
    query: Query;
    now: DateTime.Utc;
    observed: PlanningTransactionSnapshot<UserPreferences>;
  }>
): Effect.Effect<typeof RecurringWorkspace.Type, Schema.SchemaError> =>
  workspaceFromFacts({
    ...input,
    editing: displayDocument({ document: input.document, compact: input.query.view === "compact" }),
  });

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
    : Effect.fail(new RecurringPlanningUnavailable());

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
    return yield* Schema.decodeEffect(Schema.toType(RecurringWorkspace))({
      document: editing,
      month: query.month,
      today: DateTime.formatIsoDate(
        DateTime.makeZonedUnsafe(now, { timeZone: preferences.timeZone })
      ),
      occurrences: items,
      previous,
      ...(prior > earliest ? { previousMonth: previousMonth(prior) } : {}),
      summary: summarizeRecurring(items),
      linkedTransactions: transactionSummaries({
        transactions,
        marks: [...items, ...previous].flatMap((item) => item.fulfillments),
        invalid: document.fulfillments.filter((mark) => invalid.includes(mark.id)),
      }),
      invalidFulfillmentIds: invalid,
      matches: matched.matches.filter(({ item }) => item.expectedDate.startsWith(query.month)),
      matchesComplete: matched.complete && earlier.complete,
    });
  });

const matchedProjection = (
  document: RecurringSchedule,
  matches: AutomaticProjection["matches"]
): AutomaticProjection => ({
  complete: true,
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
  return [...new Map(transactions.map((transaction) => [transaction.id, transaction])).values()]
    .filter((transaction) => ids.has(transaction.id))
    .map(({ id, money, counterparty, direction, categoryId, notes, occurredAt }) => ({
      id,
      money,
      counterparty,
      direction,
      categoryId,
      notes,
      occurredAt,
    }));
};
