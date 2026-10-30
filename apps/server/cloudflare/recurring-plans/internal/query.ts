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

import { readPrivacyPreferences } from "../../identity/operations";
import { readPlanningTransactions } from "../../transactions/operations";

import { linkedTransactions, planningFact } from "./facts";
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
  db,
  userId,
  document,
}: Readonly<{ db: D1Database; userId: string; document: RecurringDocument }>): Effect.Effect<
  Readonly<{ document: RecurringDocument; invalid: ReadonlyArray<string> }>,
  RecurringPlanningUnavailable
> =>
  Effect.gen(function* () {
    const transactions = yield* linkedTransactions({ db, userId, document });
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
  });
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
    const start = DateTime.makeUnsafe(`${month}-01`);
    const selection = yield* readPlanningTransactions({
      db,
      userId,
      selection: {
        kind: "range",
        from: DateTime.formatIso(DateTime.subtract(start, { days: 4 })),
        through: DateTime.formatIso(DateTime.add(start, { months: 1, days: 4 })),
      },
    });
    if (Option.isNone(selection) || !selection.value.complete) {
      return { document, complete: false, matches: [] };
    }
    const facts = selection.value.transactions;
    const nextMonth = DateTime.formatIsoDateUtc(DateTime.add(start, { months: 1 })).slice(
      0,
      monthLength
    );
    const items = [previousMonth(month), month, nextMonth].flatMap((selected) =>
      projectRecurringMonth({ document, month: selected, now })
    );
    const matches = automaticMatches({ document, items, transactions: facts });
    return matchedProjection(document, matches);
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
    const preferences = yield* readPrivacyPreferences({ db, userId }).pipe(
      Effect.mapError(() => new RecurringPlanningUnavailable())
    );
    const checked = yield* checkedDocument({ db, userId, document });
    const prior = query.previousMonth ?? previousMonth(query.month);
    const earlier = yield* automaticProjection({
      db,
      userId,
      document: checked.document,
      month: prior,
      now,
    });
    const previous = filterRecurring({
      items: projectRecurringMonth({ document: earlier.document, month: prior, now }),
      filters: query,
    }).filter((item) => item.status !== "completed" && item.status !== "skipped");
    const earliest = earliestMonth(document, query.month);
    const matched = yield* automaticProjection({
      db,
      userId,
      document: checked.document,
      month: query.month,
      now,
    });
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
      invalidFulfillmentIds: checked.invalid,
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
