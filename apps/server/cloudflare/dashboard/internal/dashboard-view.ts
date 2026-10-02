import { UserId } from "@fidy/server/identity-reference";
import type { EffectiveTransactionAggregate } from "@fidy/server/transactions-contract";
import { type DateTime, Effect, Option, Schema } from "effect";
import { UserContext } from "@fidy/server/identity-contract";
import { prepareUserContext } from "../../identity/user-context/operations";
import { listCategories } from "../../categories/operations";
import { type DashboardDocument, type ProjectedRange } from "../../../src/core/dashboard/contract";
import {
  collectLayoutWidgets,
  dashboardProjectionRanges,
} from "../../../src/core/dashboard/operations";

import type { DashboardFacts } from "../../../src/shell/dashboard/contract";
import { readBudgetCaps } from "../../budgets/operations";
import { findDashboardAggregate, readDashboardTransactions } from "../../transactions/operations";

type LayoutWidgets = ReturnType<typeof collectLayoutWidgets>;
type Groups = DashboardFacts["groups"];

const loadBase = (
  db: D1Database,
  userId: string,
  widgets: LayoutWidgets
): Effect.Effect<Option.Option<Omit<DashboardFacts, "groups">>> =>
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
    const budgets = yield* readBudgetCaps({ db, userId });
    return Option.map(budgets, (owned) => ({
      lists: new Map(listFacts.value),
      budgets: owned,
      categories: new Map(categories.value.map((category) => [category.id, category])),
      context: selected.value.snapshot,
    }));
  }).pipe(Effect.orElseSucceed(() => Option.none()));

const findCached = (
  cache: Map<string, ReadonlyArray<EffectiveTransactionAggregate>>,
  input: Parameters<typeof findDashboardAggregate>[0]
): Effect.Effect<Option.Option<ReadonlyArray<EffectiveTransactionAggregate>>> =>
  Effect.gen(function* () {
    const key = `${input.from}:${input.toExclusive}`;
    const existing = cache.get(key);
    if (existing !== undefined) return Option.some(existing);
    const loaded = yield* findDashboardAggregate(input);
    if (Option.isSome(loaded)) cache.set(key, loaded.value);
    return loaded;
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
    const cached = new Map<string, ReadonlyArray<EffectiveTransactionAggregate>>();
    const groups = new Map<string, ReadonlyArray<ProjectedRange>>();
    for (const widget of widgets) {
      if (widget.type === "transaction-list") continue;
      const buckets = [];
      for (const range of dashboardProjectionRanges(widget, now, context.timeZone)) {
        const loaded = yield* findCached(cached, {
          db,
          userId,
          from: range.from,
          toExclusive: range.toExclusive,
        });
        if (Option.isNone(loaded)) return Option.none<Groups>();
        buckets.push({ key: range.key, contributions: loaded.value });
      }
      groups.set(widget.id, buckets);
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
