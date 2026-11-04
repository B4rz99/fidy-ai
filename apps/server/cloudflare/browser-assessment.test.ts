import { defaultAssessmentDashboard } from "./browser-assessment-layout.test-fixture";
import { afterAll, expect, it } from "vitest";
import { DateTime, Effect, Schema } from "effect";
import { installTestSchema, isolatedTestDatabases } from "./d1-test-fixture";
import { seedAssessment } from "./browser-assessment.test-fixture";
import { DashboardDocument } from "../src/core/dashboard/contract";
import { collectLayoutWidgets } from "../src/core/dashboard/operations";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const users = Array.from(
  { length: 8 },
  (_, index) => `98000000-0000-4000-8000-${String(index).padStart(12, "0")}`
);
const Counts = Schema.Array(Schema.Struct({ userId: Schema.String, count: Schema.Finite }));
const current = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-04T12:00:00Z"));
const seedUsers = (db: D1Database, subjects: ReadonlyArray<string>): Promise<unknown> =>
  db.batch(
    subjects.map((user) =>
      db
        .prepare(
          "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',0)"
        )
        .bind(user)
    )
  );
it("prepares separate complete financial histories for every offered User", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() => installTestSchema({ db }));
      yield* Effect.tryPromise(() => seedUsers(db, users));
      yield* seedAssessment({
        db,
        dataset: "small",
        now: current,
        users,
        history: "routine",
        layout: "default",
      });
      const facts = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT user_id AS userId, COUNT(*) AS count FROM transactions GROUP BY user_id ORDER BY user_id"
          )
          .all()
      );
      const actual = yield* Schema.decodeUnknownEffect(Counts)(facts.results);
      expect(actual).toEqual(users.map((userId) => ({ userId, count: 500 })));
    })
  ));
it("prepares a maximum all-Widget layout over linked histories without duplicating effective movements", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() => installTestSchema({ db }));
      const user = "98000000-0000-4000-8000-000000000111";
      yield* Effect.tryPromise(() => seedUsers(db, [user]));
      yield* seedAssessment({
        db,
        dataset: "small",
        now: current,
        users: [user],
        history: "reconciled",
        layout: "maximum",
      });
      const effective = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT COUNT(*) AS count FROM transaction_effective_source WHERE user_id=?")
          .bind(user)
          .first("count")
      );
      expect(effective).toBe(250);
      const encoded = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT document_json FROM user_documents WHERE user_id=? AND kind='dashboard'")
          .bind(user)
          .first("document_json")
      );
      const document = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DashboardDocument))(
        encoded
      );
      const widgets = collectLayoutWidgets(document.layout);
      expect(widgets).toHaveLength(24);
      expect(
        Object.fromEntries(
          ["spending-chart", "budget-bar", "transaction-list", "custom-metric"].map((type) => [
            type,
            widgets.filter((widget) => widget.type === type).length,
          ])
        )
      ).toEqual({
        "spending-chart": 6,
        "budget-bar": 6,
        "transaction-list": 6,
        "custom-metric": 6,
      });
    })
  ));

it("prepares dense distinct amounts inside the measured period and preserves wide Money text", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const history of ["dense", "wide"] as const) {
        const db = yield* Effect.tryPromise(() => databases.acquire());
        yield* Effect.tryPromise(() => installTestSchema({ db }));
        const user = "98000000-0000-4000-8000-000000000112";
        yield* Effect.tryPromise(() => seedUsers(db, [user]));
        yield* seedAssessment({
          db,
          dataset: "small",
          now: current,
          users: [user],
          history,
          layout: "default",
        });
        const distinct = yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT COUNT(DISTINCT amount) AS count FROM transactions WHERE user_id=?")
            .bind(user)
            .first("count")
        );
        expect(distinct).toBe(500);
        if (history === "wide") {
          const amount = yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT amount FROM transactions WHERE user_id=? ORDER BY id LIMIT 1")
              .bind(user)
              .first("amount")
          );
          expect(amount).toBe("90071992547409931234567890123456789012345678901234567890.15");
        }
      }
    })
  ));

it("prepares assessment history without replacing a Dashboard retained by another feature journey", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() => installTestSchema({ db }));
      const user = "98000000-0000-4000-8000-000000000211";
      yield* Effect.tryPromise(() => seedUsers(db, [user]));
      const document = yield* Schema.encodeEffect(Schema.fromJsonString(DashboardDocument))({
        ...defaultAssessmentDashboard(),
        title: "Retained feature journey",
      });
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO user_documents(kind,user_id,document_json,revision) VALUES ('dashboard',?,?,7)"
          )
          .bind(user, document)
          .run()
      );
      yield* seedAssessment({
        db,
        dataset: "small",
        now: current,
        users: [user],
        history: "routine",
        layout: "default",
      });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT document_json AS document,revision FROM user_documents WHERE kind='dashboard' AND user_id=?"
            )
            .bind(user)
            .first()
        )
      ).toEqual({ document, revision: 7 });
    })
  ));
