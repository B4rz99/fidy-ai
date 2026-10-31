import { DateTime, Effect, Option } from "effect";
import type { LayoutNode } from "../../../src/core/dashboard/contract";
import { afterAll, expect, it } from "vitest";
import {
  installTestSchema,
  isolatedTestDatabases,
  observeRetentionCost,
} from "../../d1-test-fixture";
import { defaultDocument, findDashboardSource } from "./dashboard-mutation";
import { loadDashboardFacts as loadFacts } from "./dashboard-view";
import { dashboardSourceCaller, seedDashboardSourceCaller } from "../dashboard-read.test-fixture";
import { findDashboardAggregateRanges } from "../../transactions/operations";
// Include the real document/context and taxonomy reads in every measured fixture call.
const loadDashboardFacts = (
  input: Omit<Parameters<typeof loadFacts>[0], "initial">
): Effect.Effect<
  Effect.Success<ReturnType<typeof loadFacts>>,
  Effect.Error<ReturnType<typeof findDashboardSource>>
> =>
  Effect.gen(function* () {
    const source = yield* findDashboardSource({
      db: input.db,
      subject: dashboardSourceCaller(input.userId),
      current: 0,
      operation: "dashboard.getDashboardView",
    });
    return yield* loadFacts({ ...input, initial: Option.getOrThrow(source.viewContext) });
  });

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());

/** Observe outstanding native requests without replacing their execution or decoded results. */
const observeConcurrency = (
  db: D1Database
): Readonly<{
  database: D1Database;
  maximum: () => number;
}> => {
  let pending = 0;
  let maximum = 0;
  const nativeStatements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const observe = <A>(work: () => Promise<A>): Promise<A> => {
    pending++;
    maximum = Math.max(maximum, pending);
    return work().finally(() => pending--);
  };
  const statement = (native: D1PreparedStatement): D1PreparedStatement => {
    const tracked = new Proxy(native, {
      get(target, property): unknown {
        if (property === "bind") {
          return (...values: Parameters<D1PreparedStatement["bind"]>) =>
            statement(target.bind(...values));
        }
        if (property === "all") return () => observe(() => target.all());
        if (property === "first") {
          return (column?: string) =>
            observe(() => (column === undefined ? target.first() : target.first(column)));
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    nativeStatements.set(tracked, native);
    return tracked;
  };
  return {
    maximum: () => maximum,
    database: new Proxy(db, {
      get(target, property): unknown {
        if (property === "prepare") return (sql: string) => statement(target.prepare(sql));
        if (property === "batch") {
          return <Row>(statements: D1PreparedStatement[]) =>
            observe(() =>
              target.batch<Row>(
                statements.map((prepared) => nativeStatements.get(prepared) ?? prepared)
              )
            );
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
};

it("serializes the authorized source and complete financial projections", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() => installTestSchema({ db }));
      const userId = "10000000-0000-4000-8000-000000000051";
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', 0)"
            )
            .bind(userId),
          db
            .prepare(
              "INSERT INTO consent_history (record_type, id, user_id, disclosure_json, disclosure_message_id, decision_message_id, decision_received_at_ms, occurred_at_ms) VALUES ('processing_grant', ?, ?, '{}', 'disclosure', 'decision', 0, 0)"
            )
            .bind(userId, userId),
        ])
      );
      yield* Effect.tryPromise(() => seedDashboardSourceCaller({ db, userId }));
      const cost = observeRetentionCost(db);
      const observed = observeConcurrency(cost.database);
      const result = Option.getOrThrow(
        yield* loadDashboardFacts({
          db: observed.database,
          userId,
          document: defaultDocument(),
          now: DateTime.makeUnsafe("2026-10-15T12:00:00Z"),
        })
      );
      expect(result.context.timeZone).toBe("America/Bogota");
      expect(result.categories.size).toBeGreaterThan(0);
      expect([...result.lists.values()]).toEqual([[]]);
      expect(result.budgets).toEqual([]);
      expect(result.groups.size).toBe(3);
      expect(observed.maximum()).toBe(1);
      expect(cost.roundTrips()).toBe(2);
    })
  ));

const dailyChart = (node: LayoutNode): LayoutNode => {
  if (node.kind === "leaf") {
    return {
      ...node,
      widget:
        node.widget.type === "spending-chart" ? { ...node.widget, groupBy: "day" } : node.widget,
    };
  }
  const [first, second, ...rest] = node.children;
  return {
    ...node,
    children: [
      { ...first, node: dailyChart(first.node) },
      { ...second, node: dailyChart(second.node) },
      ...rest.map((child) => ({ ...child, node: dailyChart(child.node) })),
    ],
  };
};

it("loads all daily chart intervals in bounded native batches without rereading shared periods", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() => installTestSchema({ db }));
      const userId = "10000000-0000-4000-8000-000000000052";
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', 0)"
            )
            .bind(userId),
          db
            .prepare(
              "INSERT INTO consent_history (record_type, id, user_id, disclosure_json, disclosure_message_id, decision_message_id, decision_received_at_ms, occurred_at_ms) VALUES ('processing_grant', ?, ?, '{}', 'disclosure', 'decision', 0, 0)"
            )
            .bind(userId, userId),
        ])
      );
      yield* Effect.tryPromise(() => seedDashboardSourceCaller({ db, userId }));
      const cost = observeRetentionCost(db);
      const original = defaultDocument();
      const result = Option.getOrThrow(
        yield* loadDashboardFacts({
          db: cost.database,
          userId,
          document: { ...original, layout: dailyChart(original.layout) },
          now: DateTime.makeUnsafe("2026-10-15T12:00:00Z"),
        })
      );
      expect(
        [...result.groups.values()]
          .map((ranges) => ranges.length)
          .sort((left, right) => left - right)
      ).toEqual([1, 1, 31]);
      expect(
        [...result.groups.values()].flatMap((ranges) => ranges.map((range) => range.contributions))
      ).toEqual(Array.from({ length: 33 }, () => []));
      expect(cost.roundTrips()).toBe(9);
    })
  ));

it.each(["revision", "consent"] as const)(
  "refuses the complete interval read after %s changes between batches",
  (change) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => databases.acquire());
        yield* Effect.tryPromise(() => installTestSchema({ db }));
        const userId = "10000000-0000-4000-8000-000000000053";
        yield* Effect.tryPromise(() =>
          db.batch([
            db
              .prepare(
                "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', 0)"
              )
              .bind(userId),
            db
              .prepare(
                "INSERT INTO consent_history (record_type, id, user_id, disclosure_json, disclosure_message_id, decision_message_id, decision_received_at_ms, occurred_at_ms) VALUES ('processing_grant', ?, ?, '{}', 'disclosure', 'decision', 0, 0)"
              )
              .bind(userId, userId),
          ])
        );
        yield* Effect.tryPromise(() => seedDashboardSourceCaller({ db, userId }));
        expect(
          Option.isSome(
            yield* loadDashboardFacts({
              db,
              userId,
              document: defaultDocument(),
              now: DateTime.makeUnsafe("2026-10-15T12:00:00Z"),
            })
          )
        ).toBe(true);
        const session = dashboardSourceCaller(userId).id;
        const services = yield* Effect.context<never>();
        let batches = 0;
        const changing = new Proxy(db, {
          get(target, property): unknown {
            if (property === "batch") {
              return <Row>(statements: D1PreparedStatement[]): Promise<D1Result<Row>[]> =>
                Effect.runPromiseWith(services)(
                  Effect.gen(function* () {
                    const result = yield* Effect.tryPromise(() => target.batch<Row>(statements));
                    batches++;
                    if (batches === 1) {
                      if (change === "revision") {
                        yield* Effect.tryPromise(() =>
                          db
                            .prepare(
                              "UPDATE transaction_projection_state SET fact_revision = COALESCE(fact_revision, 0) + 1, first_captured_at_ms = COALESCE(first_captured_at_ms, 0), time_zone = COALESCE(time_zone, 'America/Bogota') WHERE user_id = ?"
                            )
                            .bind(userId)
                            .run()
                        );
                      } else {
                        yield* Effect.tryPromise(() =>
                          db
                            .prepare(
                              "INSERT INTO consent_history(record_type,id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES ('processing_withdrawal',?,?,?,?,1)"
                            )
                            .bind("10000000-0000-4000-8000-000000000056", userId, userId, session)
                            .run()
                        );
                      }
                    }
                    return result;
                  })
                );
            }
            const value: unknown = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const result = yield* findDashboardAggregateRanges({
          db: changing,
          userId,
          ranges: Array.from({ length: 12 }, (_, day) => ({
            from: Date.UTC(2026, 9, day + 1),
            toExclusive: Date.UTC(2026, 9, day + 2),
          })),
        });
        expect(Option.isNone(result)).toBe(true);
        expect(batches).toBe(2);
      })
    )
);
