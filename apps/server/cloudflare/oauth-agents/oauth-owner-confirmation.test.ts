import { approveFirstPartyOperation } from "./oauth-first-party.test-fixture";
import { categoryIds } from "../../src/core/categories/contract";
import { Effect, Option, Schema } from "effect";
import { nativeHostBridgeFile, runNativeHostFixture } from "./native-host.test-fixture";
import { afterEach, expect, it, vi } from "vitest";
import {
  type NativeFixture,
  type TestFailure,
  mcpFixture,
  nativeConfirmationCall,
  pendingBudgetDeletion,
  transactionArguments,
  wait,
} from "./oauth-ingress.test-fixture";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const explicitNativeAccept = { action: "accept", content: { confirm: true } };

const nativeOwnerJourneys = [
  "recurringPlans.applyRecurringEdit",
  "categories.updateKeywordRule",
  "categories.deleteKeywordRule",
  "memory.revise",
  "memory.forget",
  "dashboard.applyDashboardEdit",
  "transactions.updateTransaction",
  "transactions.deleteTransaction",
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
          "INSERT INTO insight_events(id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at_ms,money_groups_json) VALUES(?,?,'weekly-summary','40000000-0000-4000-8000-000000000001',1,'CO','es-CO','America/Bogota',1791028800000,'[]')"
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

const otherOwnerJourneyArgs = (
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
    if (name.startsWith("transactions.")) {
      const created = yield* wait(ordinary("transactions.createTransaction", transactionArguments));
      expect(yield* wait(created.json())).toMatchObject({ result: { isError: false } });
      const id = yield* wait(
        fixture.db.prepare("SELECT id FROM transactions LIMIT 1").first<string>("id")
      );
      return name === "transactions.deleteTransaction"
        ? ownerArgs({ params: { id } })
        : ownerArgs({
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
        if (
          [
            "memory.revise",
            "memory.forget",
            "transactions.updateTransaction",
            "transactions.deleteTransaction",
          ].some((operation) => operation === name)
        ) {
          yield* approveFirstPartyOperation(fixture, pending.result.requestState);
        }
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
                "SELECT count(*) FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE operation = ? AND outcome = 'accepted'"
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

it.each(["created_at_ms", "updated_at_ms"] as const)(
  "refuses an approved Memory revision after a one-millisecond change to %s",
  (column) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* pendingBudgetDeletion(["write"]);
        const name = "memory.revise";
        const args = yield* ownerJourneyArgs(fixture, name);
        const review = yield* wait(
          nativeConfirmationCall({ fixture, params: { name, arguments: args }, name })
        );
        const pending = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ result: Schema.Struct({ requestState: Schema.String }) })
        )(yield* wait(review.json()));
        yield* approveFirstPartyOperation(fixture, pending.result.requestState);
        yield* wait(fixture.db.prepare(`UPDATE memories SET ${column}=${column}+1`).run());
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
        expect(yield* wait(accepted.json())).toMatchObject({ result: { isError: true } });
        expect(
          yield* wait(fixture.db.prepare("SELECT text FROM memories").first<string>("text"))
        ).toBe("I plan monthly spending.");
        expect(
          yield* wait(
            fixture.db
              .prepare("SELECT count(*) FROM oauth_operation_intents WHERE reference=?")
              .bind(pending.result.requestState)
              .first<number>("count(*)")
          )
        ).toBe(1);
      })
    )
);

it.skipIf(Option.isNone(nativeHostBridgeFile))(
  "serves the real confirmation seam to pinned native hosts",
  () => Effect.runPromise(runNativeHostFixture(pendingBudgetDeletion)),
  600000
);

const ownerJourneyArgs = (
  fixture: NativeFixture,
  name: NativeOwnerJourney
): Effect.Effect<Schema.Json, TestFailure> =>
  name === "recurringPlans.applyRecurringEdit"
    ? Effect.succeed({
        payload: {
          expectedRevision: 0,
          edit: {
            kind: "create",
            id: "40000000-0000-4000-8000-000000000124",
            plan: {
              name: "Arriendo",
              kind: "expense",
              currency: "COP",
              amountMode: "unknown",
              frequency: "monthly",
              firstDate: "2026-10-31",
              timeZone: "America/Bogota",
            },
          },
        },
      })
    : otherOwnerJourneyArgs(fixture, name);
