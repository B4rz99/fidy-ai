import { FidyApi, ResourceLimited } from "@fidy/server/client";
import type { CanonicalSuccess } from "@fidy/server/client";
import type { APIResponse, Page } from "@playwright/test";
import { DateTime, Effect, Option, Schema } from "effect";
import type { Cause, Scope } from "effect";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";
import { playwright } from "./playwright-runtime";
import { browserSessionHeaders, signInBudgetThroughCore } from "./real-core-fixture";

const { test, expect } = playwright;
const { api } = browserAcceptanceTopology();
const ok = 200;
const created = 201;
const notFound = 404;
const limited = 429;
const probeRetries = 6;
const maximumDelaySeconds = 5;
const millisecondsPerSecond = 1_000;
const canonicalRecoveryMilliseconds = 15_000;
const fixtureOperations = {
  budgets: FidyApi.groups.budgets.endpoints.createBudget,
  transactions: FidyApi.groups.transactions.endpoints.createTransaction,
};
type FixtureSuccess = CanonicalSuccess<"budgets.createBudget" | "transactions.createTransaction">;
const categoryId = "10000000-0000-4000-8000-000000000001";
const RetrySeconds = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(maximumDelaySeconds)
);
// Retry only a declared refusal: Core has not admitted the mutation yet.
const admittedRequest = (
  send: () => Promise<APIResponse>
): Effect.Effect<APIResponse, Cause.UnknownError> =>
  Effect.gen(function* () {
    for (let retry = 0; retry < probeRetries; retry++) {
      const response = yield* Effect.tryPromise(send);
      if (response.status() !== limited) return response;
      const seconds = Schema.decodeUnknownOption(RetrySeconds)(response.headers()["retry-after"]);
      if (Option.isNone(seconds)) return response;
      const body: unknown = yield* Effect.tryPromise(() => response.json());
      if (Option.isNone(Schema.decodeUnknownOption(Schema.toCodecJson(ResourceLimited))(body))) {
        return response;
      }
      yield* Effect.sleep(seconds.value * millisecondsPerSecond);
    }
    return yield* Effect.tryPromise(send);
  });

const acquireFixture = (
  page: Page,
  path: keyof typeof fixtureOperations,
  data: object
): Effect.Effect<string, Cause.UnknownError | Schema.SchemaError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const response = yield* admittedRequest(() =>
        browserSessionHeaders(page.request).then((headers) =>
          page.request.post(`${api}/${path}`, { headers, data })
        )
      );
      expect(response.status()).toBe(created);
      // HttpApi reflection erases the types; both selected declarations retain their full codecs.
      const responseSchema = Schema.make<Schema.Codec<FixtureSuccess, Schema.Json>>(
        Schema.Union(Array.from(fixtureOperations[path].success)).ast
      );
      return (yield* Schema.decodeUnknownEffect(responseSchema)(
        yield* Effect.tryPromise(() => response.json())
      )).data.id;
    }),
    (id) =>
      admittedRequest(() =>
        browserSessionHeaders(page.request).then((headers) =>
          page.request.delete(`${api}/${path}/${id}`, { headers })
        )
      ).pipe(
        Effect.tap((response) =>
          Effect.sync(() => expect([ok, notFound]).toContain(response.status()))
        ),
        Effect.orDie
      )
  );

const verifyCapChanges = (page: Page, budgetId: string): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const widget = page.locator('[data-slot="card"]').filter({
      has: page.getByRole("heading", { name: "Presupuesto de restaurantes", exact: true }),
    });
    yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
    yield* Effect.tryPromise(() =>
      expect(widget.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "80", {
        timeout: canonicalRecoveryMilliseconds,
      })
    );
    yield* Effect.tryPromise(() => expect(widget).toContainText(/Disponible.*20,00/u));
    for (const update of [
      { amount: "80", message: /Presupuesto alcanzado/u },
      { amount: "70", message: /Excedido por.*10,00/u },
    ]) {
      const response = yield* admittedRequest(() =>
        browserSessionHeaders(page.request).then((headers) =>
          page.request.put(`${api}/budgets/${budgetId}`, {
            headers,
            data: { categoryId, cap: { amount: update.amount, currency: "COP" } },
          })
        )
      );
      expect(response.status()).toBe(ok);
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(widget).toContainText(update.message, { timeout: canonicalRecoveryMilliseconds })
      );
      yield* Effect.tryPromise(() =>
        expect(widget.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100")
      );
    }
    const deleted = yield* admittedRequest(() =>
      browserSessionHeaders(page.request).then((headers) =>
        page.request.delete(`${api}/budgets/${budgetId}`, { headers })
      )
    );
    expect(deleted.status()).toBe(ok);
    yield* Effect.tryPromise(() => page.reload());
    yield* Effect.tryPromise(() =>
      expect(widget).toContainText("No hay presupuesto configurado", {
        timeout: canonicalRecoveryMilliseconds,
      })
    );
    yield* Effect.tryPromise(() => expect(widget.getByRole("progressbar")).toHaveCount(0));
  });

test("Budget cap changes and deletion update the persisted Widget without mixing currencies", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => signInBudgetThroughCore({ page, request }));
      yield* Effect.tryPromise(() => page.clock.resume());
      const budgetId = yield* acquireFixture(page, "budgets", {
        categoryId,
        cap: { amount: "100", currency: "COP" },
      });
      for (const money of [
        { amount: "80", currency: "COP" },
        { amount: "900", currency: "USD" },
      ]) {
        yield* acquireFixture(page, "transactions", {
          money,
          categoryId,
          direction: "outflow",
          occurredAt: DateTime.formatIso(yield* DateTime.now),
        });
      }
      yield* verifyCapChanges(page, budgetId);
    }).pipe(Effect.scoped)
  ));
