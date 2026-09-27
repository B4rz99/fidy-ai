import { expect, test } from "@playwright/test";
import { DateTime, Effect, Schema } from "effect";
import { apiOrigin, installCategories, installUser, response } from "./http-fixtures";

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

test("presents a Category by stable identity with a current-month Transaction", async ({
  page,
}) => {
  await installUser(page);
  await installCategories({ page, categories: [category] });
  let requestedPeriod = false;
  await page.route(transactionsRoute, async (route) => {
    const url = new URL(route.request().url());
    requestedPeriod = url.searchParams.has("from") && url.searchParams.has("to");
    const date = DateTime.formatIsoDate(
      DateTime.setZone(Effect.runSync(DateTime.now), DateTime.zoneMakeNamedUnsafe("America/Bogota"))
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: response([matchingTransaction(date)]),
    });
  });
  await page.goto("/app/transactions");
  await expect(page.getByText("La Cocina").first()).toBeVisible();
  await expect(page.getByText("Restaurantes").first()).toBeVisible();
  expect(requestedPeriod).toBe(true);
});

test("shows loading until a bounded Transactions query completes", async ({ page }) => {
  await installUser(page);
  await installCategories({ page, categories: [category] });
  await page.route(transactionsRoute, async (route) => {
    await Effect.runPromise(Effect.sleep("1 second"));
    await route.fulfill({ status: 200, contentType: "application/json", body: response([]) });
  });
  await page.goto("/app/transactions");
  await expect(page.getByRole("region", { name: "Cargando transacciones" })).toBeVisible();
  await expect(page.getByText("Aún no hay transacciones este mes")).toBeVisible();
});

test("a cross-User refusal never renders another User's financial details", async ({ page }) => {
  await installUser(page);
  await installCategories({ page, categories: [category] });
  const secret = "Other User private transaction";
  await page.route(transactionsRoute, (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "not_found", message: secret }, next: [] }),
    })
  );
  await page.goto("/app/transactions");
  await expect(page.getByText("No pudimos comunicarnos con Fidy")).toBeVisible();
  expect(await page.locator("body").textContent()).not.toContain(secret);
});

test("captures a Transaction by canonical mutation and displays the confirmed result", async ({
  page,
}) => {
  await installUser(page);
  await installCategories({ page, categories: [category] });
  await page.route(transactionsRoute, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: response([]) })
  );
  let captured: unknown;
  await page.route(`${apiOrigin}/transactions`, async (route) => {
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
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: response(matchingTransaction(date)),
    });
  });
  await page.goto("/app/transactions");
  await expect(page.getByText("Aún no hay transacciones este mes")).toBeVisible();
  await page.getByLabel("Monto en COP").fill("12500");
  await page.getByLabel("Contraparte (opcional)").fill("La Cocina");
  await page.getByRole("button", { name: "Registrar transacción" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(captured).toMatchObject({
    money: { amount: "12500", currency: "COP" },
    counterparty: "La Cocina",
    direction: "outflow",
  });
  await expect(page.getByText("Transacción guardada. Actualizando el historial…")).toBeVisible();
  await expect(page.getByLabel("Transacción recién registrada")).toContainText("La Cocina");
});
