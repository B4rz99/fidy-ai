import type { Page, Route } from "@playwright/test";
import { type Cause, DateTime, Effect, Schema } from "effect";
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
const delayedTransactions = (route: Route): Promise<void> =>
  Effect.runPromise(Effect.sleep("1 second")).then(() =>
    route.fulfill({ status: 200, contentType: "application/json", body: response([]) })
  );
const currentDate = (): string =>
  DateTime.formatIsoDate(
    DateTime.setZone(Effect.runSync(DateTime.now), DateTime.zoneMakeNamedUnsafe("America/Bogota"))
  );

test("presents a Category by stable identity with a current-month Transaction", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [category] }));
      let requestedPeriod = false;
      yield* installRoute(page, transactionsRoute, (route) => {
        const url = new URL(route.request().url());
        requestedPeriod = url.searchParams.has("from") && url.searchParams.has("to");
        const date = currentDate();
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: response([matchingTransaction(date)]),
        });
      });
      yield* Effect.tryPromise(() => page.goto("/app/transactions"));
      yield* Effect.tryPromise(() => expect(page.getByText("La Cocina").first()).toBeVisible());
      yield* Effect.tryPromise(() => expect(page.getByText("Restaurantes").first()).toBeVisible());
      expect(requestedPeriod).toBe(true);
    })
  ));

test("shows loading until a bounded Transactions query completes", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [category] }));
      yield* installRoute(page, transactionsRoute, delayedTransactions);
      yield* Effect.tryPromise(() => page.goto("/app/transactions"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("region", { name: "Cargando transacciones" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Aún no hay transacciones este mes")).toBeVisible()
      );
    })
  ));

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
        expect(page.getByText("Aún no hay transacciones este mes")).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.getByLabel("Monto en COP").fill("12500"));
      yield* Effect.tryPromise(() => page.getByLabel("Contraparte (opcional)").fill("La Cocina"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Registrar transacción" }).click()
      );
      yield* Effect.tryPromise(() => expect(page.getByRole("alert")).toHaveCount(0));
      expect(captured).toMatchObject({
        money: { amount: "12500", currency: "COP" },
        counterparty: "La Cocina",
        direction: "outflow",
      });
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Transacción guardada. Actualizando el historial…")).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Transacción recién registrada")).toContainText("La Cocina")
      );
    })
  ));
