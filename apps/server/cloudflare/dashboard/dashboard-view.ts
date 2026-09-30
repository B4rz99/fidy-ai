import type { EffectiveTransactionAggregate } from "@fidy/server/transactions-runtime";
import { type DateTime, Effect, Option, Schema } from "effect";
import { prepareUserContext } from "../identity/operations";
import { Category } from "../../src/core/categories/contract";
import { type DashboardDocument, collectLayoutWidgets } from "../../src/core/dashboard/model";
import { dashboardProjectionRanges } from "../../src/core/dashboard/projection";
import type { DashboardFacts } from "../../src/shell/dashboard/presentation";
import { listOwnedBudgets } from "../budgets/budget-queries";
import {
  dashboardTransactionQueries,
  decodeDashboardTransactions,
} from "../transactions/dashboard-query";
import { findDashboardAggregate, projectionReady } from "../transactions/dashboard-projection";

type Context = DashboardFacts["context"];
type LayoutWidgets = ReturnType<typeof collectLayoutWidgets>;
type Groups = DashboardFacts["groups"];

const loadBase = (
  db: D1Database,
  userId: string,
  widgets: LayoutWidgets
): Effect.Effect<Option.Option<Omit<DashboardFacts, "groups">>> =>
  Effect.gen(function* () {
    const lists = widgets.filter((widget) => widget.type === "transaction-list");
    const userQuery = prepareUserContext({ db, userId });
    const [user, categoryRows, state, ...pages] = yield* Effect.tryPromise(() =>
      db.batch([
        userQuery.statement,
        db.prepare("SELECT id, label FROM categories ORDER BY display_order LIMIT 32"),
        db
          .prepare("SELECT version, readiness FROM dashboard_projection_state WHERE user_id = ?")
          .bind(userId),
        ...dashboardTransactionQueries({
          db,
          userId,
          lists: lists.map((widget) => ({
            categories: widget.categories ?? [],
            search: Option.fromUndefinedOr(widget.search),
            limit: widget.limit,
          })),
        }),
      ])
    );
    if (pages.length !== lists.length) return Option.none();
    const selected = Option.all({
      user: Option.fromUndefinedOr(user),
      categories: Option.fromUndefinedOr(categoryRows),
      state: Option.fromUndefinedOr(state),
    });
    if (Option.isNone(selected) || !projectionReady(selected.value.state.results[0])) {
      return Option.none();
    }
    const context = userQuery.decode(selected.value.user.results[0]);
    const categories = Option.all(
      selected.value.categories.results.map((row) => Schema.decodeUnknownOption(Category)(row))
    );
    const listFacts = Option.all(
      lists.map((widget, index) =>
        Option.map(
          decodeDashboardTransactions(pages[index]?.results ?? []),
          (rows) => [widget.id, rows] as const
        )
      )
    );
    if (Option.isNone(context) || Option.isNone(categories) || Option.isNone(listFacts)) {
      return Option.none();
    }
    const { serviceMarket: service_market, locale, timeZone: time_zone } = context.value;
    const budgets = yield* listOwnedBudgets({ db, userId });
    return Option.map(budgets, (owned) => ({
      lists: new Map(listFacts.value),
      budgets: owned,
      categories: new Map(categories.value.map((category) => [category.id, category])),
      context: { service_market, locale, time_zone },
    }));
  }).pipe(Effect.orElseSucceed(() => Option.none()));

const findCached = (
  cache: Map<string, ReadonlyArray<EffectiveTransactionAggregate>>,
  input: Readonly<{ db: D1Database; userId: string; from: number; toExclusive: number }>
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
  context: Context;
  widgets: LayoutWidgets;
}>): Effect.Effect<Option.Option<Groups>> =>
  Effect.gen(function* () {
    const cached = new Map<string, ReadonlyArray<EffectiveTransactionAggregate>>();
    const groups = new Map<
      string,
      ReadonlyArray<
        Readonly<{
          key: string;
          contributions: ReadonlyArray<EffectiveTransactionAggregate>;
        }>
      >
    >();
    for (const widget of widgets) {
      if (widget.type === "transaction-list") continue;
      const buckets = [];
      for (const range of dashboardProjectionRanges(widget, now, context.time_zone)) {
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
