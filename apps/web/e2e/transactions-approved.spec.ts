import type { Page } from "@playwright/test";
import { type Cause, DateTime, Effect, Schema } from "effect";
import { apiOrigin, installCategories, installUser, response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";

const { test, expect } = playwright;
const wait = Effect.tryPromise;
type Journey = Effect.Effect<void, Cause.UnknownError | Schema.SchemaError>;
const createdStatus = 201;
const okStatus = 200;
const unavailableStatus = 503;
const maximumCounterparty = 120;
const maximumNotes = 500;
const maximumSelection = 12;
const identifierWidth = 12;
const maximumSingleLineHeight = 24;
const categories = [
  { id: "24000000-0000-4000-8000-000000000242", label: "Restaurantes" },
  { id: "24000000-0000-4000-8000-000000000244", label: "Transporte" },
];
const first = {
  id: "25000000-0000-4000-8000-000000000001",
  categoryId: "24000000-0000-4000-8000-000000000242",
  money: { amount: "64000", currency: "COP" },
  counterparty: "Prueba 1",
  notes: "Nota anterior",
  direction: "outflow",
  occurredAt: "2026-10-23T12:00:00.000Z",
  createdAt: "2026-10-23T12:00:00.000Z",
  revision: 1,
};
const row = (index: number, currency = "COP"): typeof first => ({
  ...first,
  id: `25000000-0000-4000-8000-${String(index).padStart(identifierWidth, "0")}`,
  money: { amount: "64000", currency },
  counterparty: `Prueba ${index}`,
  revision: index,
});
const installWorkspace = (page: Page, rows = [row(1)]): Journey =>
  Effect.gen(function* () {
    yield* wait(() =>
      page.clock.setFixedTime(DateTime.toDateUtc(DateTime.makeUnsafe("2026-10-24T12:00:00.000Z")))
    );
    yield* wait(() => installUser(page));
    yield* wait(() => installCategories({ page, categories }));
    yield* wait(() =>
      page.route(`${apiOrigin}/web/session/binding`, (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ binding: null }),
        })
      )
    );
    yield* wait(() =>
      page.route(`${apiOrigin}/transactions?*`, (route) =>
        route.fulfill({
          contentType: "application/json",
          body: response(rows),
        })
      )
    );
  });
const recordMutation = (
  page: Page,
  path: string,
  {
    requests,
    outcome,
  }: Readonly<{ requests: Array<unknown>; outcome: "capture" | "correction" | "uncertain" }>
): Journey =>
  wait(() =>
    page.route(`${apiOrigin}${path}`, (route) => {
      requests.push(route.request().postDataJSON());
      if (outcome === "uncertain") return route.abort("failed");
      return route.fulfill({
        status: outcome === "capture" ? createdStatus : okStatus,
        contentType: "application/json",
        body: response({ ...row(2), notes: undefined }),
      });
    })
  );
const openCapture = (page: Page): Journey =>
  Effect.gen(function* () {
    yield* wait(() => page.goto("/app/transactions"));
    yield* wait(() => page.getByRole("button", { name: "+ Registrar", exact: true }).click());
    yield* wait(() => page.getByLabel("Monto · COP", { exact: true }).fill("12345,67"));
  });
const captureCategoryNotes = (page: Page): Journey =>
  Effect.gen(function* () {
    yield* wait(() =>
      page.getByRole("button", { name: "Categoría: Asignar automáticamente", exact: true }).click()
    );
    yield* wait(() => page.getByRole("menuitemradio", { name: "Transporte", exact: true }).click());
    yield* wait(() =>
      page.getByLabel("Notas (opcional)", { exact: true }).fill("n".repeat(maximumNotes + 1))
    );
    yield* wait(() =>
      expect(page.getByLabel("Notas (opcional)", { exact: true })).toHaveValue(
        "n".repeat(maximumNotes)
      )
    );
  });
const captureJourney = (page: Page, explicit: boolean): Journey =>
  Effect.gen(function* () {
    yield* installWorkspace(page);
    const requests: Array<unknown> = [];
    yield* recordMutation(page, "/transactions", { requests, outcome: "capture" });
    yield* openCapture(page);
    yield* wait(() =>
      page.getByLabel("Contraparte (opcional)").fill("a".repeat(maximumCounterparty + 1))
    );
    yield* wait(() =>
      expect(page.getByLabel("Contraparte (opcional)")).toHaveValue("a".repeat(maximumCounterparty))
    );
    if (explicit) yield* captureCategoryNotes(page);
    yield* wait(() => page.getByRole("button", { name: "Registrar", exact: true }).click());
    yield* wait(() =>
      expect(page.getByText("Transacción registrada", { exact: true })).toBeVisible()
    );
    yield* wait(() =>
      expect(page.getByText("1 transacción · 0 ingresos · 1 gasto", { exact: true })).toBeVisible()
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      money: { amount: "12345.67", currency: "COP" },
      counterparty: "a".repeat(maximumCounterparty),
      direction: "outflow",
      occurredAt: "2026-10-24T05:00:00.000Z",
    });
    if (explicit) {
      expect(requests[0]).toMatchObject({
        categoryId: categories[1]?.id,
        notes: "n".repeat(maximumNotes),
      });
    } else {
      expect(requests[0]).not.toHaveProperty("categoryId");
      expect(requests[0]).not.toHaveProperty("notes");
    }
  });
for (const explicit of [false, true]) {
  test(`manual capture preserves COP and local day ${explicit ? "with selected Category and Notes" : "with automatic Category and no Notes"}`, ({
    page,
  }) => Effect.runPromise(captureJourney(page, explicit)));
}
const uncertainCaptureJourney = (page: Page): Journey =>
  Effect.gen(function* () {
    yield* installWorkspace(page);
    const requests: Array<unknown> = [];
    yield* recordMutation(page, "/transactions", { requests, outcome: "uncertain" });
    yield* openCapture(page);
    yield* wait(() => page.getByRole("button", { name: "Registrar", exact: true }).click());
    yield* wait(() =>
      expect(page.getByRole("alert")).toContainText("No pudimos confirmar el registro")
    );
    yield* wait(() =>
      expect(page.getByRole("button", { name: "Registrar", exact: true })).toBeDisabled()
    );
    yield* wait(() => expect(page.getByLabel("Monto · COP", { exact: true })).toBeDisabled());
    expect(requests).toHaveLength(1);
    yield* wait(() =>
      page.getByRole("button", { name: "Actualizar historial", exact: true }).click()
    );
    yield* wait(() =>
      expect(page.getByRole("region", { name: "Resumen de transacciones" })).toBeVisible()
    );
    expect(requests).toHaveLength(1);
  });
test("an uncertain manual capture remains locked without repeating the POST and refresh resolves it", ({
  page,
}) => Effect.runPromise(uncertainCaptureJourney(page)));
const correctionJourney = (page: Page): Journey =>
  Effect.gen(function* () {
    yield* installWorkspace(page);
    const requests: Array<unknown> = [];
    yield* recordMutation(page, `/transactions/${first.id}`, {
      requests,
      outcome: "correction",
    });
    yield* wait(() => page.goto("/app/transactions"));
    const trigger = page.getByRole("button", { name: "Ver transacción Prueba 1", exact: true });
    yield* wait(() => trigger.focus());
    yield* wait(() => trigger.press("Enter"));
    yield* wait(() =>
      expect(page.getByRole("form", { name: "Corregir transacción" })).toBeVisible()
    );
    yield* wait(() => page.getByLabel("Notas (opcional)", { exact: true }).fill("borrador"));
    yield* wait(() => page.getByRole("button", { name: "Cancelar", exact: true }).click());
    yield* wait(() => expect(trigger).toBeFocused());
    expect(requests).toHaveLength(0);
    yield* wait(() => trigger.press("Enter"));
    yield* wait(() =>
      expect(page.getByLabel("Notas (opcional)", { exact: true })).toHaveValue("Nota anterior")
    );
    yield* wait(() => page.getByLabel("Notas (opcional)", { exact: true }).fill(""));
    yield* wait(() => page.getByRole("button", { name: "Guardar", exact: true }).click());
    yield* wait(() => expect(page.getByText("Cambios guardados", { exact: true })).toBeVisible());
    expect(requests).toEqual([{ expectedRevision: 1, changes: { notes: null } }]);
  });
test("individual correction clears empty Notes at its revision and cancellation restores keyboard focus", ({
  page,
}) => Effect.runPromise(correctionJourney(page)));
const correctionRecoveryJourney = (page: Page): Journey =>
  Effect.gen(function* () {
    yield* installWorkspace(page);
    const requests: Array<unknown> = [];
    let failRead = false;
    yield* wait(() =>
      page.route(`${apiOrigin}/transactions?*`, (route) =>
        route.fulfill({
          status: failRead ? unavailableStatus : okStatus,
          contentType: "application/json",
          body: failRead ? "{}" : response([row(1)]),
        })
      )
    );
    yield* recordMutation(page, `/transactions/${first.id}`, { requests, outcome: "uncertain" });
    yield* wait(() => page.goto("/app/transactions"));
    const trigger = page.getByRole("button", { name: "Ver transacción Prueba 1", exact: true });
    yield* wait(() => trigger.click());
    yield* wait(() => page.getByLabel("Notas (opcional)", { exact: true }).fill("Corrección"));
    yield* wait(() => page.getByRole("button", { name: "Guardar", exact: true }).click());
    yield* wait(() =>
      expect(
        page.getByRole("form", { name: "Corregir transacción" }).getByRole("alert")
      ).toContainText("No pudimos confirmar")
    );
    yield* wait(() => page.getByRole("button", { name: "Cancelar", exact: true }).click());
    yield* wait(() =>
      expect(page.getByRole("button", { name: "Editar varias", exact: true })).toBeDisabled()
    );
    yield* wait(() => expect(page.locator("#transaction-date-filter")).toBeDisabled());
    failRead = true;
    yield* wait(() =>
      page.getByRole("button", { name: "Actualizar transacciones", exact: true }).click()
    );
    yield* wait(() =>
      expect(
        page.getByText("No pudimos actualizar las transacciones", { exact: true })
      ).toBeVisible()
    );
    yield* wait(() =>
      expect(page.getByRole("button", { name: "Editar varias", exact: true })).toBeDisabled()
    );
    expect(requests).toHaveLength(1);
    failRead = false;
    yield* wait(() =>
      page.getByRole("button", { name: "Actualizar transacciones", exact: true }).click()
    );
    yield* wait(() =>
      expect(page.getByRole("button", { name: "Editar varias", exact: true })).toBeEnabled()
    );
    yield* wait(() => trigger.click());
    yield* wait(() =>
      expect(page.getByRole("form", { name: "Corregir transacción" })).toBeVisible()
    );
    expect(requests).toHaveLength(1);
  });
test("Correction uncertainty survives closing the editor and a failed canonical reread without enabling another editing path", ({
  page,
}) => Effect.runPromise(correctionRecoveryJourney(page)));

const selectTwelve = (page: Page): Journey =>
  Effect.gen(function* () {
    yield* wait(() => page.goto("/app/transactions"));
    yield* wait(() => page.getByRole("button", { name: "Editar varias", exact: true }).click());
    for (let index = 1; index <= maximumSelection; index += 1) {
      yield* wait(() =>
        page.getByRole("checkbox", { name: `Seleccionar Prueba ${index}`, exact: true }).click()
      );
    }
    yield* wait(() =>
      expect(
        page.getByRole("checkbox", { name: "Seleccionar Prueba 13", exact: true })
      ).toBeDisabled()
    );
    yield* wait(() =>
      page.getByRole("button", { name: "Editar selección de transacciones", exact: true }).click()
    );
  });
const batchProbe = Schema.Struct({
  calls: Schema.Array(
    Schema.Struct({
      input: Schema.Struct({ payload: Schema.Struct({ changes: Schema.Unknown }) }),
    })
  ),
});
const bulkJourney = (page: Page): Journey =>
  Effect.gen(function* () {
    const rows = Array.from({ length: maximumSelection + 1 }, (_, index) =>
      row(index + 1, index === 0 ? "USD" : "COP")
    );
    yield* installWorkspace(page, rows);
    const batches: Array<unknown> = [];
    yield* recordMutation(page, "/operations/atomic-batch", {
      requests: batches,
      outcome: "uncertain",
    });
    yield* selectTwelve(page);
    const directionLabelHeight = yield* wait(() =>
      page
        .locator("#bulk-direction span")
        .evaluate((element) => element.getBoundingClientRect().height)
    );
    expect(directionLabelHeight).toBeLessThanOrEqual(maximumSingleLineHeight);
    yield* wait(() => expect(page.getByLabel(/^Monto · Varias monedas/u)).toBeDisabled());
    yield* wait(() =>
      page
        .getByRole("button", { name: "Categoría de la selección: Sin cambiar", exact: true })
        .click()
    );
    yield* wait(() => page.getByRole("menuitemradio", { name: "Transporte", exact: true }).click());
    yield* wait(() => page.getByRole("button", { name: "Guardar", exact: true }).click());
    yield* wait(() =>
      expect(page.getByRole("alert")).toContainText("No pudimos confirmar los cambios")
    );
    yield* wait(() =>
      expect(page.getByRole("button", { name: "Guardar", exact: true })).toBeDisabled()
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      calls: rows.slice(0, maximumSelection).map((record) => ({
        operation: "transactions.updateTransaction",
        input: { params: { id: record.id }, payload: { expectedRevision: record.revision } },
      })),
    });
    const batch = yield* Schema.decodeUnknownEffect(batchProbe)(batches[0]);
    for (const call of batch.calls) {
      expect(call.input.payload.changes).toEqual({ categoryId: categories[1]?.id });
    }
  });
test("bulk selection stops at twelve and mixed Currency keeps amount locked while empty fields preserve facts", ({
  page,
}) => Effect.runPromise(bulkJourney(page)));

const waitForFonts = (page: Page): Promise<void> =>
  page.evaluate(() => document.fonts.ready.then(() => {}));
const responsiveJourney = (page: Page): Journey =>
  Effect.gen(function* () {
    yield* wait(() => page.setViewportSize({ width: 390, height: 844 }));
    yield* installWorkspace(page);
    yield* wait(() => page.goto("/app/transactions"));
    yield* wait(() =>
      expect(page.getByText("Ingresos registrados", { exact: true })).toBeVisible()
    );
    yield* wait(() => waitForFonts(page));
    const income = yield* wait(() =>
      page.getByText("Ingresos registrados", { exact: true }).evaluate((element) => ({
        x: element.getBoundingClientRect().x,
        y: element.getBoundingClientRect().y,
      }))
    );
    const expenses = yield* wait(() =>
      page.getByText("Gastos registrados", { exact: true }).evaluate((element) => ({
        x: element.getBoundingClientRect().x,
        y: element.getBoundingClientRect().y,
      }))
    );
    const sortLabel = yield* wait(() =>
      page
        .getByRole("button", { name: "Ordenar transacciones: Ordenar", exact: true })
        .getByText("Ordenar", { exact: true })
        .evaluate((element) => element.getBoundingClientRect().height)
    );
    expect(sortLabel).toBeLessThanOrEqual(maximumSingleLineHeight);
    expect(income.y).toBe(expenses.y);
    expect(income.x).toBeLessThan(expenses.x);
    expect(
      yield* wait(() => page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    ).toBe(false);
    const trigger = page.getByRole("button", { name: "Ver transacción Prueba 1", exact: true });
    yield* wait(() => trigger.press("Enter"));
    yield* wait(() =>
      expect(
        page.getByRole("dialog", { name: "Detalle de transacción", exact: true })
      ).toBeVisible()
    );
    yield* wait(() => expect(page.getByLabel("Monto · COP", { exact: true })).toBeVisible());
    yield* wait(() => page.getByLabel("Monto · COP", { exact: true }).press("Escape"));
    yield* wait(() => expect(trigger).toBeFocused());
  });
test("mobile keeps income and expense figures side by side and returns keyboard focus after Escape", ({
  page,
}) => Effect.runPromise(responsiveJourney(page)));

const captureLayoutJourney = (page: Page): Journey =>
  Effect.gen(function* () {
    yield* wait(() => page.setViewportSize({ width: 390, height: 844 }));
    yield* installWorkspace(page);
    yield* openCapture(page);
    const notes = page.getByLabel("Notas (opcional)", { exact: true });
    yield* wait(() => notes.fill("Primera línea\nSegunda línea\nTercera línea\nCuarta línea"));
    yield* wait(() => notes.focus());
    yield* wait(() => notes.scrollIntoViewIfNeeded());
    const textarea = yield* wait(() => notes.boundingBox());
    const actions = yield* wait(() =>
      page
        .locator(
          '[aria-label="Registrar transacción"] [data-transaction-slot="transaction-form-actions"]'
        )
        .boundingBox()
    );
    expect(textarea).not.toBeNull();
    expect(actions).not.toBeNull();
    if (textarea !== null && actions !== null) {
      expect(textarea.y + textarea.height).toBeLessThanOrEqual(actions.y);
    }
    yield* wait(() => expect(notes).toBeFocused());
    yield* wait(() =>
      expect(page.getByRole("button", { name: "Registrar", exact: true })).toBeEnabled()
    );
  });
test("mobile capture keeps multiline Notes above its actions while focused and scrolled", ({
  page,
}) => Effect.runPromise(captureLayoutJourney(page)));

const integratedThemeJourney = (page: Page): Journey =>
  Effect.gen(function* () {
    yield* wait(() => page.setViewportSize({ width: 1440, height: 1000 }));
    yield* wait(() => page.emulateMedia({ colorScheme: "light" }));
    yield* installWorkspace(page);
    yield* wait(() => page.goto("/app/transactions"));
    const theme = page.getByRole("button", { name: "Activar tema oscuro", exact: true });
    yield* wait(() => expect(theme).toBeVisible());
    yield* wait(() =>
      expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeVisible()
    );
    const header = yield* wait(() =>
      page.locator('[data-transaction-slot="transaction-page-header"]').boundingBox()
    );
    const themeBounds = yield* wait(() => theme.boundingBox());
    const register = yield* wait(() =>
      page.getByRole("button", { name: "+ Registrar", exact: true }).boundingBox()
    );
    expect(header).not.toBeNull();
    expect(themeBounds).not.toBeNull();
    expect(register).not.toBeNull();
    if (header !== null && themeBounds !== null && register !== null) {
      expect(header.y).toBeLessThanOrEqual(themeBounds.y + themeBounds.height);
      expect(register.x + register.width).toBeLessThanOrEqual(themeBounds.x);
    }
    yield* wait(() => theme.click());
    yield* wait(() => expect(page.locator("html")).toHaveClass(/dark/u));
    yield* wait(() => page.reload());
    yield* wait(() => expect(page.locator("html")).toHaveClass(/dark/u));
    yield* wait(() =>
      page.getByRole("button", { name: "Activar tema claro", exact: true }).click()
    );
    yield* wait(() => expect(page.locator("html")).not.toHaveClass(/dark/u));
  });
test("integrated shell aligns Transactions header with theme and retains manual theme after reload", ({
  page,
}) => Effect.runPromise(integratedThemeJourney(page)));

const verifyMobileRegisterPosition = (page: Page): Journey =>
  Effect.gen(function* () {
    const registerBounds = yield* wait(() =>
      page.getByRole("button", { name: "+ Registrar", exact: true }).boundingBox()
    );
    const searchBounds = yield* wait(() =>
      page.getByRole("searchbox", { name: "Buscar transacciones", exact: true }).boundingBox()
    );
    expect(registerBounds).not.toBeNull();
    expect(searchBounds).not.toBeNull();
    if (registerBounds !== null && searchBounds !== null) {
      expect(registerBounds.y + registerBounds.height).toBeLessThanOrEqual(searchBounds.y);
    }
  });

const flatWorkspaceJourney = (page: Page, mobile: boolean, dark: boolean): Journey =>
  Effect.gen(function* () {
    yield* wait(() =>
      page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 })
    );
    yield* wait(() => page.emulateMedia({ colorScheme: dark ? "dark" : "light" }));
    yield* installWorkspace(page);
    yield* wait(() => page.goto("/app/transactions"));
    const records = page.locator('[data-transaction-slot="transaction-records"]');
    const panel = page.getByRole("complementary", { name: "Resumen", exact: true });
    yield* wait(() => expect(panel).toBeVisible());
    for (const surface of [records, panel]) {
      yield* wait(() => expect(surface).toHaveCSS("border-radius", "0px"));
      yield* wait(() => expect(surface).toHaveCSS("box-shadow", "none"));
    }
    yield* wait(() =>
      expect(page.getByRole("button", { name: "+ Registrar", exact: true })).not.toHaveCSS(
        "border-radius",
        "0px"
      )
    );
    if (mobile) yield* verifyMobileRegisterPosition(page);
    const ledgerBounds = yield* wait(() => records.boundingBox());
    const panelBounds = yield* wait(() => panel.boundingBox());
    expect(ledgerBounds).not.toBeNull();
    expect(panelBounds).not.toBeNull();
    if (ledgerBounds !== null && panelBounds !== null) {
      if (mobile) expect(ledgerBounds.y + ledgerBounds.height).toBe(panelBounds.y);
      else expect(ledgerBounds.x + ledgerBounds.width).toBe(panelBounds.x);
    }
    expect(
      yield* wait(() => page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    ).toBe(false);
    yield* wait(() => page.getByRole("button", { name: "Editar varias", exact: true }).click());
    yield* wait(() =>
      page.getByRole("checkbox", { name: "Seleccionar Prueba 1", exact: true }).check()
    );
    yield* wait(() =>
      expect(page.locator('[data-transaction-slot="transaction-selection-bar"]')).toHaveCSS(
        "border-radius",
        "0px"
      )
    );
    yield* wait(() =>
      expect(page.locator('[data-slot="table-row"][data-state="selected"]')).toHaveCSS(
        "clip-path",
        "none"
      )
    );
    const selectedCells = yield* wait(() =>
      page.locator('[data-slot="table-row"][data-state="selected"] [data-slot="table-cell"]').all()
    );
    for (const cell of selectedCells) {
      yield* wait(() => expect(cell).toHaveCSS("border-radius", "0px"));
    }
  });
for (const mobile of [false, true]) {
  for (const dark of [false, true]) {
    test(`flat workspace uses adjacent section planes and rounded controls on ${mobile ? "mobile" : "desktop"} in ${dark ? "dark" : "light"}`, ({
      page,
    }) => Effect.runPromise(flatWorkspaceJourney(page, mobile, dark)));
  }
}

const flatDisabledJourney = (page: Page, dark: boolean): Journey =>
  Effect.gen(function* () {
    yield* wait(() => page.emulateMedia({ colorScheme: dark ? "dark" : "light" }));
    yield* installWorkspace(page, []);
    yield* wait(() => page.goto("/app/transactions"));
    const edit = page.getByRole("button", { name: "Editar varias", exact: true });
    yield* wait(() => expect(edit).toBeDisabled());
    yield* wait(() =>
      expect(edit).toHaveCSS("background-color", dark ? "rgb(54, 54, 54)" : "rgb(231, 226, 221)")
    );
  });
for (const dark of [false, true]) {
  test(`flat workspace preserves disabled controls in ${dark ? "dark" : "light"}`, ({ page }) =>
    Effect.runPromise(flatDisabledJourney(page, dark)));
}

const flatInteractionJourney = (page: Page, dark: boolean): Journey =>
  Effect.gen(function* () {
    yield* wait(() => page.emulateMedia({ colorScheme: dark ? "dark" : "light" }));
    yield* installWorkspace(page);
    yield* wait(() => page.goto("/app/transactions"));
    const edit = page.getByRole("button", { name: "Editar varias", exact: true });
    yield* wait(() => edit.hover());
    yield* wait(() =>
      expect(edit).toHaveCSS("background-color", dark ? "rgb(46, 46, 46)" : "rgb(242, 236, 230)")
    );
    yield* wait(() => page.mouse.down());
    yield* wait(() =>
      expect(edit).toHaveCSS("background-color", dark ? "rgb(56, 56, 56)" : "rgb(232, 222, 213)")
    );
    yield* wait(() => page.mouse.move(0, 0));
    yield* wait(() => page.mouse.up());
    const sort = page.getByRole("button", { name: "Ordenar transacciones: Ordenar", exact: true });
    yield* wait(() => sort.click());
    yield* wait(() => page.mouse.move(0, 0));
    yield* wait(() => expect(sort).toHaveAttribute("aria-expanded", "true"));
    yield* wait(() =>
      expect(sort).toHaveCSS("background-color", dark ? "rgb(56, 56, 56)" : "rgb(232, 222, 213)")
    );
    yield* wait(() => page.keyboard.press("Escape"));
    yield* wait(() => page.keyboard.press("Tab"));
    yield* wait(() => sort.focus());
    yield* wait(() =>
      expect(sort).toHaveCSS("background-color", dark ? "rgb(46, 46, 46)" : "rgb(250, 227, 217)")
    );
  });
for (const dark of [false, true]) {
  test(`flat workspace preserves control hover, pressed, expanded and keyboard focus in ${dark ? "dark" : "light"}`, ({
    page,
  }) => Effect.runPromise(flatInteractionJourney(page, dark)));
}
