import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { expect } from "vitest";
import { Currency } from "../../src/core/_shared/money";
import { Budget } from "../../src/core/budgets/contract";
import {
  alice,
  bob,
  category,
  nativeTransactionJourney,
  seedNativePAT,
} from "../financial-user-store.test-fixture";
import { native } from "../user-store.test-fixture";

const readJson = (response: Response): Effect.Effect<unknown> => native(() => response.json());

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "reads a freshly committed monthly Budget from its User store and isolates foreign edits",
    () =>
      Effect.gen(function* () {
        const journey = yield* nativeTransactionJourney;

        const call = (
          subject: typeof alice,
          path: string,
          ...args: [method: string, payload?: unknown]
        ): Effect.Effect<Response> =>
          native(() =>
            journey.send(
              new Request("https://api.fidyapp.com" + path, {
                method: args[0],
                headers: {
                  origin: "https://app.fidyapp.com",
                  cookie: "__Host-fidy_session=" + subject.bearer,
                  "Fidy-Session-Binding": subject.session,
                  "content-type": "application/json",
                },
                body: args[1] === undefined ? null : JSON.stringify(args[1]),
              })
            )
          );

        const cap = { amount: "9007199254740993.15", currency: "USD" };
        const payload = { categoryId: category, cap, month: "2023-11", groupName: "Family" };
        const created = yield* call(alice, "/budgets", "POST", payload);
        expect(created.status).toBe(201);

        const { data } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.toCodecJson(Budget) })
        )(yield* native(() => created.json()));

        expect((yield* call(bob, "/budgets/" + data.id, "PUT", payload)).status).toBe(404);

        const month = yield* call(
          alice,
          "/budget-status?timeZone=America%2FBogota&month=2023-11",
          "GET"
        );

        expect(month.status).toBe(200);
        expect(yield* native(() => month.json())).toMatchObject({
          data: {
            initialized: true,
            budgets: [{ id: data.id, cap }],
            statuses: [{ type: "under", remaining: cap }],
          },
        });
      })
  );
  test.effect(
    "commits one concurrent PAT Budget, replays its original result after edits and rolls back an incomplete Audit",
    () =>
      Effect.gen(function* () {
        const db = yield* nativeTransactionJourney;
        const token = "fin_abcdefgh_" + "x".repeat(43);
        yield* seedNativePAT({
          db,
          userId: alice.user,
          token,
          scopes: ["read", "write"],
          current: yield* Clock.currentTimeMillis,
        });

        const call = (
          path: string,
          method: string,
          ...args: [key?: string, payload?: unknown]
        ): Effect.Effect<Response> =>
          native(() => {
            const headers = new Headers({
              authorization: "Bearer " + token,
              "content-type": "application/json",
            });

            if (args[0] !== undefined) headers.set("Fidy-Retry-Key", args[0]);

            return db.send(
              new Request("https://api.fidyapp.com" + path, {
                method,
                headers,
                body: args[1] === undefined ? null : JSON.stringify(args[1]),
              })
            );
          });

        const original = {
          categoryId: category,
          cap: { amount: "91.75", currency: "COP" },
          month: "2023-11",
        };

        const create = (): Effect.Effect<Response> =>
          call("/budgets", "POST", "lost-create", original);

        const counts = (): Effect.Effect<ReadonlyArray<unknown>> =>
          native(() =>
            db.exec(
              "SELECT (SELECT count(*) FROM budgets) AS budgets,(SELECT count(*) FROM audit_entries WHERE record_type='credential_call') AS calls,(SELECT count(*) FROM commercial_allowance_consumptions) AS charges,(SELECT count(*) FROM canonical_request_receipts) AS receipts,(SELECT count(*) FROM budget_month_plan_records) AS plans"
            )
          );

        yield* native(() =>
          db.exec(
            "CREATE TRIGGER interrupt_budget_audit BEFORE INSERT ON audit_entries WHEN NEW.record_type='credential_call' BEGIN SELECT RAISE(IGNORE); END"
          )
        );
        expect((yield* create()).status).toBe(503);
        expect(yield* counts()).toEqual([
          { budgets: 0, calls: 0, charges: 0, receipts: 0, plans: 0 },
        ]);
        yield* native(() => db.exec("DROP TRIGGER interrupt_budget_audit"));
        const [first, retry] = yield* Effect.all([create(), create()], { concurrency: 2 });
        expect([first.status, retry.status]).toEqual([201, 201]);
        const originalText = yield* native(() => first.text());
        expect(yield* native(() => retry.text())).toBe(originalText);

        const response = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ data: Schema.toCodecJson(Budget) }))
        )(originalText);

        const path = "/budgets/" + response.data.id;
        expect(yield* counts()).toEqual([
          { budgets: 1, calls: 2, charges: 1, receipts: 1, plans: 2 },
        ]);
        const revised = { ...original, cap: { amount: "123.45", currency: "COP" } };
        const edit = (): Effect.Effect<Response> => call(path, "PUT", "retry-update", revised);
        const updated = yield* edit();
        expect(updated.status).toBe(200);
        const replayedEdit = yield* edit();
        expect(yield* native(() => updated.text())).toBe(yield* native(() => replayedEdit.text()));
        const replayedCreate = yield* create();
        expect(yield* native(() => replayedCreate.text())).toBe(originalText);
        const fresh = yield* call("/budget-status?month=2023-11&timeZone=America%2FBogota", "GET");
        expect(yield* native(() => fresh.json())).toMatchObject({
          data: { statuses: [{ budget: { id: response.data.id, cap: revised.cap } }] },
        });
        expect((yield* call(path, "PUT", "lost-create", revised)).status).toBe(400);
        const remove = (): Effect.Effect<Response> => call(path, "DELETE", "retry-delete");
        expect((yield* remove()).status).toBe(200);
        expect((yield* remove()).status).toBe(200);
        yield* Effect.sleep("300 millis");
        expect((yield* call(path, "GET")).status).toBe(404);
        expect(
          yield* native(() =>
            db.exec("SELECT count(*) AS caps FROM budget_month_plan_records WHERE kind='cap'")
          )
        ).toEqual([{ caps: 0 }]);
        yield* native(() => db.exec("UPDATE pats SET revoked_at_ms=issued_at_ms"));
        expect((yield* create()).status).toBe(401);
      })
  );
  test.effect(
    "uses corrected movement facts exactly once for linked Transactions and rejects a foreign link",
    () =>
      Effect.gen(function* () {
        const db = yield* nativeTransactionJourney;

        const request = (
          path: string,
          method: string,
          payload?: unknown
        ): Effect.Effect<Response> =>
          native(() =>
            db.send(
              new Request("https://api.fidyapp.com" + path, {
                method,
                headers: {
                  origin: "https://app.fidyapp.com",
                  cookie: "__Host-fidy_session=" + alice.bearer,
                  "Fidy-Session-Binding": alice.session,
                  "content-type": "application/json",
                },
                body: payload === undefined ? null : JSON.stringify(payload),
              })
            )
          );

        const categoryId = category;
        const cap = { amount: "9007199254740994.11", currency: "USD" };
        expect((yield* request("/budgets", "POST", { categoryId, cap })).status).toBe(201);

        const original = {
          money: { amount: "9007199254740993.11", currency: "USD" },
          occurredAt: "2023-11-15T17:00:00Z",
          categoryId,
          direction: "outflow",
        };

        const create = Effect.fn(function* () {
          const response = yield* request("/transactions", "POST", original);
          expect(response.status).toBe(201);

          return (yield* Schema.decodeUnknownEffect(
            Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })
          )(yield* readJson(response))).data.id;
        });

        const first = yield* create();
        const second = yield* create();

        const observe = Effect.fn(function* (amount: string) {
          const response = yield* request(
            "/budget-status?month=2023-11&timeZone=America%2FBogota",
            "GET"
          );

          expect(response.status).toBe(200);
          expect(yield* readJson(response)).toMatchObject({
            data: { statuses: [{ spent: { amount, currency: "USD" } }] },
          });
        });

        const pending =
          "SELECT kind,source,offer_id,next_ms FROM category_opportunities ORDER BY kind";

        const threshold =
          "SELECT budget_id,threshold,event_id FROM budget_threshold_crossings ORDER BY budget_id,threshold";

        yield* native(() =>
          db.exec(
            "UPDATE category_opportunities SET next_ms=9000000000000 WHERE kind='budget-threshold'"
          )
        );

        const snapshot = Effect.all([
          native(() => db.exec(pending)),
          native(() => db.exec(threshold)),
        ]);

        const before = yield* snapshot;
        expect(before[0]).toMatchObject([
          { kind: "budget-threshold", offer_id: null, next_ms: 9000000000000 },
        ]);
        yield* observe("18014398509481986.22");
        expect(yield* snapshot).toEqual(before);
        const foreign = "40000000-0000-4000-8000-000000000055";
        yield* native(() =>
          db
            .owner(bob.user)
            .exec(
              "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) VALUES(?,?,'9007199254740993.11','USD','outflow',?,0,0)",
              foreign,
              bob.user,
              categoryId
            )
        );
        expect(
          (yield* request("/transactions/link", "POST", {
            firstTransactionId: first,
            secondTransactionId: foreign,
          })).status
        ).toBe(404);
        yield* observe("18014398509481986.22");
        const pair = { firstTransactionId: first, secondTransactionId: second };
        expect((yield* request("/transactions/link", "POST", pair)).status).toBe(200);
        yield* observe("9007199254740993.11");
        expect(
          (yield* request("/transactions/" + first, "PUT", {
            expectedRevision: 0,
            changes: { money: { amount: "90.75", currency: "USD" } },
          })).status
        ).toBe(200);
        yield* observe("90.75");
        yield* Effect.sleep("750 millis");
        expect(
          (yield* request("/transactions/" + second, "PUT", {
            expectedRevision: 0,
            changes: { money: { amount: "20.01", currency: "USD" } },
          })).status
        ).toBe(200);
        yield* observe("20.01");
        expect(
          (yield* request("/transactions/" + first, "PUT", {
            expectedRevision: 1,
            changes: { notes: "select original member" },
          })).status
        ).toBe(200);
        yield* observe("90.75");
        expect((yield* request("/transactions/unlink", "POST", pair)).status).toBe(200);
        yield* observe("110.76");
      })
  );
  test.effect(
    "independent Currency caps share a Category and a capacity failure rolls back the batch",
    () =>
      Effect.gen(function* () {
        const db = yield* nativeTransactionJourney;

        const calls = ["USD", "XAF"].map((currency, index) => ({
          callId: index === 0 ? alice.session : bob.session,
          operation: "budgets.createBudget",
          input: { payload: { categoryId: category, cap: { amount: "1", currency } } },
        }));

        const submit = (): Effect.Effect<Response> =>
          native(() =>
            db.send(
              new Request("https://api.fidyapp.com/operations/atomic-batch", {
                method: "POST",
                headers: {
                  origin: "https://app.fidyapp.com",
                  cookie: "__Host-fidy_session=" + alice.bearer,
                  "Fidy-Session-Binding": alice.session,
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  calls,
                }),
              })
            )
          );

        const accepted = yield* submit();
        expect(accepted.status).toBe(200);
        expect(yield* readJson(accepted)).toMatchObject({
          data: {
            results: [
              { output: { data: { cap: { currency: "USD" } } } },
              { output: { data: { cap: { currency: "XAF" } } } },
            ],
          },
        });
        yield* native(() => db.exec("DELETE FROM budgets"));
        yield* native(() =>
          db.exec(
            "INSERT INTO budgets(id,user_id,category_id,category_revision,currency,cap,created_at_ms,updated_at_ms) SELECT printf('20000000-0000-4000-8000-%012d',key),?,?,'co-1',value,'1',0,0 FROM json_each(?)",
            alice.user,
            category,
            JSON.stringify(Currency.literals.slice(0, 127))
          )
        );
        const refused = yield* submit();
        expect(refused.status).toBe(400);
        expect(yield* readJson(refused)).toMatchObject({
          error: { failedCallIndex: 1, operation: "budgets.createBudget" },
        });
        expect(
          yield* native(() =>
            db.exec(
              "SELECT count(*) AS n FROM audit_entries WHERE outcome='validation_failed' AND operation='budgets.createBudget'"
            )
          )
        ).toEqual([{ n: 1 }]);
        expect(yield* native(() => db.exec("SELECT count(*) AS budgets FROM budgets"))).toEqual([
          { budgets: 127 },
        ]);
      })
  );
  test.effect(
    "materializes all 128 supported Budgets and refuses a concurrent create at capacity",
    () =>
      Effect.gen(function* () {
        const db = yield* nativeTransactionJourney;
        const currencies = Currency.literals.slice(0, 127);
        yield* native(() =>
          db.exec(
            "INSERT INTO budgets(id,user_id,category_id,category_revision,currency,cap,created_at_ms,updated_at_ms) SELECT printf('20000000-0000-4000-8000-%012d',key),?,?,'co-1',value,'1',0,0 FROM json_each(?)",
            alice.user,
            category,
            JSON.stringify(currencies)
          )
        );

        const create = (currency: string): Effect.Effect<Response> =>
          native(() =>
            db.send(
              new Request("https://api.fidyapp.com/budgets", {
                method: "POST",
                headers: {
                  origin: "https://app.fidyapp.com",
                  cookie: "__Host-fidy_session=" + alice.bearer,
                  "Fidy-Session-Binding": alice.session,
                  "content-type": "application/json",
                },
                body: JSON.stringify({ categoryId: category, cap: { amount: "1", currency } }),
              })
            )
          );

        const attempts = yield* Effect.all([create("USD"), create("XAF")], { concurrency: 2 });
        expect(
          attempts.map((response) => response.status).sort((left, right) => left - right)
        ).toEqual([201, 400]);
        const list = yield* native(() => db.browser(0, "/budgets"));
        expect(list.status).toBe(200);

        const caps = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.Array(Schema.toCodecJson(Budget)) })
        )(yield* readJson(list));

        expect(caps.data).toHaveLength(128);
        expect(caps.data.map((budget) => budget.cap.currency)).toEqual(
          caps.data.map((budget) => budget.cap.currency).toSorted()
        );

        const workspace = yield* native(() =>
          db.browser(0, "/budget-status?timeZone=America%2FBogota")
        );

        expect(workspace.status).toBe(200);

        const report = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.Struct({ statuses: Schema.Array(Schema.Unknown) }) })
        )(yield* readJson(workspace));

        expect(report.data.statuses).toHaveLength(128);
      })
  );
});
