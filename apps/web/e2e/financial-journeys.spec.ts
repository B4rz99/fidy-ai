import type { Page, Route } from "@playwright/test";
import { type Cause, Effect, Schema } from "effect";
import { apiOrigin, installCategories, installUser, response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;

const category = { id: "24000000-0000-4000-8000-000000000242", label: "Restaurantes" };
const transactionId = "24000000-0000-4000-8000-000000000243";
type TransactionFixture = Readonly<{
  id: string;
  money: Readonly<{ amount: string; currency: string }>;
  counterparty: string;
  direction: "outflow";
  categoryId: string;
  occurredAt: string;
  createdAt: string;
  revision: number;
}>;
const dateStringLength = 10;
const matchingTransaction = (date: string): TransactionFixture => ({
  id: transactionId,
  money: { amount: "12500", currency: "COP" },
  counterparty: "La Cocina",
  direction: "outflow",
  categoryId: category.id,
  occurredAt: `${date}T12:00:00.000Z`,
  createdAt: `${date}T12:00:00.000Z`,
  revision: 0,
});
const transactionsRoute = new RegExp(`^${apiOrigin}/transactions\\?`, "u");
const installRoute = (
  page: Page,
  url: RegExp | string,
  handler: (route: Route) => Promise<void>
): Effect.Effect<unknown, Cause.UnknownError> => Effect.tryPromise(() => page.route(url, handler));
test("a cross-User refusal never renders another User's financial details", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [category] }));
      const secret = "Other User private transaction";
      yield* installRoute(page, transactionsRoute, (route) =>
        route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "not_found", message: secret }, next: [] }),
        })
      );
      yield* Effect.tryPromise(() => page.goto("/app/transactions"));
      yield* Effect.tryPromise(() =>
        expect(page.getByText("No pudimos comunicarnos con Fidy")).toBeVisible()
      );
      expect(yield* Effect.tryPromise(() => page.locator("body").textContent())).not.toContain(
        secret
      );
    })
  ));

test("captures a Transaction by canonical mutation and displays the confirmed result", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [category] }));
      yield* installRoute(page, transactionsRoute, (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: response([]) })
      );
      let captured: unknown;
      yield* installRoute(page, `${apiOrigin}/transactions`, (route) => {
        const payload = Schema.decodeUnknownSync(
          Schema.Struct({
            money: Schema.Struct({ amount: Schema.String, currency: Schema.String }),
            counterparty: Schema.String,
            direction: Schema.String,
            occurredAt: Schema.String,
          })
        )(route.request().postDataJSON());
        captured = payload;
        const date = String(payload.occurredAt).slice(0, dateStringLength);
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: response(matchingTransaction(date)),
        });
      });
      yield* Effect.tryPromise(() => page.goto("/app/transactions"));
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("heading", { name: /^No hay transacciones (en|para)/u })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "+ Registrar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => page.getByLabel("Monto").fill("12500"));
      yield* Effect.tryPromise(() => page.getByLabel("Contraparte (opcional)").fill("La Cocina"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Registrar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(page.getByRole("alert")).toHaveCount(0));
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Transacción registrada", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.locator("[data-sonner-toast]")).toContainText("La Cocina")
      );
      expect(captured).toMatchObject({
        money: { amount: "12500", currency: "COP" },
        counterparty: "La Cocina",
        direction: "outflow",
      });
    })
  ));

test("explains invalid registration amounts and preserves the other fields", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [category] }));
      yield* installRoute(page, transactionsRoute, (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: response([]) })
      );
      yield* Effect.tryPromise(() => page.goto("/app/transactions"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "+ Registrar", exact: true }).click()
      );
      const amount = page.getByLabel("Monto · COP");
      const counterparty = page.getByLabel("Contraparte (opcional)");
      yield* Effect.tryPromise(() => counterparty.fill("Café de prueba"));
      yield* Effect.tryPromise(() => amount.focus());
      yield* Effect.tryPromise(() => amount.press("Tab"));
      yield* Effect.tryPromise(() =>
        expect(amount).toHaveAccessibleDescription("Ingresa un monto mayor que cero.")
      );
      yield* Effect.tryPromise(() => amount.fill("0"));
      yield* Effect.tryPromise(() => expect(amount).toHaveAttribute("aria-invalid", "true"));
      yield* Effect.tryPromise(() =>
        expect(amount).toHaveAccessibleDescription("El monto debe ser mayor que cero.")
      );
      yield* Effect.tryPromise(() => amount.fill("12,501"));
      yield* Effect.tryPromise(() =>
        expect(amount).toHaveAccessibleDescription("Para COP, ingresa máximo 2 decimales.")
      );
      yield* Effect.tryPromise(() => amount.fill("12.50"));
      yield* Effect.tryPromise(() =>
        expect(amount).toHaveAccessibleDescription(
          "Usa punto para miles y coma para decimales. Por ejemplo: 12.500,50."
        )
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Registrar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(amount).toBeFocused());
      yield* Effect.tryPromise(() => expect(counterparty).toHaveValue("Café de prueba"));
      yield* Effect.tryPromise(() => amount.fill("12.500,50"));
      yield* Effect.tryPromise(() => expect(amount).toHaveAttribute("aria-invalid", "false"));
    })
  ));

test("a refused registration offers retry while retaining a valid amount", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [category] }));
      yield* installRoute(page, transactionsRoute, (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: response([]) })
      );
      yield* installRoute(page, `${apiOrigin}/transactions`, (route) =>
        route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "validation_failed", message: "Refused", fields: [] },
            next: [],
          }),
        })
      );
      yield* Effect.tryPromise(() => page.goto("/app/transactions"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "+ Registrar", exact: true }).click()
      );
      const amount = page.getByLabel("Monto · COP");
      yield* Effect.tryPromise(() => amount.fill("25.000"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Registrar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toHaveText(
          "No pudimos guardar la transacción. Tus datos siguen en el formulario. Intenta de nuevo."
        )
      );
      yield* Effect.tryPromise(() => expect(amount).toHaveValue("25.000"));
      yield* Effect.tryPromise(() => expect(amount).toHaveAttribute("aria-invalid", "false"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Registrar", exact: true })).toBeEnabled()
      );
    })
  ));
