import { type Cause, DateTime, Effect, Exit, Option, Schema } from "effect";
import { afterAll, expect, it, vi } from "vitest";
import {
  installTestSchema,
  isolatedTestDatabases,
  observeRetentionCost,
} from "../../d1-test-fixture";
import { readAuthorizedUserDocumentSnapshot } from "../../user-documents/operations";
import { encodeMoneyAmount } from "../../../src/core/_shared/money";
import { defaultDocument, findDashboardSource } from "./dashboard-mutation";
import { type DashboardReadContext, loadDashboardFacts } from "./dashboard-view";
import { dashboardSourceCaller } from "../dashboard-read.test-fixture";
import { DashboardDocument, type LayoutNode } from "../../../src/core/dashboard/contract";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = "10000000-0000-4000-8000-000000000051";
const session = "10000000-0000-4000-8000-000000000061";
const budgetId = "20000000-0000-4000-8000-000000000001";
const fixture = (
  zone: string
): Effect.Effect<
  Readonly<{ db: D1Database; initial: DashboardReadContext }>,
  Cause.UnknownError | Effect.Error<ReturnType<typeof findDashboardSource>>
> =>
  Effect.gen(function* () {
    const db = yield* Effect.tryPromise(() => databases.acquire());
    yield* Effect.tryPromise(() => installTestSchema({ db }));
    yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO',?,0)"
          )
          .bind(userId, zone),
        db
          .prepare(
            "INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES ('processing_grant',?,?,'{}','disclosure','decision',0,0)"
          )
          .bind(userId, userId),
        db
          .prepare(
            "INSERT INTO budgets(id,user_id,category_id,currency,cap,created_at_ms,updated_at_ms,group_name) VALUES (?,?, '10000000-0000-4000-8000-000000000016','COP','50',0,0,'Home')"
          )
          .bind(budgetId, userId),
        db
          .prepare(
            "INSERT INTO budget_month_plan_records(kind,user_id,budget_id,month,cap) VALUES ('cap',?,?,'2026-10','100')"
          )
          .bind(userId, budgetId),
        db
          .prepare(
            "INSERT INTO budget_month_plan_records(kind,user_id,budget_id,month,cap) VALUES ('cap',?,?,'2026-11','200')"
          )
          .bind(userId, budgetId),
        db
          .prepare(
            "INSERT INTO budget_month_plan_records(kind,user_id,group_name,month,currency) VALUES ('currency',?,'Home','2026-10','COP')"
          )
          .bind(userId),
        db
          .prepare(
            "INSERT INTO budget_month_plan_records(kind,user_id,group_name,month,currency) VALUES ('currency',?,'Home','2026-11','USD')"
          )
          .bind(userId),
        db
          .prepare(
            "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES (?,'BCDF-BBB1',?,?,'consumed',0,600000)"
          )
          .bind(session, new Uint8Array(32), userId),
        db
          .prepare(
            "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES (?,?,?,?,0,600000,3600000,7776000000)"
          )
          .bind(session, session, userId, new Uint8Array(32)),
      ])
    );
    const source = yield* findDashboardSource({
      db,
      subject: dashboardSourceCaller(userId),
      current: 0,
      operation: "dashboard.getDashboardView",
    });
    return { db, initial: Option.getOrThrow(source.viewContext) };
  });

it("gates every private source row with the same live credential inside the native batch", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* fixture("America/Bogota");
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(DashboardDocument))(
        defaultDocument()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO user_documents(user_id,kind,document_json,revision) VALUES (?,'dashboard',?,1)"
          )
          .bind(userId, encoded)
          .run()
      );
      const services = yield* Effect.context<never>();
      let selectedRows: ReadonlyArray<number> = [];
      const observed = new Proxy(db, {
        get(target, key): unknown {
          if (key === "batch") {
            return <Row>(statements: D1PreparedStatement[]): Promise<D1Result<Row>[]> =>
              Effect.runPromiseWith(services)(
                Effect.gen(function* () {
                  const result = yield* Effect.tryPromise(() => target.batch<Row>(statements));
                  selectedRows = result.map((row) => row.results.length);
                  return result;
                })
              );
          }
          const value: unknown = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const source = yield* findDashboardSource({
        db: observed,
        subject: { ...dashboardSourceCaller(userId), digest: new Uint8Array(32).fill(1) },
        current: 0,
        operation: "dashboard.getDashboardView",
      });
      expect(source.live).toBe(false);
      expect(Option.isNone(source.document)).toBe(true);
      expect(Option.isNone(source.viewContext)).toBe(true);
      expect(selectedRows).toEqual([0, 0, 0, 0]);
    })
  ));

it("withholds an incomplete native source observation without retrying or asserting absence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* fixture("America/Bogota");
      const services = yield* Effect.context<never>();
      let calls = 0;
      const truncated = new Proxy(db, {
        get(target, key): unknown {
          if (key === "batch") {
            return <Row>(statements: D1PreparedStatement[]): Promise<D1Result<Row>[]> =>
              Effect.runPromiseWith(services)(
                Effect.gen(function* () {
                  calls++;
                  const result = yield* Effect.tryPromise(() => target.batch<Row>(statements));
                  return result.slice(0, -1);
                })
              );
          }
          const value: unknown = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const result = yield* Effect.exit(
        findDashboardSource({
          db: truncated,
          subject: dashboardSourceCaller(userId),
          current: 0,
          operation: "dashboard.getDashboardView",
        })
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(calls).toBe(1);
    })
  ));

it("refuses an oversized source plan before issuing any native request", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* fixture("America/Bogota");
      const observed = observeRetentionCost(db);
      const result = yield* Effect.exit(
        readAuthorizedUserDocumentSnapshot({
          db: observed.database,
          subject: dashboardSourceCaller(userId),
          current: 0,
          kind: "dashboard",
          related: Array.from({ length: 3 }, () => db.prepare("SELECT 1")),
        })
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(observed.roundTrips()).toBe(0);
    })
  ));

it.each([
  ["America/Bogota", "2026-11-01T04:59:59.999Z", "2026-11-01T05:00:00Z"],
  ["Asia/Tokyo", "2026-10-31T14:59:59.999Z", "2026-10-31T15:00:00Z"],
  ["Europe/Madrid", "2026-10-25T00:59:59.999Z", "2026-10-25T01:00:00Z"],
])(
  "keeps caps and inherited Currency on the captured calendar across %s boundaries",
  (zone, captured, after) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, initial } = yield* fixture(zone);
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          vi.setSystemTime(after);
          const facts = Option.getOrThrow(
            yield* loadDashboardFacts({
              db,
              userId,
              initial,
              document: defaultDocument(),
              now: DateTime.makeUnsafe(captured),
            })
          );
          expect(facts.context.timeZone).toBe(zone);
          expect(
            facts.budgets.map((budget) => ({
              amount: encodeMoneyAmount(budget.cap.amount),
              currency: budget.cap.currency,
            }))
          ).toEqual([{ amount: "100", currency: "COP" }]);
        } finally {
          vi.useRealTimers();
        }
      })
    )
);

const daily = (node: LayoutNode): LayoutNode => {
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
      { ...first, node: daily(first.node) },
      { ...second, node: daily(second.node) },
      ...rest.map((child) => ({ ...child, node: daily(child.node) })),
    ],
  };
};

it.each(["context", "revision", "consent"] as const)(
  "withholds every list, cap and range after %s changes between chunks",
  (change) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, initial } = yield* fixture("America/Bogota");
        const services = yield* Effect.context<never>();
        let batches = 0;
        const changing = new Proxy(db, {
          get(target, key): unknown {
            if (key === "batch") {
              return <Row>(statements: D1PreparedStatement[]): Promise<D1Result<Row>[]> =>
                Effect.runPromiseWith(services)(
                  Effect.gen(function* () {
                    const result = yield* Effect.tryPromise(() => target.batch<Row>(statements));
                    batches++;
                    if (batches === 1) {
                      if (change === "context") {
                        yield* Effect.tryPromise(() =>
                          db
                            .prepare("UPDATE users SET time_zone='Asia/Tokyo' WHERE id=?")
                            .bind(userId)
                            .run()
                        );
                      }
                      if (change === "revision") {
                        yield* Effect.tryPromise(() =>
                          db
                            .prepare(
                              "UPDATE transaction_projection_state SET fact_revision=COALESCE(fact_revision,0)+1,first_captured_at_ms=0,time_zone='America/Bogota' WHERE user_id=?"
                            )
                            .bind(userId)
                            .run()
                        );
                      }
                      if (change === "consent") {
                        yield* Effect.tryPromise(() =>
                          db
                            .prepare(
                              "INSERT INTO consent_history(record_type,id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES ('processing_withdrawal',?,?,?,?,1)"
                            )
                            .bind(budgetId, userId, userId, session)
                            .run()
                        );
                      }
                    }
                    return result;
                  })
                );
            }
            const value: unknown = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const document = defaultDocument();
        expect(
          Option.isNone(
            yield* loadDashboardFacts({
              db: changing,
              userId,
              initial,
              document: { ...document, layout: daily(document.layout) },
              now: DateTime.makeUnsafe("2026-10-15T12:00:00Z"),
            })
          )
        ).toBe(true);
        expect(batches).toBe(2);
      })
    )
);

it("refuses changed context before releasing even a default-sized financial snapshot", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, initial } = yield* fixture("America/Bogota");
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE users SET time_zone='Asia/Tokyo' WHERE id=?").bind(userId).run()
      );
      expect(
        Option.isNone(
          yield* loadDashboardFacts({
            db,
            userId,
            initial,
            document: defaultDocument(),
            now: DateTime.makeUnsafe("2026-10-15T12:00:00Z"),
          })
        )
      ).toBe(true);
    })
  ));

it("refuses a retained invalid IANA context without manufacturing view defaults", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* fixture("America/Bogota");
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE users SET time_zone='Invalid/Zone' WHERE id=?").bind(userId).run()
      );
      const source = yield* findDashboardSource({
        db,
        subject: dashboardSourceCaller(userId),
        current: 0,
        operation: "dashboard.getDashboardView",
      });
      expect(Option.isNone(source.viewContext)).toBe(true);
    })
  ));

it("withholds the entire financial snapshot for malformed inherited cap precision", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, initial } = yield* fixture("America/Bogota");
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE budget_month_plan_records SET cap='1e2' WHERE kind='cap' AND user_id=? AND month='2026-10'"
          )
          .bind(userId)
          .run()
      );
      expect(
        Option.isNone(
          yield* loadDashboardFacts({
            db,
            userId,
            initial,
            document: defaultDocument(),
            now: DateTime.makeUnsafe("2026-10-15T12:00:00Z"),
          })
        )
      ).toBe(true);
    })
  ));

it("retains native Budget capacity enforcement and reads the complete maximum set", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, initial } = yield* fixture("America/Bogota");
      yield* Effect.tryPromise(() =>
        db.prepare("DELETE FROM budgets WHERE user_id=?").bind(userId).run()
      );
      const currencies = ["COP", "USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "NZD"];
      const pairs = initial.categories
        .flatMap((category) => currencies.map((currency) => ({ category, currency })))
        .slice(0, 129);
      expect(pairs).toHaveLength(129);
      const statements = pairs.map(({ category, currency }, index) =>
        db
          .prepare(
            "INSERT INTO budgets(id,user_id,category_id,currency,cap,created_at_ms,updated_at_ms) VALUES (?,?,?,?,'100',0,0)"
          )
          .bind(
            `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            userId,
            category.id,
            currency
          )
      );
      expect(
        Exit.isFailure(yield* Effect.exit(Effect.tryPromise(() => db.batch(statements))))
      ).toBe(true);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT COUNT(*) AS count FROM budgets WHERE user_id=?").bind(userId).first()
        )
      ).toEqual({ count: 0 });
      yield* Effect.tryPromise(() => db.batch(statements.slice(0, 128)));
      const facts = Option.getOrThrow(
        yield* loadDashboardFacts({
          db,
          userId,
          initial,
          document: defaultDocument(),
          now: DateTime.makeUnsafe("2026-10-15T12:00:00Z"),
        })
      );
      expect(facts.budgets).toHaveLength(128);
      expect(facts.lists.size).toBe(1);
      expect(facts.groups.size).toBe(3);
    })
  ));
