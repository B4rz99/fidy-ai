import type { Locator, Page } from "@playwright/test";
import { Effect } from "effect";
import { playwright } from "./playwright-runtime";
import { reloadTransactionsThroughCore, signInMoneyInputThroughCore } from "./real-core-fixture";

const { expect, test } = playwright;
const wait = Effect.tryPromise;
const cases = [
  { input: "12.500", draft: "12500" },
  { input: "12500", draft: "12500" },
  { input: "12.500,50", draft: "12500,5" },
  { input: "12,50", draft: "12,5" },
];
const counterparty = (index: number): string => `Formato COP QA ${index}`;
const amountField = (page: Page): Locator =>
  page.getByRole("textbox", { name: /^Monto(?: · COP)?$/u });
const save = (page: Page): Locator => page.getByRole("button", { name: "Guardar", exact: true });
const rejectInvalidAmounts = Effect.fn(function* (page: Page, submit: Locator) {
  for (const value of ["12.50", "12,500.50", "12,501"]) {
    yield* wait(() => amountField(page).fill(value));
    yield* wait(() => expect(amountField(page)).toHaveValue(value));
    yield* wait(() => expect(amountField(page)).toHaveAttribute("aria-invalid", "true"));
    yield* wait(() => expect(page.getByRole("alert")).toContainText("Usa punto para miles"));
    yield* wait(() => expect(submit).toBeDisabled());
    yield* wait(() => amountField(page).press("Enter"));
  }
});
const registerAmounts = Effect.fn(function* (page: Page) {
  for (const [index, example] of cases.entries()) {
    yield* wait(() => page.getByRole("button", { name: "+ Registrar", exact: true }).click());
    const submit = page.getByRole("button", { name: "Registrar", exact: true });
    if (index === 0) yield* rejectInvalidAmounts(page, submit);
    yield* wait(() => amountField(page).fill(example.input));
    yield* wait(() => page.getByLabel("Contraparte (opcional)").fill(counterparty(index)));
    yield* wait(() => expect(amountField(page)).toHaveValue(example.input));
    yield* wait(() => submit.click());
    yield* wait(() =>
      expect(
        page.getByRole("button", { name: `Ver transacción ${counterparty(index)}`, exact: true })
      ).toBeVisible()
    );
  }
});
const checkPersistedAmounts = Effect.fn(function* (page: Page) {
  yield* wait(() => reloadTransactionsThroughCore(page));
  yield* wait(() =>
    page.getByRole("searchbox", { name: "Buscar transacciones" }).fill("Formato COP QA")
  );
  yield* wait(() =>
    expect(page.getByRole("region", { name: "Resumen de transacciones" })).toContainText(
      "$ 37.513,00"
    )
  );
  for (const [index, example] of cases.entries()) {
    yield* wait(() =>
      page
        .getByRole("button", { name: `Ver transacción ${counterparty(index)}`, exact: true })
        .click()
    );
    yield* wait(() => expect(amountField(page)).toHaveValue(example.draft));
    yield* wait(() => save(page).click());
    yield* wait(() => expect(save(page)).toHaveCount(0));
  }
});

const reloadFiltered = Effect.fn(function* (page: Page, total: string) {
  yield* wait(() => reloadTransactionsThroughCore(page));
  yield* wait(() =>
    page.getByRole("searchbox", { name: "Buscar transacciones" }).fill("Formato COP QA")
  );
  yield* wait(() =>
    expect(page.getByRole("region", { name: "Resumen de transacciones" })).toContainText(total)
  );
});
const openRecord = (page: Page, index: number): Promise<void> =>
  page.getByRole("button", { name: `Ver transacción ${counterparty(index)}`, exact: true }).click();
const correctAmounts = Effect.fn(function* (page: Page) {
  for (const example of [
    { input: "23.456,75", draft: "23456,75", total: "$ 48.469,75" },
    { input: "23000", draft: "23000", total: "$ 48.013,00" },
    { input: "12,50", draft: "12,5", total: "$ 25.025,50" },
    { input: "12.500", draft: "12500", total: "$ 37.513,00" },
  ]) {
    yield* wait(() => openRecord(page, 0));
    yield* rejectInvalidAmounts(page, save(page));
    yield* wait(() => amountField(page).fill(example.input));
    yield* wait(() => save(page).click());
    yield* wait(() => expect(page.getByText("Cambios guardados", { exact: true })).toBeVisible());
    yield* wait(() => expect(save(page)).toHaveCount(0));
    yield* reloadFiltered(page, example.total);
    yield* wait(() => openRecord(page, 0));
    yield* wait(() => expect(amountField(page)).toHaveValue(example.draft));
    yield* wait(() => page.getByRole("button", { name: "Cancelar", exact: true }).click());
  }
});
const correctSelection = Effect.fn(function* (page: Page) {
  yield* wait(() => page.getByRole("button", { name: "Editar varias", exact: true }).click());
  for (const index of cases.keys()) {
    yield* wait(() =>
      page
        .getByRole("checkbox", { name: `Seleccionar ${counterparty(index)}`, exact: true })
        .check()
    );
  }
  yield* wait(() =>
    page.getByRole("button", { name: "Editar selección de transacciones", exact: true }).click()
  );
  yield* rejectInvalidAmounts(page, save(page));
  yield* wait(() => amountField(page).fill("34.567,89"));
  yield* wait(() => save(page).click());
  yield* wait(() => expect(page.getByText("Cambios guardados", { exact: true })).toBeVisible());
  yield* wait(() => expect(save(page)).toHaveCount(0));
  yield* reloadFiltered(page, "$ 138.271,56");
  for (const index of cases.keys()) {
    yield* wait(() => openRecord(page, index));
    yield* wait(() => expect(amountField(page)).toHaveValue("34567,89"));
    yield* wait(() => page.getByRole("button", { name: "Cancelar", exact: true }).click());
  }
});
const persistenceJourneyMilliseconds = 90_000;
test("Colombian Money entry matches real Core/D1 registration, corrections and reloaded summaries", ({
  page,
  request,
}) => {
  test.setTimeout(persistenceJourneyMilliseconds);
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(() => signInMoneyInputThroughCore({ page, request }));
      yield* registerAmounts(page);
      yield* checkPersistedAmounts(page);
      yield* correctAmounts(page);
      yield* correctSelection(page);
    })
  );
});
