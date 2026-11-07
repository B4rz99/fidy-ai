import type { APIRequestContext, Page } from "@playwright/test";
import { Effect } from "effect";
import { playwright } from "./playwright-runtime";
import {
  boundSessionRequests,
  probeCanonicalRequest,
  reloadTransactionsThroughCore,
  signInMoneyInputThroughCore,
} from "./real-core-fixture";
import { apiOrigin } from "./http-fixtures";

const { expect, test } = playwright;
const wait = Effect.tryPromise;
const currencyJourneyMilliseconds = 90_000;
const successStatus = 200;
const createdStatus = 201;
const categoryId = "10000000-0000-4000-8000-000000000001";
const chooseCurrency = (page: Page, currency: string): Promise<void> =>
  page
    .getByRole("combobox", { name: "Moneda", exact: true })
    .click()
    .then(() => page.getByRole("combobox", { name: "Buscar: Moneda", exact: true }).fill(currency))
    .then(() => page.getByRole("option", { name: currency, exact: true }).click());

const chooseCategory = Effect.fn(function* (page: Page) {
  yield* wait(() =>
    page.getByRole("button", { name: "Categoría: Asignar automáticamente", exact: true }).click()
  );
  yield* wait(() => page.getByRole("menuitemradio", { name: "Restaurantes", exact: true }).click());
});
const registerForeignExpense = Effect.fn(function* (page: Page) {
  yield* wait(() => page.getByRole("button", { name: "+ Registrar", exact: true }).click());
  yield* wait(() =>
    expect(page.getByRole("combobox", { name: "Moneda", exact: true })).toHaveText("COP")
  );
  yield* wait(() => page.getByLabel("Monto", { exact: true }).fill("25,50"));
  yield* chooseCategory(page);
  yield* wait(() => page.getByLabel("Contraparte (opcional)").fill("Moneda QA USD"));
  yield* wait(() => page.getByLabel("Notas (opcional)").fill("Conservar el monto exacto"));
  yield* wait(() => chooseCurrency(page, "JPY"));
  yield* wait(() => expect(page.getByLabel("Monto", { exact: true })).toHaveValue("25,50"));
  yield* wait(() =>
    expect(page.getByLabel("Monto", { exact: true })).toHaveAccessibleDescription(
      "JPY no admite decimales. Ingresa un monto entero."
    )
  );
  yield* wait(() => page.getByRole("button", { name: "Registrar", exact: true }).click());
  yield* wait(() => expect(page.getByLabel("Monto", { exact: true })).toBeFocused());
  yield* wait(() => chooseCurrency(page, "USD"));
  yield* wait(() => expect(page.getByLabel("Contraparte (opcional)")).toHaveValue("Moneda QA USD"));
  yield* wait(() =>
    expect(page.getByLabel("Notas (opcional)")).toHaveValue("Conservar el monto exacto")
  );
  yield* wait(() => page.getByRole("button", { name: "Registrar", exact: true }).click());
  yield* wait(() =>
    expect(page.getByText("Transacción registrada", { exact: true })).toBeVisible()
  );
  yield* wait(() => expect(page.getByText(/^USD 25,50 · Moneda QA USD ·/u)).toBeVisible());
});

const createBudget = Effect.fn(function* (request: APIRequestContext, month: string) {
  const bound = boundSessionRequests(request);
  const response = yield* probeCanonicalRequest({
    request,
    send: () =>
      bound.post(`${apiOrigin}/budgets`, {
        data: { categoryId, cap: { amount: "100", currency: "USD" }, month },
      }),
  });
  expect(response.status()).toBe(createdStatus);
});
const registerOtherMoney = Effect.fn(function* (page: Page) {
  for (const example of [
    { currency: "USD", direction: "Ingreso", amount: "100,25", name: "Moneda QA ingreso" },
    { currency: "COP", direction: "Gasto", amount: "12.500", name: "Moneda QA COP" },
  ]) {
    yield* wait(() => page.getByRole("button", { name: "+ Registrar", exact: true }).click());
    yield* wait(() => chooseCurrency(page, example.currency));
    yield* wait(() => page.getByRole("button", { name: example.direction, exact: true }).click());
    yield* chooseCategory(page);
    yield* wait(() => page.getByLabel("Monto", { exact: true }).fill(example.amount));
    yield* wait(() => page.getByLabel("Contraparte (opcional)").fill(example.name));
    yield* wait(() => page.getByRole("button", { name: "Registrar", exact: true }).click());
    yield* wait(() =>
      expect(
        page.getByRole("button", { name: `Ver transacción ${example.name}`, exact: true })
      ).toBeVisible()
    );
  }
});
const inspectMoney = Effect.fn(function* (
  request: APIRequestContext,
  month: string,
  expected: Readonly<{
    currency: string;
    amount: string;
    spent: string;
    remaining: string;
  }>
) {
  const bound = boundSessionRequests(request);
  const history = yield* probeCanonicalRequest({
    request,
    send: () => bound.get(`${apiOrigin}/transactions`),
  });
  expect(history.status()).toBe(successStatus);
  const historyBody: unknown = yield* wait(() => history.json());
  expect(historyBody).toMatchObject({
    data: expect.arrayContaining([
      expect.objectContaining({
        counterparty: "Moneda QA USD",
        money: { amount: expected.amount, currency: expected.currency },
        direction: "outflow",
        categoryId,
      }),
      expect.objectContaining({
        counterparty: "Moneda QA ingreso",
        money: { amount: "100.25", currency: "USD" },
        direction: "inflow",
        categoryId,
      }),
      expect.objectContaining({
        counterparty: "Moneda QA COP",
        money: { amount: "12500", currency: "COP" },
        direction: "outflow",
        categoryId,
      }),
    ]),
  });
  const report = yield* probeCanonicalRequest({
    request,
    send: () => bound.get(`${apiOrigin}/budget-status?month=${month}&timeZone=America%2FBogota`),
  });
  expect(report.status()).toBe(successStatus);
  const reportBody: unknown = yield* wait(() => report.json());
  expect(reportBody).toMatchObject({
    data: {
      statuses: expect.arrayContaining([
        expect.objectContaining({
          budget: expect.objectContaining({ categoryId, cap: { amount: "100", currency: "USD" } }),
          spent: { amount: expected.spent, currency: "USD" },
          remaining: { amount: expected.remaining, currency: "USD" },
        }),
      ]),
    },
  });
});

const correctCurrency = Effect.fn(function* (page: Page) {
  yield* wait(() =>
    page.getByRole("searchbox", { name: "Buscar transacciones" }).fill("Moneda QA USD")
  );
  yield* wait(() =>
    page.getByRole("button", { name: "Ver transacción Moneda QA USD", exact: true }).click()
  );
  yield* wait(() =>
    expect(page.getByRole("combobox", { name: "Moneda", exact: true })).toHaveText("USD")
  );
  yield* wait(() => chooseCurrency(page, "JPY"));
  yield* wait(() => expect(page.getByLabel("Monto", { exact: true })).toHaveValue("25,5"));
  yield* wait(() => page.getByLabel("Monto", { exact: true }).focus());
  yield* wait(() => page.getByLabel("Monto", { exact: true }).press("Tab"));
  yield* wait(() =>
    expect(page.getByLabel("Monto", { exact: true })).toHaveAccessibleDescription(
      "JPY no admite decimales. Ingresa un monto entero."
    )
  );
  yield* wait(() =>
    expect(page.getByRole("button", { name: "Guardar", exact: true })).toBeDisabled()
  );
  yield* wait(() => chooseCurrency(page, "COP"));
  yield* wait(() =>
    expect(page.getByLabel("Notas (opcional)")).toHaveValue("Conservar el monto exacto")
  );
  yield* wait(() => page.getByRole("button", { name: "Guardar", exact: true }).click());
  yield* wait(() => expect(page.getByText("Cambios guardados", { exact: true })).toBeVisible());
  yield* wait(() => reloadTransactionsThroughCore(page));
  yield* wait(() =>
    page.getByRole("searchbox", { name: "Buscar transacciones" }).fill("Moneda QA USD")
  );
  const summary = page.getByRole("region", { name: "Resumen de transacciones" });
  yield* wait(() => expect(summary).not.toContainText("USD"));
  yield* wait(() => expect(summary).toContainText("25,50"));
  yield* wait(() =>
    page.getByRole("button", { name: "Ver transacción Moneda QA USD", exact: true }).click()
  );
  yield* wait(() =>
    expect(page.getByRole("combobox", { name: "Moneda", exact: true })).toHaveText("COP")
  );
  yield* wait(() => expect(page.getByLabel("Monto", { exact: true })).toHaveValue("25,5"));
  yield* wait(() => page.getByRole("button", { name: "Cancelar", exact: true }).click());
});
const correctMoney = Effect.fn(function* (page: Page) {
  yield* wait(() =>
    page.getByRole("button", { name: "Ver transacción Moneda QA USD", exact: true }).click()
  );
  yield* wait(() => chooseCurrency(page, "USD"));
  yield* wait(() => page.getByLabel("Monto", { exact: true }).fill("30,75"));
  yield* wait(() => page.getByRole("button", { name: "Guardar", exact: true }).click());
  yield* wait(() => expect(page.getByText("Cambios guardados", { exact: true })).toBeVisible());
  yield* wait(() => reloadTransactionsThroughCore(page));
  yield* wait(() =>
    page.getByRole("searchbox", { name: "Buscar transacciones" }).fill("Moneda QA USD")
  );
  const summary = page.getByRole("region", { name: "Resumen de transacciones" });
  yield* wait(() => expect(summary).toContainText("USD"));
  yield* wait(() => expect(summary).toContainText("30,75"));
});

const inspectCorrections = Effect.fn(function* (page: Page, month: string) {
  yield* correctCurrency(page);
  yield* inspectMoney(page.request, month, {
    currency: "COP",
    amount: "25.5",
    spent: "0",
    remaining: "100",
  });
  yield* correctMoney(page);
  yield* inspectMoney(page.request, month, {
    currency: "USD",
    amount: "30.75",
    spent: "30.75",
    remaining: "69.25",
  });
});

test("capture and corrections preserve exact Money after reload and budgets only matching Currency outflows", ({
  page,
  request,
}) => {
  test.setTimeout(currencyJourneyMilliseconds);
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(() => signInMoneyInputThroughCore({ page, request }));
      const month = yield* wait(() =>
        page.getByRole("textbox", { name: "Mes de transacciones", exact: true }).inputValue()
      );
      yield* createBudget(page.request, month);
      yield* registerForeignExpense(page);
      yield* wait(() => reloadTransactionsThroughCore(page));
      yield* wait(() =>
        page.getByRole("searchbox", { name: "Buscar transacciones" }).fill("Moneda QA USD")
      );
      const summary = page.getByRole("region", { name: "Resumen de transacciones" });
      yield* wait(() => expect(summary).toContainText("USD"));
      yield* wait(() => expect(summary).toContainText("25,50"));
      yield* wait(() => expect(summary).not.toContainText("COP"));
      yield* wait(() =>
        page.getByRole("button", { name: "Ver transacción Moneda QA USD", exact: true }).click()
      );
      yield* wait(() => expect(page.getByLabel("Monto", { exact: true })).toHaveValue("25,5"));
      yield* wait(() =>
        expect(page.getByLabel("Notas (opcional)")).toHaveValue("Conservar el monto exacto")
      );
      yield* wait(() => page.getByRole("button", { name: "Cancelar", exact: true }).click());
      yield* wait(() => page.getByRole("searchbox", { name: "Buscar transacciones" }).clear());
      yield* registerOtherMoney(page);
      yield* wait(() => reloadTransactionsThroughCore(page));
      yield* wait(() =>
        page.getByRole("searchbox", { name: "Buscar transacciones" }).fill("Moneda QA")
      );
      yield* wait(() => expect(summary).toContainText("USD"));
      yield* wait(() => expect(summary).toContainText("COP"));
      yield* wait(() => expect(summary).toContainText("100,25"));
      yield* wait(() => expect(summary).toContainText("12.500,00"));
      yield* inspectMoney(page.request, month, {
        currency: "USD",
        amount: "25.5",
        spent: "25.5",
        remaining: "74.5",
      });
      yield* inspectCorrections(page, month);
    })
  );
});
