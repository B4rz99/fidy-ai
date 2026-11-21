import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { expect } from "vitest";
import {
  alice,
  bob,
  category,
  nativeTransactionJourney,
  seedNativePAT,
} from "../financial-user-store.test-fixture";
import { native } from "../user-store.test-fixture";
import { canonicalRequestProtection } from "../canonical-admission/contract";

const successfulBody = (response: Response): Effect.Effect<string> => {
  expect(response.status).toBe(200);

  return native(() => response.text());
};

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("a capture in the same atomic batch sees the original keyword rules", () =>
    Effect.gen(function* () {
      const journey = yield* nativeTransactionJourney;

      const response = yield* native(() =>
        journey.send(
          new Request("https://api.fidyapp.com/operations/atomic-batch", {
            method: "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: "__Host-fidy_session=" + alice.bearer,
              "Fidy-Session-Binding": alice.session,
              "Fidy-Retry-Key": "unused-browser-key",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              calls: [
                {
                  callId: "10000000-0000-4000-8000-000000000011",
                  operation: "categories.createKeywordRule",
                  input: {
                    payload: {
                      keyword: "Café",
                      categoryId: "10000000-0000-4000-8000-000000000003",
                    },
                  },
                },
                {
                  callId: "10000000-0000-4000-8000-000000000012",
                  operation: "transactions.createTransaction",
                  input: {
                    payload: {
                      money: { amount: "42", currency: "COP" },
                      direction: "outflow",
                      counterparty: "Café del centro",
                      occurredAt: "2023-10-01T00:00:00.000Z",
                    },
                  },
                },
              ],
            }),
          })
        )
      );

      const body = yield* native(() => response.json());
      expect(
        yield* native(() =>
          journey.exec("SELECT count(*) AS receipts FROM canonical_request_receipts")
        )
      ).toEqual([{ receipts: 0 }]);
      expect({ status: response.status, body }).toMatchObject({
        status: 200,
        body: {
          data: {
            results: [
              {
                callId: "10000000-0000-4000-8000-000000000011",
                output: { data: { keyword: "cafe" } },
              },
              {
                callId: "10000000-0000-4000-8000-000000000012",
                output: { data: { categoryId: category } },
              },
            ],
          },
        },
      });
    })
  );
  test.effect(
    "rolls back every child and its accounting on an interrupted commit, then recovers a lost response under current authority",
    () =>
      Effect.gen(function* () {
        const db = yield* nativeTransactionJourney;
        const token = "fin_abcdefgh_" + "x".repeat(43);
        yield* seedNativePAT({
          db,
          userId: alice.user,
          token,
          scopes: ["write", "dashboard"],
          current: yield* Clock.currentTimeMillis,
        });

        const call = (calls: ReadonlyArray<unknown>, key = "original"): Effect.Effect<Response> =>
          native(() =>
            db.send(
              new Request("https://api.fidyapp.com/operations/atomic-batch", {
                method: "POST",
                headers: {
                  authorization: "Bearer " + token,
                  "content-type": "application/json",
                  "Fidy-Retry-Key": key,
                },
                body: JSON.stringify({ calls }),
              })
            )
          );

        const first = {
          callId: alice.user,
          operation: "budgets.createBudget",
          input: { payload: { categoryId: category, cap: { amount: "19", currency: "COP" } } },
        };

        const second = { callId: bob.user, operation: "dashboard.initializeDashboard", input: {} };

        const counts = (): Effect.Effect<ReadonlyArray<unknown>> =>
          native(() =>
            db.exec(
              "SELECT (SELECT count(*) FROM budgets) AS budgets,(SELECT count(*) FROM user_documents WHERE kind='dashboard') AS dashboards,(SELECT count(*) FROM audit_entries WHERE record_type='credential_call' AND outcome='accepted') AS accepted,(SELECT count(*) FROM commercial_allowance_consumptions) AS charges,(SELECT count(*) FROM canonical_request_receipts) AS receipts"
            )
          );

        yield* native(() =>
          db.exec(
            "CREATE TRIGGER interrupt_child_audit BEFORE INSERT ON audit_entries WHEN NEW.operation='dashboard.initializeDashboard' AND NEW.record_type='credential_call' BEGIN SELECT RAISE(IGNORE); END"
          )
        );
        expect((yield* call([first, second])).status).toBe(503);
        expect(yield* counts()).toEqual([
          { budgets: 0, dashboards: 0, accepted: 0, charges: 0, receipts: 0 },
        ]);
        yield* native(() => db.exec("DROP TRIGGER interrupt_child_audit"));

        const [committed, retry] = yield* Effect.all(
          [call([first, second]), call([first, second])],
          {
            concurrency: 2,
          }
        );

        expect([committed.status, retry.status]).toEqual([200, 200]);
        const bytes = yield* native(() => committed.text());
        expect(yield* native(() => retry.text())).toBe(bytes);
        expect(yield* counts()).toEqual([
          { budgets: 1, dashboards: 1, accepted: 4, charges: 1, receipts: 1 },
        ]);
        const own = yield* native(() => db.browser(0, "/budgets"));
        expect(yield* native(() => own.json())).toMatchObject({ data: [{ categoryId: category }] });
        expect(
          yield* native(() =>
            db.exec(
              "SELECT operation,count(*) AS calls FROM audit_entries WHERE record_type='credential_call' AND outcome='accepted' GROUP BY operation ORDER BY operation"
            )
          )
        ).toEqual([
          { operation: "budgets.createBudget", calls: 1 },
          { operation: "dashboard.initializeDashboard", calls: 1 },
          { operation: "operations.executeAtomicBatch", calls: 2 },
        ]);
        expect((yield* call([second, first])).status).toBe(400);
        yield* native(() => db.exec("UPDATE pats SET scopes_json='[\"write\"]'"));
        const denied = yield* call([first, second]);
        expect(denied.status).toBe(403);
        expect(yield* native(() => denied.text())).not.toBe(bytes);
        yield* native(() => db.exec("UPDATE pats SET revoked_at_ms=issued_at_ms"));
        expect((yield* call([first, second])).status).toBe(401);
        expect(yield* counts()).toEqual([
          { budgets: 1, dashboards: 1, accepted: 4, charges: 1, receipts: 1 },
        ]);
      })
  );
  test.effect(
    "rejects an ineligible child and an attempted foreign edit with no partial domain changes",
    Effect.fnUntraced(function* () {
      const db = yield* nativeTransactionJourney;

      const send = (
        subject: typeof alice,
        path: string,
        ...[method, body]: [method: string, body: unknown]
      ): Effect.Effect<Response> =>
        native(() =>
          db.send(
            new Request("https://api.fidyapp.com" + path, {
              method,
              headers: {
                origin: "https://app.fidyapp.com",
                cookie: "__Host-fidy_session=" + subject.bearer,
                "Fidy-Session-Binding": subject.session,
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            })
          )
        );

      const keyword = { keyword: "reserved", categoryId: category };
      const created = yield* send(bob, "/category-keyword-rules", "POST", keyword);

      const foreign = (yield* Schema.decodeUnknownEffect(
        Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })
      )(yield* native(() => created.json()))).data.id;

      const first = {
        callId: alice.user,
        operation: "categories.createKeywordRule",
        input: { payload: keyword },
      };

      yield* Effect.forEach(
        [
          { operation: "categories.listKeywordRules", input: {}, code: "validation_failed" },
          {
            operation: "operations.executeAtomicBatch",
            input: { payload: { calls: [] } },
            code: "validation_failed",
          },
          {
            operation: "categories.deleteKeywordRule",
            input: { params: { id: foreign } },
            code: "not_found",
          },
        ],
        Effect.fnUntraced(function* (child) {
          const refusal = yield* send(alice, "/operations/atomic-batch", "POST", {
            calls: [first, { callId: bob.user, operation: child.operation, input: child.input }],
          });

          expect(refusal.status).toBe(400);
          expect(yield* native(() => refusal.json())).toMatchObject({
            error: { failedCallIndex: 1, operation: child.operation, code: child.code },
          });
        }),
        { discard: true }
      );

      const own = yield* native(() => db.browser(0, "/category-keyword-rules"));
      const other = yield* native(() => db.browser(1, "/category-keyword-rules"));
      expect(yield* native(() => own.json())).toMatchObject({ data: [] });
      expect(yield* native(() => other.json())).toMatchObject({
        data: [{ id: foreign, keyword: "reserved" }],
      });
      expect(
        yield* native(() =>
          db.exec(
            "SELECT operation,outcome FROM audit_entries WHERE operation='categories.deleteKeywordRule'"
          )
        )
      ).toEqual([{ operation: "categories.deleteKeywordRule", outcome: "not_found" }]);
    })
  );
  test.effect(
    "PAT retry keys belong to the authenticated User and expire at the original 24-hour deadline",
    Effect.fnUntraced(function* () {
      const db = yield* nativeTransactionJourney;

      const capture = {
        calls: [
          {
            callId: alice.session,
            operation: "transactions.createTransaction",
            input: {
              payload: {
                money: { amount: "12", currency: "COP" },
                direction: "outflow",
                categoryId: category,
                occurredAt: "2025-01-01T00:00:00Z",
              },
            },
          },
        ],
      };

      const aliceToken = "fin_abcdefgh_" + "x".repeat(43);
      const bobToken = "fin_bcdefghi_" + "y".repeat(43);

      yield* Effect.forEach(
        [
          [alice.user, aliceToken],
          [bob.user, bobToken],
        ] as const,
        Effect.fnUntraced(function* ([userId, token]) {
          yield* native(() =>
            db
              .owner(userId)
              .exec(
                "UPDATE users SET trial_started_at_ms=created_at_ms,trial_ends_at_ms=created_at_ms+604800000"
              )
          );
          yield* native(() =>
            db
              .owner(userId)
              .exec(
                "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES(?,?,'processing_grant',1)",
                userId,
                userId
              )
          );
          yield* seedNativePAT({
            db,
            userId,
            token,
            scopes: ["write"],
            current: yield* Clock.currentTimeMillis,
          });
        }),
        { discard: true }
      );

      const submit = (token: string): Effect.Effect<string> =>
        native(() =>
          db.send(
            new Request("https://api.fidyapp.com/operations/atomic-batch", {
              method: "POST",
              headers: {
                authorization: "Bearer " + token,
                "content-type": "application/json",
                "Fidy-Retry-Key": "same-pat-key",
              },
              body: JSON.stringify({
                calls: [
                  ...capture.calls,
                  {
                    callId: bob.session,
                    operation: "identity.updateUserPreferences",
                    input: { payload: { locale: "es-CO", timeZone: "America/Lima" } },
                  },
                ],
              }),
            })
          )
        ).pipe(Effect.flatMap(successfulBody));

      const original = yield* submit(aliceToken);
      expect(yield* submit(bobToken)).not.toBe(original);
      yield* native(() =>
        db.exec("UPDATE canonical_request_receipts SET accepted_at_ms=accepted_at_ms-86300000")
      );

      const before = yield* native(() =>
        db.exec("SELECT accepted_at_ms FROM canonical_request_receipts")
      );

      expect(yield* submit(aliceToken)).toBe(original);
      expect(
        yield* native(() => db.exec("SELECT accepted_at_ms FROM canonical_request_receipts"))
      ).toEqual(before);
      const originalWindowMs = 86_400_000;
      yield* native(() => db.exec("UPDATE canonical_request_buckets SET virtual_at_ms=0"));
      yield* native(() =>
        db.exec("CREATE TABLE fixture_receipt_boundary(remaining_ms INTEGER NOT NULL)")
      );
      yield* native(() => db.exec("INSERT INTO fixture_receipt_boundary VALUES(1)"));
      yield* native(() =>
        db.exec(`CREATE TRIGGER fixture_receipt_boundary_at_admission AFTER UPDATE ON canonical_request_buckets WHEN NEW.virtual_at_ms>0
          BEGIN UPDATE canonical_request_receipts SET accepted_at_ms=NEW.virtual_at_ms-${canonicalRequestProtection.intervalMs}-${originalWindowMs}+(SELECT remaining_ms FROM fixture_receipt_boundary); END`)
      );
      expect(yield* submit(aliceToken)).toBe(original);
      yield* native(() => db.exec("UPDATE fixture_receipt_boundary SET remaining_ms=0"));
      yield* native(() => db.exec("UPDATE canonical_request_buckets SET virtual_at_ms=0"));
      expect(yield* submit(aliceToken)).not.toBe(original);
      expect(
        yield* native(() => db.exec("SELECT count(*) AS movements FROM transactions"))
      ).toEqual([{ movements: 2 }]);
      expect(
        yield* native(() =>
          db.owner(bob.user).exec("SELECT count(*) AS movements FROM transactions")
        )
      ).toEqual([{ movements: 1 }]);
    })
  );
});
