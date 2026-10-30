import { DateTime, Effect, Option } from "effect";
import { afterAll, expect, it } from "vitest";
import {
  installTestSchema,
  isolatedTestDatabases,
  observeRetentionCost,
} from "../../d1-test-fixture";
import { defaultDocument } from "./dashboard-mutation";
import { loadDashboardFacts } from "./dashboard-view";

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

it("overlaps independent Dashboard facts while retaining complete native projections", () =>
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
      expect(observed.maximum()).toBe(2);
      expect(cost.roundTrips()).toBe(5);
    })
  ));
