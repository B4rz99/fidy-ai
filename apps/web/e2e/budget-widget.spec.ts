import { FidyApi } from "@fidy/server/client";
import type { CanonicalSuccess } from "@fidy/server/client";
import type { APIResponse, Page, Route } from "@playwright/test";
import { DateTime, Effect, Schema } from "effect";
import type { Cause, Scope } from "effect";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";
import { advanceRefusedRequest } from "./acceptance-clock";
import { playwright } from "./playwright-runtime";
import { browserSessionHeaders, signInBudgetThroughCore } from "./real-core-fixture";

const { test, expect } = playwright;
const { api } = browserAcceptanceTopology();
const ok = 200;
const created = 201;
const notFound = 404;
const probeRetries = 6;
const canonicalRecoveryMilliseconds = 15_000;
const fixtureOperations = {
  budgets: FidyApi.groups.budgets.endpoints.createBudget,
  transactions: FidyApi.groups.transactions.endpoints.createTransaction,
};
type FixtureSuccess = CanonicalSuccess<"budgets.createBudget" | "transactions.createTransaction">;
const categoryId = "10000000-0000-4000-8000-000000000001";
const admittedRequest = (
  page: Page,
  send: () => Promise<APIResponse>
): Effect.Effect<APIResponse, Cause.UnknownError> =>
  Effect.gen(function* () {
    for (let retry = 0; retry < probeRetries; retry++) {
      const response = yield* Effect.tryPromise(send);
      if (
        !(yield* Effect.tryPromise(() =>
          advanceRefusedRequest({ request: page.request, response })
        ))
      ) {
        return response;
      }
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
      const response = yield* admittedRequest(page, () =>
        browserSessionHeaders(page.request).then((headers) =>
          page.request.post(`${api}/${path}`, { headers, data })
        )
      );
      expect(response.status()).toBe(created);
      // HttpApi reflection erases types; the selected declarations retain their full codecs.
      const responseSchema = Schema.make<Schema.Codec<FixtureSuccess, Schema.Json>>(
        Schema.Union(Array.from(fixtureOperations[path].success)).ast
      );
      return (yield* Schema.decodeUnknownEffect(responseSchema)(
        yield* Effect.tryPromise(() => response.json())
      )).data.id;
    }),
    (id) =>
      admittedRequest(page, () =>
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

const captureBudgetPreview = (page: Page, name: string): Promise<void> =>
  Bun.env.BROWSER_VISUAL_EVIDENCE === "true"
    ? page.screenshot().then((body) => test.info().attach(name, { body, contentType: "image/png" }))
    : Promise.resolve();

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
      const response = yield* admittedRequest(page, () =>
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
    yield* Effect.tryPromise(() =>
      page.getByRole("link", { name: "Presupuestos", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Configurar Restaurantes", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Eliminar presupuesto", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Eliminar de todos los meses", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(
        page.getByText("Presupuesto eliminado de todos los meses.", { exact: true })
      ).toBeVisible()
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("link", { name: "Tablero", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(widget).toContainText("No hay presupuesto para este mes", {
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
      yield* Effect.tryPromise(() =>
        signInBudgetThroughCore({ page, deferFreshEntry: true, request })
      );
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

test("configures a non-COP Budget target with keyboard and persists it after reload", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInBudgetThroughCore({ page, deferFreshEntry: true, request })
      );
      yield* Effect.tryPromise(() => page.clock.resume());
      const marketCategory = "10000000-0000-4000-8000-000000000003";
      yield* acquireFixture(page, "budgets", {
        categoryId: marketCategory,
        cap: { amount: "250", currency: "USD" },
      });
      for (const money of [
        { amount: "160", currency: "USD" },
        { amount: "900", currency: "COP" },
      ]) {
        yield* acquireFixture(page, "transactions", {
          money,
          categoryId: marketCategory,
          direction: "outflow",
          occurredAt: DateTime.formatIso(yield* DateTime.now),
        });
      }
      yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
      const widget = page.locator('[data-widget-type="budget-bar"]');
      yield* Effect.tryPromise(() =>
        expect(
          widget.getByRole("button", { name: "Elegir presupuesto", exact: true })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        widget.getByRole("button", { name: "Elegir presupuesto", exact: true }).press("Enter")
      );
      const dialog = page.getByRole("dialog", { name: "Configurar presupuesto", exact: true });
      yield* Effect.tryPromise(() =>
        dialog.getByRole("button", { name: /^Presupuesto:/u }).press("Enter")
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("menuitemradio", { name: "Mercado · USD", exact: true }).press("Enter")
      );
      yield* Effect.tryPromise(() => captureBudgetPreview(page, "budget-configuration"));
      yield* Effect.tryPromise(() =>
        dialog.getByRole("button", { name: "Guardar cambios", exact: true }).press("Enter")
      );
      yield* Effect.tryPromise(() =>
        expect(widget.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "64")
      );
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(widget.getByRole("region", { name: "Mercado USD", exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() => expect(widget).toContainText(/250,00/u));
      yield* Effect.tryPromise(() => expect(widget).toContainText(/Disponible.*90,00/u));
      yield* Effect.tryPromise(() => captureBudgetPreview(page, "budget-configured"));
      yield* verifyConfigurationFocus(page);
    }).pipe(Effect.scoped)
  ));

const verifyConfigurationFocus = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const dialog = page.getByRole("dialog", { name: "Configurar presupuesto", exact: true });
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Personalizar", exact: true }).click()
    );
    const configure = page.getByRole("button", { name: "Configurar presupuesto", exact: true });
    yield* Effect.tryPromise(() => configure.press("Enter"));
    yield* Effect.tryPromise(() =>
      expect(
        dialog.getByRole("button", { name: "Presupuesto: Mercado · USD", exact: true })
      ).toBeVisible()
    );
    yield* Effect.tryPromise(() => page.keyboard.press("Escape"));
    yield* Effect.tryPromise(() => expect(configure).toBeFocused());
  });

test("recovers failed Budget choices and offers creation when no monthly Budget exists", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInBudgetThroughCore({ page, deferFreshEntry: true, request })
      );
      yield* Effect.tryPromise(() => page.clock.resume());
      yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
      yield* Effect.tryPromise(() => page.route("**/budget-status?*", unavailableBudgetChoices));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Elegir presupuesto", exact: true }).click()
      );
      const dialog = page.getByRole("dialog", { name: "Configurar presupuesto", exact: true });
      yield* Effect.tryPromise(() =>
        expect(
          dialog.getByText("No pudimos cargar los presupuestos", { exact: true })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(dialog.getByRole("button", { name: "Guardar cambios", exact: true })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() => page.unroute("**/budget-status?*"));
      yield* Effect.tryPromise(() =>
        dialog
          .getByRole("button", { name: "Reintentar carga de presupuestos", exact: true })
          .click()
      );
      yield* Effect.tryPromise(() =>
        expect(
          dialog.getByText("No tienes presupuestos para este mes", { exact: true })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        dialog.getByRole("link", { name: "Ir a Presupuestos", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/app\/budgets$/u));
    })
  ));

const unavailableBudgetChoices = (route: Route): Promise<void> =>
  route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({
      error: { code: "service_unavailable", message: "Unavailable" },
      next: [],
    }),
  });
