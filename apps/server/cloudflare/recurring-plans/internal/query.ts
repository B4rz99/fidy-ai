import { DateTime, Effect, Option, Schema } from "effect";
import {
  RecurringWorkspace,
  type RecurringWorkspaceQuery,
} from "../../../src/shell/recurring-plans/contract";
import { type RecurringDocument } from "../../../src/core/recurring-plans/contract";
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
} from "../../transactions/contract";

import { linkedTransactionIds, planningFact } from "./facts";
import { RecurringPlanningUnavailable } from "../contract";
import { displayDocument } from "./display";
import { type Transaction } from "../../../src/core/transactions/contract";

type Query = typeof RecurringWorkspaceQuery.Type;
const monthLength = 7;
const previousMonth = (month: string): string =>
  DateTime.formatIsoDateUtc(
    DateTime.subtract(DateTime.makeUnsafe(`${month}-01`), { months: 1 })
  ).slice(0, monthLength);
const checkedDocument = ({
  document,
  transactions,
}: Readonly<{ document: RecurringDocument; transactions: ReadonlyArray<Transaction> }>): Readonly<{
  document: RecurringDocument;
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
}>;
type AutomaticProjection = Readonly<{
  document: RecurringDocument;
  complete: boolean;
  matches: (typeof RecurringWorkspace.Type)["matches"];
}>;
const matchingRange = (month: string): PlanningTransactionRange => {
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
  document: RecurringDocument;
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
  now,
}: ProjectionWork & Readonly<{ prior: string }>): Effect.Effect<
  Readonly<{
    preferences: UserPreferences;
    invalid: ReadonlyArray<string>;
    earlier: AutomaticProjection;
    matched: AutomaticProjection;
  }>,
  RecurringPlanningUnavailable | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const owner = yield* Schema.decodeEffect(UserId)(userId);
    const observed = yield* readPlanningTransactionSnapshot({
      db,
      userId,
      ranges: document.plans.length === 0 ? [] : [matchingRange(prior), matchingRange(month)],
      ids: linkedTransactionIds(document),
      snapshot: {
        statement: prepareUserContext({
          db,
          userId: owner,
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
    const checked = checkedDocument({ document, transactions: observed.value.selected });
    const projection = (selected: string, index: number): AutomaticProjection =>
      automaticFromFacts({
        document: checked.document,
        month: selected,
        now,
        selection: observed.value.ranges[index] ?? Option.none(),
      });
    return {
      preferences: observed.value.snapshot,
      invalid: checked.invalid,
      earlier: projection(prior, 0),
      matched: projection(month, 1),
    };
  });

/** Reuse date conversion only within this projection; never retain live facts between reads. */
export const automaticMatches = ({
  document,
  items,
  transactions,
}: Readonly<{
  document: RecurringDocument;
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
}>;
export const workspaceValue = ({
  db,
  userId,
  document,
  query,
}: WorkspaceWork): Effect.Effect<
  typeof RecurringWorkspace.Type,
  RecurringPlanningUnavailable | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const prior = query.previousMonth ?? previousMonth(query.month);
    const { preferences, earlier, matched, invalid } = yield* workspaceMatching({
      db,
      userId,
      document,
      month: query.month,
      prior,
      now,
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
      document: displayDocument({ document, compact: query.view === "compact" }),
      month: query.month,
      today: DateTime.formatIsoDate(
        DateTime.makeZonedUnsafe(now, { timeZone: preferences.timeZone })
      ),
      occurrences: items,
      previous,
      ...(prior > earliest ? { previousMonth: previousMonth(prior) } : {}),
      summary: summarizeRecurring(items),
      invalidFulfillmentIds: invalid,
      matches: matched.matches.filter(({ item }) => item.expectedDate.startsWith(query.month)),
      matchesComplete: matched.complete && earlier.complete,
    });
  });

const matchedProjection = (
  document: RecurringDocument,
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

const earliestMonth = (document: RecurringDocument, month: string): string =>
  document.plans
    .reduce(
      (first, plan) => (plan.revisions[0].from < first ? plan.revisions[0].from : first),
      `${month}-01`
    )
    .slice(0, monthLength);

const retainedOccurrencePlan = (
  document: RecurringDocument,
  plan: RecurringDocument["plans"][number],
  date: string
): RecurringDocument["plans"][number]["revisions"][number]["plan"] =>
  document.exceptions.find((entry) => entry.planId === plan.id && entry.date === date)
    ?.replacement ?? planAt({ plan, date });
