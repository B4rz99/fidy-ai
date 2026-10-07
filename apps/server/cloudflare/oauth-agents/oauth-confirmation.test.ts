import { categoryIds } from "../../src/core/categories/contract";
import { Clock, Effect, Option, Schema } from "effect";
import { nativeHostBridgeFile, runNativeHostFixture } from "./native-host.test-fixture";
import { afterEach, expect, it, vi } from "vitest";
import {
  type NativeFixture,
  type TestFailure,
  TokenFixture,
  approvedFixture,
  exchangeFixture,
  mcpFixture,
  nativeConfirmationCall,
  nativePeer,
  pendingBudgetDeletion,
  revokeFixtureConsent,
  transactionArguments,
  wait,
} from "./oauth-ingress.test-fixture";

afterEach(() => vi.restoreAllMocks());

it("reviews an exact Budget deletion natively and consumes client acceptance with its mutation once", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["read", "write"],
        lifetimeDays: 7,
        auditMigration: true,
      });
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const bearer = token.access_token;
      const created = yield* wait(
        mcpFixture({
          retryKey: Option.none(),
          ...fixture,
          bearer,
          method: "tools/call",
          name: "budgets.createBudget",
          args: {
            payload: { categoryId: categoryIds.mercado, cap: { amount: "1000", currency: "COP" } },
          },
        })
      );
      const creation = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          result: Schema.Struct({
            structuredContent: Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }),
          }),
        })
      )(yield* wait(created.json()));
      const id = creation.result.structuredContent.data.id;
      const args = { params: { id } };
      const review = yield* wait(
        nativeConfirmationCall({
          fixture: { ...fixture, bearer },
          params: { name: "budgets.deleteBudget", arguments: args },
          name: "budgets.deleteBudget",
        })
      );
      const pending = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          result: Schema.Struct({ requestState: Schema.String, inputRequests: Schema.JsonObject }),
        })
      )(yield* wait(review.json()));
      expect(pending.result.inputRequests).toMatchObject({
        review: {
          method: "elicitation/create",
          params: {
            mode: "form",
            requestedSchema: { required: ["confirm"], properties: { confirm: { default: false } } },
          },
        },
      });
      expect(pending.result.inputRequests["review"]).toBeDefined();
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM budgets WHERE id = ?")
            .bind(id)
            .first<number>("count(*)")
        )
      ).toBe(1);
      const resume = {
        name: "budgets.deleteBudget",
        arguments: args,
        requestState: pending.result.requestState,
        inputResponses: { review: { action: "accept", content: { confirm: true } } },
      };
      const accepted = yield* wait(
        nativeConfirmationCall({
          fixture: { ...fixture, bearer },
          params: resume,
          name: "budgets.deleteBudget",
        })
      );
      expect(yield* wait(accepted.json())).toMatchObject({ result: { isError: false } });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM budgets WHERE id = ?")
            .bind(id)
            .first<number>("count(*)")
        )
      ).toBe(0);
      const replay = yield* wait(
        nativeConfirmationCall({
          fixture: { ...fixture, bearer },
          params: resume,
          name: "budgets.deleteBudget",
        })
      );
      expect(yield* wait(replay.json())).toMatchObject({ result: { isError: true } });
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM pat_audit WHERE operation = 'budgets.deleteBudget' AND outcome = 'accepted'"
            )
            .first<number>("count(*)")
        )
      ).toBe(1);
    })
  ));

const explicitNativeAccept = { action: "accept", content: { confirm: true } };

const refusingNativeResponses: ReadonlyArray<Schema.Json> = [
  { action: "decline" },
  { action: "cancel" },
  { action: "accept", content: { confirm: false } },
  { action: "accept" },
  { action: "accept", content: {} },
  { action: "accept", content: { confirm: "true" } },
];

it.each(refusingNativeResponses)(
  "refuses native response %j without deleting the reviewed Budget or recording acceptance",
  (response) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* pendingBudgetDeletion();
        const declined = yield* wait(fixture.call(response));
        expect(yield* wait(declined.json())).toMatchObject({ result: { isError: true } });
        expect(
          yield* wait(
            fixture.db
              .prepare("SELECT count(*) FROM budgets WHERE id = ?")
              .bind(fixture.id)
              .first<number>("count(*)")
          )
        ).toBe(1);
        expect(
          yield* wait(
            fixture.db
              .prepare(
                "SELECT count(*) FROM pat_audit WHERE operation = 'budgets.deleteBudget' AND outcome = 'accepted'"
              )
              .first<number>("count(*)")
          )
        ).toBe(0);
        const later = yield* wait(fixture.call(explicitNativeAccept));
        expect(yield* wait(later.json())).toMatchObject({ result: { isError: true } });
      })
    )
);

it("rejects changed canonical input and stale Budget revisions without consuming a valid intent", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* pendingBudgetDeletion();
      const changed = yield* wait(
        fixture.call(explicitNativeAccept, { params: { id: fixture.id }, confirm: true })
      );
      expect(yield* wait(changed.json())).toMatchObject({ result: { isError: true } });
      yield* wait(
        fixture.db.prepare("UPDATE budgets SET cap = '2000' WHERE id = ?").bind(fixture.id).run()
      );
      const stale = yield* wait(fixture.call(explicitNativeAccept));
      expect(yield* wait(stale.json())).toMatchObject({ result: { isError: true } });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT cap FROM budgets WHERE id = ?")
            .bind(fixture.id)
            .first<string>("cap")
        )
      ).toBe("2000");
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_operation_intents WHERE reference = ?")
            .bind(fixture.reference)
            .first<number>("count(*)")
        )
      ).toBe(1);
    })
  ));

it("rejects expired native intents and bounds outstanding intents per User", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* pendingBudgetDeletion();
      const current = yield* Clock.currentTimeMillis;
      yield* wait(
        fixture.db
          .prepare(
            "UPDATE oauth_operation_intents SET created_at_ms = ?, expires_at_ms = ? WHERE reference = ?"
          )
          .bind(current - 300001, current - 1, fixture.reference)
          .run()
      );
      const expired = yield* wait(fixture.call(explicitNativeAccept));
      expect(yield* wait(expired.json())).toMatchObject({ result: { isError: true } });
      for (let index = 0; index < 5; index += 1) {
        const review = yield* wait(
          nativeConfirmationCall({
            fixture,
            params: {
              name: "budgets.deleteBudget",
              arguments: { params: { id: fixture.id } },
            },
            name: "budgets.deleteBudget",
          })
        );
        expect(yield* wait(review.json())).toHaveProperty("result.requestState");
      }
      const overflow = yield* wait(
        nativeConfirmationCall({
          fixture,
          params: {
            name: "budgets.deleteBudget",
            arguments: { params: { id: fixture.id } },
          },
          name: "budgets.deleteBudget",
        })
      );
      expect(yield* wait(overflow.json())).toMatchObject({ result: { isError: true } });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_operation_intents")
            .first<number>("count(*)")
        )
      ).toBe(5);
    })
  ));

it("rolls back native intent consumption with failed Audit and allows only one concurrent successful deletion", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* pendingBudgetDeletion();
      yield* wait(
        fixture.db
          .prepare(
            "CREATE TRIGGER fail_native_audit BEFORE INSERT ON pat_audit WHEN NEW.operation = 'budgets.deleteBudget' AND NEW.outcome = 'accepted' BEGIN SELECT RAISE(ABORT, 'test_native_audit_failure'); END"
          )
          .run()
      );
      const failed = yield* wait(fixture.call(explicitNativeAccept));
      expect(yield* wait(failed.json())).toMatchObject({ result: { isError: true } });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_operation_intents WHERE reference = ?")
            .bind(fixture.reference)
            .first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM budgets WHERE id = ?")
            .bind(fixture.id)
            .first<number>("count(*)")
        )
      ).toBe(1);
      yield* wait(fixture.db.prepare("DROP TRIGGER fail_native_audit").run());
      const raced = yield* wait(
        Promise.all([fixture.call(explicitNativeAccept), fixture.call(explicitNativeAccept)])
      );
      const replies = yield* wait(Promise.all(raced.map((reply) => reply.json())));
      const parsed = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ result: Schema.Struct({ isError: Schema.Boolean }) }))
      )(replies);
      expect(parsed.filter(({ result }) => !result.isError)).toHaveLength(1);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM pat_audit WHERE operation = 'budgets.deleteBudget' AND outcome = 'accepted'"
            )
            .first<number>("count(*)")
        )
      ).toBe(1);
    })
  ));

it("resumes the original legacy native tool call after server-requested form acceptance", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* pendingBudgetDeletion();
      const headers = {
        authorization: `Bearer ${fixture.bearer}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };
      const initialized = yield* wait(
        fixture.send("/mcp", {
          method: "POST",
          headers: { ...headers, accept: "text/event-stream, application/json" },
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            jsonrpc: "2.0",
            id: "init-native-review",
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: { elicitation: { form: {} } },
              clientInfo: { name: "native-form-fixture", version: "1" },
            },
          }),
        })
      );
      const session = initialized.headers.get("mcp-session-id") ?? "";
      // Codex's legacy transport consumes the initialization frame and cancels that HTTP body;
      // this completed response must not retire the independently retained native session.
      const initializedReader = Option.getOrThrow(Option.fromNullOr(initialized.body)).getReader();
      yield* wait(initializedReader.read());
      yield* wait(initializedReader.cancel());
      const sessionHeaders = {
        ...headers,
        "mcp-protocol-version": "2025-11-25",
        "mcp-session-id": session,
      };
      const notified = yield* wait(
        fixture.send("/mcp", {
          method: "POST",
          headers: sessionHeaders,
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            jsonrpc: "2.0",
            method: "notifications/initialized",
          }),
        })
      );
      expect(notified.status).toBe(202);
      yield* wait(notified.text());
      const invoked = yield* wait(
        fixture.send("/mcp", {
          method: "POST",
          headers: {
            ...sessionHeaders,
            "mcp-method": "tools/call",
            "mcp-name": "budgets.deleteBudget",
          },
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            jsonrpc: "2.0",
            id: "delete-legacy",
            method: "tools/call",
            params: { name: "budgets.deleteBudget", arguments: { params: { id: fixture.id } } },
          }),
        })
      );
      expect(invoked.headers.get("content-type")).toContain("text/event-stream");
      const reader = Option.getOrThrow(Option.fromNullOr(invoked.body)).getReader();
      const requested = yield* wait(reader.read());
      const requestedBytes = yield* Schema.decodeUnknownEffect(Schema.Uint8Array)(requested.value);
      const data =
        new TextDecoder()
          .decode(requestedBytes)
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length) ?? "";
      const form = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            id: Schema.Union([Schema.String, Schema.Finite]),
            method: Schema.Literal("elicitation/create"),
          })
        )
      )(data);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM budgets WHERE id = ?")
            .bind(fixture.id)
            .first<number>("count(*)")
        )
      ).toBe(1);
      yield* Effect.sleep("6 seconds");
      const replied = yield* wait(
        fixture.send("/mcp", {
          method: "POST",
          headers: sessionHeaders,
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            jsonrpc: "2.0",
            id: form.id,
            result: explicitNativeAccept,
          }),
        })
      );
      yield* wait(replied.text());
      const completion = yield* wait(reader.read());
      const completionBytes = yield* Schema.decodeUnknownEffect(Schema.Uint8Array)(
        completion.value
      );
      const completedData =
        new TextDecoder()
          .decode(completionBytes)
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length) ?? "";
      const result = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            id: Schema.Literal("delete-legacy"),
            result: Schema.Struct({ isError: Schema.Boolean }),
          })
        )
      )(completedData);
      expect(result.result.isError).toBe(false);
      yield* wait(reader.cancel());
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM budgets WHERE id = ?")
            .bind(fixture.id)
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));

it("reviews the complete ordered sensitive batch and commits all children once, not a substituted batch", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* pendingBudgetDeletion();
      const name = "operations.executeAtomicBatch";
      const calls: ReadonlyArray<Schema.Json> = [
        {
          callId: "20000000-0000-4000-8000-000000000031",
          operation: "budgets.deleteBudget",
          input: { params: { id: fixture.id } },
        },
        {
          callId: "20000000-0000-4000-8000-000000000032",
          operation: "categories.createKeywordRule",
          input: { payload: { keyword: "native batch", categoryId: categoryIds.mercado } },
        },
      ];
      const args = { payload: { calls } };
      const review = yield* wait(
        nativeConfirmationCall({ fixture, params: { name, arguments: args }, name })
      );
      const pending = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ result: Schema.Struct({ requestState: Schema.String }) })
      )(yield* wait(review.json()));
      const resume = (argumentsOverride: Schema.Json): Promise<Response> =>
        nativeConfirmationCall({
          fixture,
          params: {
            name,
            arguments: argumentsOverride,
            requestState: pending.result.requestState,
            inputResponses: { review: explicitNativeAccept },
          },
          name,
        });
      const changed = yield* wait(resume({ payload: { calls: [...calls].reverse() } }));
      expect(yield* wait(changed.json())).toMatchObject({ result: { isError: true } });
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM keyword_rules").first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM budgets WHERE id = ?")
            .bind(fixture.id)
            .first<number>("count(*)")
        )
      ).toBe(1);
      const accepted = yield* wait(resume(args));
      expect(yield* wait(accepted.json())).toMatchObject({ result: { isError: false } });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM keyword_rules WHERE keyword = 'native batch'")
            .first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM budgets WHERE id = ?")
            .bind(fixture.id)
            .first<number>("count(*)")
        )
      ).toBe(0);
      const replay = yield* wait(resume(args));
      expect(yield* wait(replay.json())).toMatchObject({ result: { isError: true } });
    })
  ));

it("reviews and applies an exact Budget update without accepting a changed cap", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* pendingBudgetDeletion();
      const name = "budgets.updateBudget";
      const args = {
        params: { id: fixture.id },
        payload: { categoryId: categoryIds.mercado, cap: { amount: "2500", currency: "COP" } },
      };
      const review = yield* wait(
        nativeConfirmationCall({ fixture, params: { name, arguments: args }, name })
      );
      const pending = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ result: Schema.Struct({ requestState: Schema.String }) })
      )(yield* wait(review.json()));
      const changed = yield* wait(
        nativeConfirmationCall({
          fixture,
          params: {
            name,
            arguments: {
              ...args,
              payload: { ...args.payload, cap: { amount: "9999", currency: "COP" } },
            },
            requestState: pending.result.requestState,
            inputResponses: { review: explicitNativeAccept },
          },
          name,
        })
      );
      expect(yield* wait(changed.json())).toMatchObject({ result: { isError: true } });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT cap FROM budgets WHERE id = ?")
            .bind(fixture.id)
            .first<string>("cap")
        )
      ).toBe("1000");
      const resumed = yield* wait(
        nativeConfirmationCall({
          fixture,
          params: {
            name,
            arguments: args,
            requestState: pending.result.requestState,
            inputResponses: { review: explicitNativeAccept },
          },
          name,
        })
      );
      expect(yield* wait(resumed.json())).toMatchObject({ result: { isError: false } });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT cap FROM budgets WHERE id = ?")
            .bind(fixture.id)
            .first<string>("cap")
        )
      ).toBe("2500");
    })
  ));

it.each(["single", "batch"] as const)(
  "rechecks live authority while consuming native evidence in the protected %s unit",
  (unit) =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const changed of ["grant", "consent", "scope"] as const) {
          const fixture = yield* pendingBudgetDeletion();
          const name = unit === "single" ? "budgets.deleteBudget" : "operations.executeAtomicBatch";
          const calls: ReadonlyArray<Schema.Json> = [
            {
              callId: "20000000-0000-4000-8000-000000000033",
              operation: "budgets.deleteBudget",
              input: { params: { id: fixture.id } },
            },
            {
              callId: "20000000-0000-4000-8000-000000000034",
              operation: "categories.createKeywordRule",
              input: { payload: { keyword: "held native unit", categoryId: categoryIds.mercado } },
            },
          ];
          const args: Schema.Json =
            unit === "single" ? { params: { id: fixture.id } } : { payload: { calls } };
          const review = yield* wait(
            nativeConfirmationCall({
              fixture,
              params: { name, arguments: args },
              name,
            })
          );
          const pending = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ result: Schema.Struct({ requestState: Schema.String }) })
          )(yield* wait(review.json()));
          const held = fixture.holdMutationCommit();
          const accepted = nativeConfirmationCall({
            fixture,
            params: {
              name,
              arguments: args,
              requestState: pending.result.requestState,
              inputResponses: { review: explicitNativeAccept },
            },
            name,
          });
          yield* wait(held.waiting);
          if (changed === "grant") {
            yield* wait(
              fixture.db
                .prepare("UPDATE oauth_connections SET revoked_at_ms = ? WHERE id = ?")
                .bind(yield* Clock.currentTimeMillis, fixture.connectionId)
                .run()
            );
          }
          if (changed === "consent") {
            yield* revokeFixtureConsent(fixture.db);
          }
          if (changed === "scope") {
            yield* wait(
              fixture.db
                .prepare("UPDATE oauth_access_credentials SET scopes_json = '[\"read\"]'")
                .run()
            );
          }
          held.release();
          const response = yield* wait(accepted);
          yield* wait(held.settled);
          expect(yield* wait(response.json()), changed).toMatchObject({
            result: { isError: true },
          });
          expect(
            yield* wait(
              fixture.db
                .prepare("SELECT count(*) FROM budgets WHERE id = ?")
                .bind(fixture.id)
                .first<number>("count(*)")
            )
          ).toBe(1);
          expect(
            yield* wait(
              fixture.db.prepare("SELECT count(*) FROM keyword_rules").first<number>("count(*)")
            )
          ).toBe(0);
          expect(
            yield* wait(
              fixture.db
                .prepare(
                  "SELECT count(*) FROM pat_audit WHERE operation = 'budgets.deleteBudget' AND outcome = 'accepted'"
                )
                .first<number>("count(*)")
            )
          ).toBe(0);
          expect(
            yield* wait(
              fixture.db
                .prepare("SELECT count(*) FROM oauth_operation_intents WHERE reference = ?")
                .bind(pending.result.requestState)
                .first<number>("count(*)")
            )
          ).toBe(1);
        }
      })
    )
);

it.each([1, 2] as const)(
  "does not lend native intent authority to another connection of User %s",
  (userIndex) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* pendingBudgetDeletion();
        const peer = yield* nativePeer({ fixture, userIndex });
        expect(peer.connectionId).not.toBe(fixture.connectionId);
        const refused = yield* wait(
          nativeConfirmationCall({
            fixture: { send: fixture.send, bearer: peer.bearer },
            params: {
              name: "budgets.deleteBudget",
              arguments: { params: { id: fixture.id } },
              requestState: fixture.reference,
              inputResponses: { review: explicitNativeAccept },
            },
            name: "budgets.deleteBudget",
          })
        );
        expect(yield* wait(refused.json())).toMatchObject({ result: { isError: true } });
        expect(
          yield* wait(
            fixture.db
              .prepare("SELECT count(*) FROM budgets WHERE id = ?")
              .bind(fixture.id)
              .first<number>("count(*)")
          )
        ).toBe(1);
        expect(
          yield* wait(
            fixture.db
              .prepare("SELECT count(*) FROM oauth_operation_intents WHERE reference = ?")
              .bind(fixture.reference)
              .first<number>("count(*)")
          )
        ).toBe(1);
        const original = yield* wait(fixture.call(explicitNativeAccept));
        expect(yield* wait(original.json())).toMatchObject({ result: { isError: false } });
      })
    )
);

const nativeOwnerJourneys = [
  "categories.updateKeywordRule",
  "categories.deleteKeywordRule",
  "memory.revise",
  "memory.forget",
  "dashboard.applyDashboardEdit",
  "transactions.updateTransaction",
  "insights.markInsightRead",
  "insights.dismissInsight",
  "insights.markInsightDelivered",
] as const;

type NativeOwnerJourney = (typeof nativeOwnerJourneys)[number];

const ownerArgs = (input: Schema.Json): Schema.Json => input;

const insightJourneyArgs = (
  fixture: NativeFixture,
  name: NativeOwnerJourney
): Effect.Effect<Schema.Json, TestFailure> =>
  Effect.gen(function* () {
    const id = "40000000-0000-4000-8000-000000000988";
    yield* wait(
      fixture.db
        .prepare(
          "INSERT INTO insight_events(id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at,money_groups_json) VALUES(?,?,'weekly-summary','40000000-0000-4000-8000-000000000001',1,'CO','es-CO','America/Bogota','2026-10-03T12:00:00.000Z','[]')"
        )
        .bind(id, "10000000-0000-4000-8000-000000000001")
        .run()
    );
    return name === "insights.markInsightDelivered"
      ? ownerArgs({
          params: { id },
          payload: {
            sentAt: "2026-10-03T12:00:00.000Z",
            channel: "whatsapp",
            provider: "kapso",
            providerMessageId: "synthetic-native-delivery",
          },
        })
      : ownerArgs({ params: { id } });
  });

const ownerJourneyArgs = (
  fixture: NativeFixture,
  name: NativeOwnerJourney
): Effect.Effect<Schema.Json, TestFailure> =>
  Effect.gen(function* () {
    const ordinary = (operation: string, args: Schema.Json): Promise<Response> =>
      mcpFixture({
        retryKey: Option.none(),
        send: fixture.send,
        bearer: fixture.bearer,
        method: "tools/call",
        name: operation,
        args,
      });
    if (name.startsWith("categories.")) {
      const created = yield* wait(
        ordinary("categories.createKeywordRule", {
          payload: { keyword: "original native rule", categoryId: categoryIds.mercado },
        })
      );
      expect(yield* wait(created.json())).toMatchObject({ result: { isError: false } });
      const id = yield* wait(
        fixture.db.prepare("SELECT id FROM keyword_rules LIMIT 1").first<string>("id")
      );
      return name === "categories.deleteKeywordRule"
        ? ownerArgs({ params: { id } })
        : ownerArgs({
            params: { id },
            payload: { keyword: "replacement native rule", categoryId: categoryIds.restaurantes },
          });
    }
    if (name.startsWith("memory.")) {
      const created = yield* wait(
        ordinary("memory.remember", { payload: { text: "I plan monthly spending." } })
      );
      expect(yield* wait(created.json())).toMatchObject({ result: { isError: false } });
      const id = yield* wait(
        fixture.db.prepare("SELECT id FROM memories LIMIT 1").first<string>("id")
      );
      return name === "memory.forget"
        ? ownerArgs({ params: { id } })
        : ownerArgs({ params: { id }, payload: { text: "I plan weekly spending." } });
    }
    if (name === "dashboard.applyDashboardEdit") {
      const initialized = yield* wait(ordinary("dashboard.initializeDashboard", {}));
      expect(yield* wait(initialized.json())).toMatchObject({ result: { isError: false } });
      return ownerArgs({ payload: { op: "set-title", title: "Revisión nativa" } });
    }
    if (name === "transactions.updateTransaction") {
      const created = yield* wait(ordinary("transactions.createTransaction", transactionArguments));
      expect(yield* wait(created.json())).toMatchObject({ result: { isError: false } });
      const id = yield* wait(
        fixture.db.prepare("SELECT id FROM transactions LIMIT 1").first<string>("id")
      );
      return ownerArgs({
        params: { id },
        payload: { expectedRevision: 0, changes: { counterparty: "Corregida" } },
      });
    }
    return yield* insightJourneyArgs(fixture, name);
  });

it.each(nativeOwnerJourneys)(
  "native OAuth confirmation reaches the canonical owner for %s",
  (name) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* pendingBudgetDeletion(["write", "dashboard"]);
        const args = yield* ownerJourneyArgs(fixture, name);
        const review = yield* wait(
          nativeConfirmationCall({
            fixture,
            params: { name, arguments: args },
            name,
          })
        );
        const pending = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            result: Schema.Struct({
              requestState: Schema.String,
              inputRequests: Schema.Struct({
                review: Schema.Struct({
                  params: Schema.Struct({ message: Schema.NonEmptyString }),
                }),
              }),
            }),
          })
        )(yield* wait(review.json()));
        const accepted = yield* wait(
          nativeConfirmationCall({
            fixture,
            params: {
              name,
              arguments: args,
              requestState: pending.result.requestState,
              inputResponses: { review: explicitNativeAccept },
            },
            name,
          })
        );
        expect(yield* wait(accepted.json())).toMatchObject({ result: { isError: false } });
        expect(
          yield* wait(
            fixture.db
              .prepare(
                "SELECT count(*) FROM pat_audit WHERE operation = ? AND outcome = 'accepted'"
              )
              .bind(name)
              .first<number>("count(*)")
          )
        ).toBe(1);
        expect(
          yield* wait(
            fixture.db
              .prepare("SELECT count(*) FROM oauth_operation_intents WHERE reference = ?")
              .bind(pending.result.requestState)
              .first<number>("count(*)")
          )
        ).toBe(0);
      })
    )
);

it.skipIf(Option.isNone(nativeHostBridgeFile))(
  "serves the real confirmation seam to pinned native hosts",
  () => Effect.runPromise(runNativeHostFixture(pendingBudgetDeletion)),
  600000
);
