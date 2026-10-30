import { UserContext, UserId } from "../../../src/core/identity/contract";
import { type DateTime, Effect, Option, Schema } from "effect";

import { prepareUserContext } from "../../identity/user-context/operations";
import { listCategories } from "../../categories/operations";
import { type DashboardDocument, type ProjectedRange } from "../../../src/core/dashboard/contract";
import {
  collectLayoutWidgets,
  dashboardProjectionRanges,
} from "../../../src/core/dashboard/operations";

import type { DashboardFacts } from "../../../src/shell/dashboard/contract";
import { readBudgetCaps } from "../../budgets/operations";
import {
  findDashboardAggregateRanges,
  readDashboardTransactions,
} from "../../transactions/operations";

type LayoutWidgets = ReturnType<typeof collectLayoutWidgets>;
type Groups = DashboardFacts["groups"];

const loadLists = (
  db: D1Database,
  userId: string,
  widgets: LayoutWidgets
): Effect.Effect<Option.Option<Omit<DashboardFacts, "groups" | "budgets">>> =>
  Effect.gen(function* () {
    const lists = widgets.filter((widget) => widget.type === "transaction-list");
    const categories = yield* Effect.option(listCategories({ db }));
    if (Option.isNone(categories)) return Option.none();
    const selected = yield* readDashboardTransactions({
      db,
      userId,
      lists: lists.map((widget) => ({
        categories: widget.categories ?? [],
        search: Option.fromUndefinedOr(widget.search),
        limit: widget.limit,
      })),
      categories: categories.value,
      snapshot: {
        statement: prepareUserContext({
          db,
          userId: UserId.make(userId),
          statement: {
            sql: "SELECT serviceMarket, locale, timeZone FROM identity_user_context",
            params: [],
          },
        }),
        decode: (rows) => Schema.decodeUnknownOption(UserContext)(rows[0]),
      },
    });
    if (Option.isNone(selected)) return Option.none();
    const listFacts = Option.all(
      lists.map((widget, index) =>
        Option.map(
          Option.fromUndefinedOr(selected.value.lists[index]),
          (rows) => [widget.id, rows] as const
        )
      )
    );
    if (Option.isNone(listFacts)) return Option.none();
    return Option.some({
      lists: new Map(listFacts.value),
      categories: new Map(categories.value.map((category) => [category.id, category])),
      context: selected.value.snapshot,
    });
  }).pipe(Effect.orElseSucceed(() => Option.none()));

const loadBase = (
  db: D1Database,
  userId: string,
  widgets: LayoutWidgets
): Effect.Effect<Option.Option<Omit<DashboardFacts, "groups">>> =>
  Effect.gen(function* () {
    const { lists, budgets } = yield* Effect.all(
      { lists: loadLists(db, userId, widgets), budgets: readBudgetCaps({ db, userId }) },
      { concurrency: 2 }
    );
    if (Option.isNone(lists) || Option.isNone(budgets)) return Option.none();
    return Option.some({ ...lists.value, budgets: budgets.value });
  });

const findRanges = ({
  db,
  userId,
  now,
  context,
  widgets,
}: Readonly<{
  db: D1Database;
  userId: string;
  now: DateTime.Utc;
  context: UserContext;
  widgets: LayoutWidgets;
}>): Effect.Effect<Option.Option<Groups>> =>
  Effect.gen(function* () {
    const plans = widgets
      .filter((widget) => widget.type !== "transaction-list")
      .map((widget) => ({
        id: widget.id,
        ranges: dashboardProjectionRanges(widget, now, context.timeZone),
      }));
    const unique = new Map<string, { from: number; toExclusive: number }>();
    for (const plan of plans) {
      for (const range of plan.ranges) unique.set(`${range.from}:${range.toExclusive}`, range);
    }
    const loaded = yield* findDashboardAggregateRanges({
      db,
      userId,
      ranges: [...unique.values()],
    });
    if (Option.isNone(loaded) || loaded.value.length !== unique.size) return Option.none();
    const facts = new Map([...unique.keys()].map((key, index) => [key, loaded.value[index]]));
    const groups = new Map<string, ReadonlyArray<ProjectedRange>>();
    for (const plan of plans) {
      const buckets: Array<ProjectedRange> = [];
      for (const range of plan.ranges) {
        const contributions = facts.get(`${range.from}:${range.toExclusive}`);
        if (contributions === undefined) return Option.none();
        buckets.push({ key: range.key, contributions });
      }
      groups.set(plan.id, buckets);
    }
    return Option.some(groups);
  });

/** Load bounded list pages and exact write-maintained totals only for a ready User projection. */
export const loadDashboardFacts = ({
  db,
  userId,
  document,
  now,
}: Readonly<{
  db: D1Database;
  userId: string;
  document: DashboardDocument;
  now: DateTime.Utc;
}>): Effect.Effect<Option.Option<DashboardFacts>> =>
  Effect.gen(function* () {
    const widgets = collectLayoutWidgets(document.layout);
    const base = yield* loadBase(db, userId, widgets);
    if (Option.isNone(base)) return Option.none();
    const groups = yield* findRanges({ db, userId, now, context: base.value.context, widgets });
    return Option.map(groups, (loaded) => ({ ...base.value, groups: loaded }));
  }).pipe(Effect.orElseSucceed(() => Option.none()));
