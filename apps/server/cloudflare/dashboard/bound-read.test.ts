import { type Cause, DateTime, Effect } from "effect";
import { afterAll, expect, it } from "vitest";
import { browserSessionBindingHeader } from "../../src/shell/browser-transport/contract";
import { installTestSchema, isolatedTestDatabases, isolatedTestStorage } from "../d1-test-fixture";
import { protectCanonicalBrowserSnapshot } from "../canonical-admission/operations";
import { measureErasureRecovery } from "../erasure/runtime";
import { prepareBoundDashboardRead } from "./operations";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const storage = isolatedTestStorage();
afterAll(() => storage.dispose());
const userId = "10000000-0000-4000-8000-000000000001";
const sessionId = "60000000-0000-4000-8000-000000000001";
const current = DateTime.toEpochMillis(DateTime.nowUnsafe());
const io = <A>(work: () => Promise<A>): Effect.Effect<A, Cause.UnknownError> =>
  Effect.tryPromise(work);
const setup = Effect.gen(function* () {
  const db = yield* io(() => databases.acquire());
  yield* io(() => installTestSchema({ db }));
  const digest = new Uint8Array(
    yield* io(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode("c".repeat(43))))
  );
  yield* io(() =>
    db.batch([
      db
        .prepare(
          "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)"
        )
        .bind(userId, current),
      db
        .prepare(
          "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES (?,'BCDF-GHJK',?,?,'consumed',?,?)"
        )
        .bind(sessionId, digest, userId, current, current + 600000),
      db
        .prepare(
          "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES (?,?,?,?,?,?,?,?)"
        )
        .bind(
          sessionId,
          sessionId,
          userId,
          digest,
          current,
          current + 600000,
          current + 3600000,
          current + 7776000000
        ),
    ])
  );
  return db;
});
const read = (db: D1Database): Promise<Response> =>
  Effect.runPromise(
    protectCanonicalBrowserSnapshot({
      db,
      current,
      operation: "dashboard.getDashboardView",
      read: prepareBoundDashboardRead,
      request: new Request("https://core.internal/dashboard/view", {
        headers: {
          cookie: `__Host-fidy_session=${"c".repeat(43)}`,
          [browserSessionBindingHeader]: sessionId,
        },
      }),
    })
  );

it("audits genuine Dashboard absence in one native round trip without initializing it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup;
      let calls = 0;
      const observed = new Proxy(db, {
        get(target, property): unknown {
          if (property === "batch") {
            return <Row>(statements: D1PreparedStatement[]): Promise<D1Result<Row>[]> => {
              calls++;
              return target.batch<Row>(statements);
            };
          }
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const response = yield* io(() => read(observed));
      expect(response.status).toBe(404);
      expect(yield* io(() => response.json())).toEqual({
        error: {
          code: "dashboard_uninitialized",
          message: "Initialize your Dashboard explicitly, then read it again.",
        },
        next: [],
      });
      expect(calls).toBe(1);
      expect(
        yield* io(() =>
          db.prepare("SELECT COUNT(*) AS count FROM user_documents WHERE kind='dashboard'").first()
        )
      ).toEqual({ count: 0 });
      expect(
        yield* io(() =>
          db
            .prepare(
              "SELECT operation,outcome FROM audit_entries WHERE operation='dashboard.getDashboardView'"
            )
            .all()
        )
      ).toMatchObject({
        results: [{ operation: "dashboard.getDashboardView", outcome: "accepted" }],
      });
    })
  ));

it("reads the retained list layout and authoritative effective Transactions in the same audited snapshot", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup;
      const widget = {
        id: "30000000-0000-4000-8000-000000000001",
        type: "transaction-list",
        limit: 1,
        categories: ["10000000-0000-4000-8000-000000000001"],
        search: "café",
      };
      yield* io(() =>
        db
          .prepare(
            "INSERT INTO user_documents(kind,user_id,document_json,revision) VALUES ('dashboard',?,?,7)"
          )
          .bind(userId, JSON.stringify({ title: "Recientes", layout: { kind: "leaf", widget } }))
          .run()
      );
      yield* io(() =>
        db
          .prepare(
            `INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,counterparty,occurred_at_ms,created_at_ms) VALUES ('40000000-0000-4000-8000-000000000001',?,'123456789012345678901234567890.01','COP','outflow',?,'CAFÉ',?,?)`
          )
          .bind(userId, widget.categories[0], current, current)
          .run()
      );
      yield* io(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,counterparty,occurred_at_ms,created_at_ms) VALUES ('40000000-0000-4000-8000-000000000002',?,'999','COP','outflow',?,'CAFÉ',?,?)"
            )
            .bind(userId, widget.categories[0], current - 1, current),
          db
            .prepare(
              "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,counterparty,occurred_at_ms,created_at_ms) VALUES ('40000000-0000-4000-8000-000000000003',?,'888','COP','outflow','10000000-0000-4000-8000-000000000002','CAFÉ',?,?)"
            )
            .bind(userId, current + 1, current),
          db
            .prepare(
              "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,counterparty,occurred_at_ms,created_at_ms) VALUES ('40000000-0000-4000-8000-000000000004',?,'777','COP','outflow',?,'OTHER',?,?)"
            )
            .bind(userId, widget.categories[0], current + 2, current),
        ])
      );
      const response = yield* io(() => read(db));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("etag")).toBe('"7"');
      expect(yield* io(() => response.json())).toMatchObject({
        data: {
          title: "Recientes",
          layout: {
            kind: "leaf",
            widget: {
              widget,
              result: {
                transactions: [
                  {
                    id: "40000000-0000-4000-8000-000000000001",
                    money: { amount: "123456789012345678901234567890.01", currency: "COP" },
                    counterparty: "CAFÉ",
                  },
                ],
              },
            },
          },
        },
      });
    })
  ));

it.each(["audit", "invalid", "revoked", "withdrawn"])(
  "withholds Dashboard content after %s refusal",
  (failure) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup;
        yield* io(() =>
          db
            .prepare(
              "INSERT INTO user_documents(kind,user_id,document_json,revision) VALUES ('dashboard',?,?,1)"
            )
            .bind(
              userId,
              failure === "invalid"
                ? '{"title":"Private invalid result"}'
                : JSON.stringify({
                    title: "Private financial dashboard",
                    layout: {
                      kind: "leaf",
                      widget: {
                        id: "30000000-0000-4000-8000-000000000001",
                        type: "transaction-list",
                        limit: 10,
                      },
                    },
                  })
            )
            .run()
        );
        if (failure === "audit") {
          yield* io(() =>
            db
              .prepare(
                "CREATE TRIGGER refuse_dashboard_audit BEFORE INSERT ON audit_entries WHEN NEW.operation='dashboard.getDashboardView' BEGIN SELECT RAISE(ABORT,'fixture audit refusal'); END"
              )
              .run()
          );
        }
        if (failure === "revoked") {
          yield* io(() =>
            db
              .prepare("UPDATE web_sessions SET revoked_at_ms=? WHERE id=?")
              .bind(current, sessionId)
              .run()
          );
        }
        if (failure === "withdrawn") {
          yield* io(() =>
            db.batch([
              db
                .prepare(
                  "INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES ('processing_grant','fixture-grant',?,'{}','disclosure','decision',?,?)"
                )
                .bind(userId, current - 1000, current - 1000),
              db
                .prepare(
                  "INSERT INTO consent_history(record_type,id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES ('processing_withdrawal','fixture-withdrawal',?,'fixture-grant',?,?)"
                )
                .bind(userId, sessionId, current),
            ])
          );
        }
        const response = yield* io(() => read(db));
        expect(response.status).toBe(failure === "revoked" || failure === "withdrawn" ? 401 : 503);
        expect(yield* io(() => response.text())).not.toContain("Private");
        if (failure === "audit") {
          expect(
            yield* io(() =>
              db
                .prepare(
                  "SELECT COUNT(*) AS count FROM audit_entries WHERE operation='dashboard.getDashboardView'"
                )
                .first()
            )
          ).toEqual({ count: 0 });
        }
      })
    )
);

it("retains one fresh recovery generation check around the audited native Dashboard read", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup;
      const { bucket } = yield* io(() => storage.acquire());
      yield* io(() => bucket.put("recovery/generation", "initial"));
      let checks = 0;
      const observedBucket = new Proxy(bucket, {
        get(target, property): unknown {
          if (property === "get") {
            return (key: string): ReturnType<R2Bucket["get"]> => {
              checks++;
              return target.get(key);
            };
          }
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const measured = measureErasureRecovery({
        DB: db,
        ERASURE_REQUIRED: "true",
        ERASURE_BUCKET: observedBucket,
      });
      const response = measured.respond(yield* io(() => read(measured.environment.DB)));
      expect(response.status).toBe(404);
      expect(checks).toBe(1);
      expect(response.headers.get("server-timing")).toContain("recovery-r2");
    })
  ));
