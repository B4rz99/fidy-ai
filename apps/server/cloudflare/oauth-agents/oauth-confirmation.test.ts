import { approveFirstPartyOperation } from "./oauth-first-party.test-fixture";
import { categoryIds } from "../../src/core/categories/contract";
import { Clock, Effect, Option, Schema } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import {
  TokenFixture,
  approvedFixture,
  exchangeFixture,
  mcpFixture,
  nativeConfirmationCall,
  nativePeer,
  pendingBudgetDeletion,
  reviewBudgetDeletion,
  revokeFixtureConsent,
  wait,
} from "./oauth-ingress.test-fixture";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("reviews an exact Budget deletion natively and consumes client acceptance with its mutation once", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["read", "write"],
        lifetimeDays: 7,
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
      yield* approveFirstPartyOperation(fixture, pending.result.requestState);
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
              "SELECT count(*) FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE operation = 'budgets.deleteBudget' AND outcome = 'accepted'"
            )
            .first<number>("count(*)")
        )
      ).toBe(1);
    })
  ));

const explicitNativeAccept = { action: "accept", content: { confirm: true } };

const refusingNativeResponses: ReadonlyArray<
  Readonly<{ name: string; responses: ReadonlyArray<Schema.Json> }>
> = [
  { name: "decline and cancellation", responses: [{ action: "decline" }, { action: "cancel" }] },
  {
    name: "false and missing confirmation",
    responses: [{ action: "accept", content: { confirm: false } }, { action: "accept" }],
  },
  {
    name: "empty and mistyped confirmation",
    responses: [
      { action: "accept", content: {} },
      { action: "accept", content: { confirm: "true" } },
    ],
  },
];

it.each(refusingNativeResponses)(
  "refuses $name without deletion or acceptance and fences each refused intent",
  ({ responses }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* pendingBudgetDeletion();
        yield* approveFirstPartyOperation(fixture, fixture.reference);
        let review = { reference: fixture.reference, call: fixture.call };
        for (const [index, response] of responses.entries()) {
          if (index > 0) review = yield* reviewBudgetDeletion(fixture);
          const declined = yield* wait(review.call(response));
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
                  "SELECT count(*) FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE operation = 'budgets.deleteBudget' AND outcome = 'accepted'"
                )
                .first<number>("count(*)")
            )
          ).toBe(0);
          const later = yield* wait(review.call(explicitNativeAccept));
          expect(yield* wait(later.json())).toMatchObject({ result: { isError: true } });
        }
      })
    )
);

it("rejects changed canonical input and stale Budget revisions without consuming a valid intent", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* pendingBudgetDeletion();
      yield* approveFirstPartyOperation(fixture, fixture.reference);
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
      yield* approveFirstPartyOperation(fixture, fixture.reference);
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
      yield* approveFirstPartyOperation(fixture, fixture.reference);
      yield* wait(
        fixture.db
          .prepare(
            "CREATE TRIGGER fail_native_audit BEFORE INSERT ON audit_entries WHEN NEW.record_type='credential_call' AND NEW.operation = 'budgets.deleteBudget' AND NEW.outcome = 'accepted' BEGIN SELECT RAISE(ABORT, 'test_native_audit_failure'); END"
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
              "SELECT count(*) FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE operation = 'budgets.deleteBudget' AND outcome = 'accepted'"
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
      yield* approveFirstPartyOperation(fixture, fixture.reference);
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
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
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
      const legacyReference = yield* wait(
        fixture.db
          .prepare(
            "SELECT reference FROM oauth_operation_intents WHERE reference <> ? ORDER BY created_at_ms DESC LIMIT 1"
          )
          .bind(fixture.reference)
          .first<string>("reference")
      );
      yield* approveFirstPartyOperation(
        fixture,
        Option.getOrThrow(Option.fromNullOr(legacyReference))
      );
      const reviewedAt = yield* Clock.currentTimeMillis;
      yield* wait(vi.advanceTimersByTimeAsync(6_000));
      expect((yield* Clock.currentTimeMillis) - reviewedAt).toBeGreaterThanOrEqual(6_000);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM budgets WHERE id = ?")
            .bind(fixture.id)
            .first<number>("count(*)")
        )
      ).toBe(1);
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
      yield* approveFirstPartyOperation(fixture, fixture.reference);
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
      yield* approveFirstPartyOperation(fixture, pending.result.requestState);
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
      yield* approveFirstPartyOperation(fixture, fixture.reference);
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
      yield* approveFirstPartyOperation(fixture, pending.result.requestState);
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
          yield* approveFirstPartyOperation(fixture, fixture.reference);
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
          yield* approveFirstPartyOperation(fixture, pending.result.requestState);
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
                .prepare(
                  "UPDATE oauth_credentials AS oauth_credentials SET scopes_json = '[\"read\"]' WHERE kind='access'"
                )
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
                  "SELECT count(*) FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE operation = 'budgets.deleteBudget' AND outcome = 'accepted'"
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
        yield* approveFirstPartyOperation(fixture, fixture.reference);
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
