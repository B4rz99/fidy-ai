import { expectFinancialLabels } from "./financial-form-text";
import type { Page, Route } from "@playwright/test";
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
const maximumControlAlignmentDifference = 1;
const actionHitInset = 12;
const compactViewportWidth = 320;
const tabletViewportWidth = 768;
const desktopViewportWidth = 1280;
const fitsViewport = (): boolean => document.documentElement.scrollWidth <= window.innerWidth;
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
const installInspections = (
  page: Page,
  rows: ReadonlyArray<typeof first> | (() => ReadonlyArray<typeof first>)
): Promise<void> =>
  page
    .route(`${apiOrigin}/transactions/*`, (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const transaction = (typeof rows === "function" ? rows() : rows).find((item) =>
        route.request().url().endsWith(`/${item.id}`)
      );
      if (transaction === undefined) return route.fulfill({ status: 404 });
      return route.fulfill({
        contentType: "application/json",
        body: response({
          ...transaction,
          presentation: { kind: "independent" },
          reconciliation: { kind: "independent" },
          sources: [],
        }),
      });
    })
    .then(() => {});
// Preserve native Date subclass construction for the calendar's configured time zone.
const fixedDateNow = (): void => {
  Date.now = (): number => Date.parse("2026-10-24T12:00:00.000Z");
};
const installWorkspace = (
  page: Page,
  rows = [row(1)],
  clock: "fixed" | "native-date" = "fixed"
): Journey =>
  Effect.gen(function* () {
    if (clock === "native-date") {
      yield* wait(() => page.addInitScript(fixedDateNow));
    } else {
      yield* wait(() =>
        page.clock.setFixedTime(DateTime.toDateUtc(DateTime.makeUnsafe("2026-10-24T12:00:00.000Z")))
      );
    }
    yield* wait(() => installUser(page));
    yield* wait(() => installCategories({ page, categories }));
    yield* wait(() => installInspections(page, rows));
    yield* wait(() =>
      page.route(`${apiOrigin}/web/session/binding{,?*}`, (route) =>
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
test("identifies each daily Currency and signed amount before and after filtering", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* installWorkspace(page, [
        { ...row(1), counterparty: "Moneda COP", money: { amount: "524000", currency: "COP" } },
        { ...row(2), counterparty: "Moneda USD", money: { amount: "12.50", currency: "USD" } },
      ]);
      yield* wait(() => page.goto("/app/transactions"));
      const totals = page.getByRole("list", { name: "Totales del día por moneda", exact: true });
      yield* wait(() => expect(totals).toHaveText("COP -524.000,00USD -12,50"));
      yield* wait(() =>
        expect(totals.getByRole("listitem").filter({ hasText: "COP -524.000,00" })).toHaveText(
          "COP -524.000,00"
        )
      );
      yield* wait(() =>
        expect(totals.getByRole("listitem").filter({ hasText: "USD -12,50" })).toHaveText(
          "USD -12,50"
        )
      );
      yield* wait(() =>
        expect(
          page.getByRole("button", { name: "Ver monto de Moneda USD: USD -12,50", exact: true })
        ).toBeVisible()
      );
      for (const width of [compactViewportWidth, tabletViewportWidth, desktopViewportWidth]) {
        yield* wait(() => page.setViewportSize({ width, height: 900 }));
        yield* wait(() => expect(totals).toBeVisible());
        expect(yield* wait(() => page.evaluate(fitsViewport))).toBe(true);
      }
      yield* wait(() =>
        page.getByRole("searchbox", { name: "Buscar transacciones" }).fill("Moneda USD")
      );
      yield* wait(() => expect(totals).toHaveText("USD -12,50"));
      yield* wait(() => expect(totals).not.toContainText("COP"));
      yield* wait(() => page.getByRole("searchbox", { name: "Buscar transacciones" }).clear());
      yield* wait(() => expect(totals).toHaveText("COP -524.000,00USD -12,50"));
    })
  ));
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
      if (route.request().method() === "GET") {
        return route.fulfill({
          contentType: "application/json",
          body: response({
            ...first,
            presentation: { kind: "independent" },
            reconciliation: { kind: "independent" },
            sources: [],
          }),
        });
      }
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
    yield* wait(() => page.getByLabel("Monto", { exact: true }).fill("12345,67"));
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
const expectRecoveredCapture = (page: Page): Journey =>
  Effect.gen(function* () {
    yield* wait(() => expect(page.getByLabel("Monto", { exact: true })).toHaveValue("12345,67"));
    yield* wait(() =>
      expect(page.getByLabel("Contraparte (opcional)")).toHaveValue("Tienda La Esquina")
    );
    yield* wait(() =>
      expect(page.getByLabel("Notas (opcional)")).toHaveValue("n".repeat(maximumNotes))
    );
    yield* wait(() =>
      expect(page.getByRole("button", { name: "Categoría: Transporte", exact: true })).toBeVisible()
    );
  });
const uncertainCaptureJourney = (page: Page): Journey =>
  Effect.gen(function* () {
    yield* installWorkspace(page);
    const requests: Array<unknown> = [];
    yield* recordMutation(page, "/transactions", { requests, outcome: "uncertain" });
    yield* openCapture(page);
    yield* wait(() => page.getByLabel("Contraparte (opcional)").fill("Tienda La Esquina"));
    yield* captureCategoryNotes(page);
    yield* wait(() => page.getByRole("button", { name: "Registrar", exact: true }).click());
    yield* wait(() => expect(page.getByRole("alert")).toContainText("Guardado sin confirmar"));
    yield* wait(() =>
      expect(
        page.getByRole("button", { name: "No la encontré · editar borrador", exact: true })
      ).toBeDisabled()
    );
    expect(requests).toHaveLength(1);
    yield* wait(() =>
      page.getByRole("button", { name: "Actualizar historial", exact: true }).click()
    );
    const resume = page.getByRole("button", {
      name: "No la encontré · editar borrador",
      exact: true,
    });
    yield* wait(() => expect(resume).toBeEnabled());
    yield* wait(() =>
      expect(page.getByRole("region", { name: "Datos del intento", exact: true })).toContainText(
        "COP 12.345,67"
      )
    );
    yield* wait(() =>
      expect(page.getByRole("region", { name: "Datos del intento", exact: true })).toContainText(
        "24-10-2026"
      )
    );
    yield* wait(() => resume.click());
    yield* expectRecoveredCapture(page);
    expect(requests).toHaveLength(1);
    yield* recordMutation(page, "/transactions", { requests, outcome: "capture" });
    yield* wait(() =>
      page.getByRole("button", { name: "Registrar como nueva transacción", exact: true }).click()
    );
    yield* wait(() =>
      expect(page.getByText("Transacción registrada", { exact: true })).toBeVisible()
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      money: { amount: "12345.67", currency: "COP" },
      counterparty: "Tienda La Esquina",
      notes: "n".repeat(maximumNotes),
      categoryId: categories[1]?.id,
      direction: "outflow",
      occurredAt: "2026-10-24T05:00:00.000Z",
    });
  });
test("an uncertain manual capture retains every field after checking history and requires an explicit new submission", ({
  page,
}) => Effect.runPromise(uncertainCaptureJourney(page)));
const captureRecoveryFixture = (
  page: Page,
  committed: boolean,
  requests: Array<unknown>
): Journey =>
  Effect.gen(function* () {
    yield* wait(() =>
      page.setViewportSize(committed ? { width: 390, height: 844 } : { width: 1440, height: 1000 })
    );
    yield* wait(() => page.emulateMedia({ colorScheme: committed ? "dark" : "light" }));
    const rows = [row(1)];
    yield* installWorkspace(page, rows);
    yield* recordMutation(page, "/transactions", { requests, outcome: "uncertain" });
    yield* openCapture(page);
    yield* wait(() => page.getByLabel("Contraparte (opcional)").fill("Tienda La Esquina"));
    yield* captureCategoryNotes(page);
    yield* wait(() => page.getByRole("button", { name: "Registrar", exact: true }).click());
    yield* wait(() =>
      expect(page.getByText("Guardado sin confirmar", { exact: true })).toBeVisible()
    );
    if (committed) {
      rows.push({
        ...row(2),
        counterparty: "Tienda La Esquina",
        money: { amount: "12345.67", currency: "COP" },
        categoryId: categories[1]?.id ?? "",
        notes: "n".repeat(maximumNotes),
        occurredAt: "2026-10-24T05:00:00.000Z",
      });
    }
  });
const discardRecoveredCapture = (page: Page): Journey =>
  Effect.gen(function* () {
    yield* wait(() =>
      page.getByRole("button", { name: "Descartar borrador…", exact: true }).click()
    );
    const confirmation = page.getByRole("region", {
      name: "Confirmar descarte del borrador",
      exact: true,
    });
    yield* wait(() => expect(confirmation).toContainText("no elimina ninguna transacción"));
    yield* wait(() =>
      confirmation.getByRole("button", { name: "Conservar borrador", exact: true }).click()
    );
    yield* wait(() =>
      expect(page.getByRole("region", { name: "Datos del intento", exact: true })).toContainText(
        "Tienda La Esquina"
      )
    );
    yield* wait(() =>
      page.getByRole("button", { name: "Descartar borrador…", exact: true }).click()
    );
    yield* wait(() =>
      confirmation.getByRole("button", { name: "Descartar borrador", exact: true }).click()
    );
    yield* wait(() =>
      expect(page.getByRole("button", { name: "Ver borrador", exact: true })).toBeHidden()
    );
  });
const expectOriginalCapture = (page: Page, committed: boolean): Journey =>
  Effect.gen(function* () {
    const original = page.getByRole("button", {
      name: "Ver transacción Tienda La Esquina",
      exact: true,
    });
    if (committed) yield* wait(() => expect(original).toBeVisible());
    else yield* wait(() => expect(original).toBeHidden());
  });
const failedCaptureRecoveryJourney = (page: Page, committed: boolean): Journey =>
  Effect.gen(function* () {
    const requests: Array<unknown> = [];
    yield* captureRecoveryFixture(page, committed, requests);
    let failRead = true;
    yield* wait(() =>
      page.route(`${apiOrigin}/transactions?*`, (route) =>
        failRead
          ? route.fulfill({
              status: unavailableStatus,
              contentType: "application/json",
              body: JSON.stringify({ error: "unavailable" }),
            })
          : route.fallback()
      )
    );
    yield* wait(() =>
      page.getByRole("button", { name: "Actualizar historial", exact: true }).click()
    );
    yield* wait(() =>
      expect(
        page.getByText("No pudimos actualizar las transacciones", { exact: true })
      ).toBeVisible()
    );
    const resume = page.getByRole("button", {
      name: "No la encontré · editar borrador",
      exact: true,
    });
    yield* wait(() => expect(resume).toBeDisabled());
    yield* wait(() =>
      page.getByRole("button", { name: "Ver historial · conservar borrador", exact: true }).click()
    );
    yield* wait(() => page.getByRole("button", { name: "Ver borrador", exact: true }).click());
    yield* wait(() =>
      expect(page.getByRole("region", { name: "Datos del intento", exact: true })).toContainText(
        "Tienda La Esquina"
      )
    );
    yield* wait(() => expect(resume).toBeDisabled());
    expect(requests).toHaveLength(1);
    failRead = false;
    yield* wait(() =>
      page.getByRole("button", { name: "Actualizar historial", exact: true }).click()
    );
    yield* wait(() => expect(resume).toBeEnabled());
    expect(
      yield* wait(() => page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    ).toBe(false);
    yield* wait(() =>
      page.getByRole("button", { name: "Ver historial · conservar borrador", exact: true }).click()
    );
    yield* expectOriginalCapture(page, committed);
    yield* wait(() => page.getByRole("button", { name: "Ver borrador", exact: true }).click());
    yield* discardRecoveredCapture(page);
    yield* expectOriginalCapture(page, committed);
    yield* wait(() => page.getByRole("button", { name: "+ Registrar", exact: true }).click());
    yield* wait(() => expect(page.getByLabel("Monto", { exact: true })).toHaveValue(""));
    expect(requests).toHaveLength(1);
  });
for (const committed of [false, true]) {
  test(`uncertain manual capture retains its ${committed ? "committed original on a narrow Grafito screen" : "uncommitted original on desktop"} through failed refresh, close, reread and discard without replay`, ({
    page,
  }) => Effect.runPromise(failedCaptureRecoveryJourney(page, committed)));
}
const foreignCaptureJourney = (page: Page): Journey =>
  Effect.gen(function* () {
    yield* installWorkspace(page, [row(1)], "native-date");
    const requests: Array<unknown> = [];
    yield* recordMutation(page, "/transactions", { requests, outcome: "uncertain" });
    yield* openCapture(page);
    yield* wait(() => page.getByRole("combobox", { name: "Moneda", exact: true }).click());
    yield* wait(() => page.getByLabel("Buscar: Moneda", { exact: true }).fill("USD"));
    yield* wait(() => page.getByRole("option", { name: "USD", exact: true }).click());
    yield* wait(() => page.getByRole("button", { name: "Ingreso", exact: true }).click());
    yield* wait(() => page.getByRole("button", { name: "Fecha: 24-10-2026", exact: true }).click());
    yield* wait(() => page.getByRole("button", { name: /23 de octubre de 2026/u }).click());
    yield* wait(() => page.getByRole("button", { name: "Registrar", exact: true }).click());
    yield* wait(() =>
      page.getByRole("button", { name: "Actualizar historial", exact: true }).click()
    );
    const resume = page.getByRole("button", {
      name: "No la encontré · editar borrador",
      exact: true,
    });
    yield* wait(() => expect(resume).toBeEnabled());
    yield* wait(() => resume.click());
    yield* wait(() =>
      expect(page.getByRole("combobox", { name: "Moneda", exact: true })).toHaveText("USD")
    );
    yield* wait(() =>
      expect(page.getByRole("button", { name: "Ingreso", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true"
      )
    );
    yield* wait(() =>
      expect(page.getByRole("button", { name: "Fecha: 23-10-2026", exact: true })).toBeVisible()
    );
    yield* wait(() => page.getByLabel("Monto", { exact: true }).fill("999,01"));
    const original = page.getByRole("region", { name: "Datos del intento original", exact: true });
    yield* wait(() => expect(original).toContainText("USD 12.345,67"));
    yield* wait(() => expect(original).toContainText("23-10-2026"));
    yield* wait(() => expect(original).toContainText("Ingreso"));
    yield* wait(() => page.getByRole("button", { name: "Cancelar", exact: true }).click());
    yield* wait(() => page.getByRole("button", { name: "Mes anterior", exact: true }).click());
    yield* wait(() => expect(page).toHaveURL(/month=2026-09/u));
    yield* wait(() => page.getByRole("button", { name: "Ver borrador", exact: true }).click());
    yield* wait(() => expect(page.getByLabel("Monto", { exact: true })).toHaveValue("999,01"));
    yield* wait(() => expect(original).toContainText("USD 12.345,67"));
    expect(requests).toHaveLength(1);
    yield* recordMutation(page, "/transactions", { requests, outcome: "capture" });
    yield* wait(() =>
      page.getByRole("button", { name: "Registrar como nueva transacción", exact: true }).click()
    );
    yield* wait(() =>
      expect(page.getByText("Transacción registrada", { exact: true })).toBeVisible()
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      money: { amount: "999.01", currency: "USD" },
      direction: "inflow",
      occurredAt: "2026-10-23T05:00:00.000Z",
    });
  });
test.describe("capture with browser and User time zones differing", () => {
  test.use({ timezoneId: "UTC" });
  test("an uncertain manual capture retains currency, direction and chosen date while edits leave the original attempt unchanged", ({
    page,
  }) => Effect.runPromise(foreignCaptureJourney(page)));
});
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
    yield* wait(() => page.getByRole("combobox", { name: "Moneda", exact: true }).click());
    yield* wait(() =>
      page.getByRole("combobox", { name: "Buscar: Moneda", exact: true }).fill("USD")
    );
    yield* wait(() => page.getByRole("option", { name: "USD", exact: true }).click());
    yield* wait(() => page.getByLabel("Notas (opcional)", { exact: true }).fill("borrador"));
    yield* wait(() => page.getByRole("button", { name: "Cancelar", exact: true }).click());
    yield* wait(() => expect(trigger).toBeFocused());
    expect(requests).toHaveLength(0);
    yield* wait(() => trigger.press("Enter"));
    yield* wait(() =>
      expect(page.getByLabel("Notas (opcional)", { exact: true })).toHaveValue("Nota anterior")
    );
    yield* wait(() =>
      expect(page.getByRole("combobox", { name: "Moneda", exact: true })).toHaveText("COP")
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
    yield* wait(() =>
      expect(page.getByRole("combobox", { name: "Moneda", exact: true })).toBeDisabled()
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
      page.getByRole("searchbox", { name: "Buscar transacciones", exact: true }).fill("Prueba 13")
    );
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

const expectHiddenCorrection = (batches: ReadonlyArray<unknown>): void => {
  expect(batches).toEqual([
    {
      calls: [
        {
          callId: expect.any(String),
          operation: "transactions.updateTransaction",
          input: {
            params: { id: row(1).id },
            payload: {
              expectedRevision: 1,
              changes: { counterparty: "Corrección de selección" },
            },
          },
        },
        {
          callId: expect.any(String),
          operation: "transactions.updateTransaction",
          input: {
            params: { id: row(2).id },
            payload: {
              expectedRevision: 2,
              changes: { counterparty: "Corrección de selección" },
            },
          },
        },
      ],
    },
  ]);
};

test("bulk selection survives search changes and submits hidden transactions at their revisions", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* installWorkspace(page, [row(1), row(2), row(3)]);
      const batches: Array<unknown> = [];
      yield* recordMutation(page, "/operations/atomic-batch", {
        requests: batches,
        outcome: "uncertain",
      });
      yield* wait(() => page.goto("/app/transactions"));
      yield* wait(() => page.getByRole("button", { name: "Editar varias", exact: true }).click());
      yield* wait(() =>
        page.getByRole("checkbox", { name: "Seleccionar Prueba 1", exact: true }).check()
      );
      const search = page.getByRole("searchbox", { name: "Buscar transacciones", exact: true });
      yield* wait(() => search.fill("Prueba 2"));
      yield* wait(() =>
        expect(page.getByText("1 fuera de este filtro", { exact: true }).first()).toBeVisible()
      );
      yield* wait(() =>
        page.getByRole("checkbox", { name: "Seleccionar Prueba 2", exact: true }).check()
      );
      yield* wait(() => search.fill("Sin coincidencias"));
      yield* wait(() =>
        expect(page.getByText("2 fuera de este filtro", { exact: true }).first()).toBeVisible()
      );
      yield* wait(() =>
        page.getByRole("button", { name: "Revisar selección (2)", exact: true }).click()
      );
      yield* wait(() =>
        expect(
          page.getByRole("button", { name: "Quitar Prueba 1 de la selección", exact: true })
        ).toBeVisible()
      );
      yield* wait(() =>
        page.getByRole("button", { name: "Editar selección de transacciones", exact: true }).click()
      );
      yield* wait(() =>
        page.getByLabel("Contraparte", { exact: true }).fill("Corrección de selección")
      );
      yield* wait(() => page.getByRole("button", { name: "Guardar", exact: true }).click());
      yield* wait(() =>
        expect(page.getByRole("alert")).toContainText("No pudimos confirmar los cambios")
      );
      expectHiddenCorrection(batches);
    })
  ));

const selectionPhoneWidth = 390;
const selectionDesktopWidth = 1440;
const clearHiddenSelection = (page: Page, width: number): Journey =>
  Effect.gen(function* () {
    yield* wait(() => page.setViewportSize({ width, height: 844 }));
    yield* installWorkspace(page, [row(1), row(2)]);
    yield* wait(() => page.goto("/app/transactions"));
    if (width === selectionPhoneWidth) {
      yield* wait(() =>
        page.getByRole("button", { name: "Activar tema oscuro", exact: true }).click()
      );
    }
    yield* wait(() => page.getByRole("button", { name: "Editar varias", exact: true }).click());
    for (const name of ["Seleccionar Prueba 1", "Seleccionar Prueba 2"]) {
      yield* wait(() => page.getByRole("checkbox", { name, exact: true }).check());
    }
    const search = page.getByRole("searchbox", { name: "Buscar transacciones", exact: true });
    yield* wait(() => search.fill("Sin coincidencias"));
    yield* wait(() =>
      page.getByRole("button", { name: "Revisar selección (2)", exact: true }).press("Enter")
    );
    yield* wait(() =>
      page.getByRole("button", { name: "Quitar Prueba 1 de la selección", exact: true }).click()
    );
    yield* wait(() =>
      expect(page.getByText("1 fuera de este filtro", { exact: true })).toBeVisible()
    );
    yield* wait(() =>
      expect(page.getByRole("button", { name: "Revisar selección (1)", exact: true })).toBeFocused()
    );
    yield* wait(() => page.getByRole("button", { name: "Limpiar selección", exact: true }).click());
    yield* wait(() =>
      expect(
        page.getByRole("button", { name: "Filtrar por tipo: Todas las transacciones", exact: true })
      ).toBeFocused()
    );
    yield* wait(() =>
      expect(
        page.getByRole("button", { name: "Editar selección de transacciones", exact: true })
      ).toBeDisabled()
    );
    yield* wait(() => search.fill(""));
    for (const name of ["Seleccionar Prueba 1", "Seleccionar Prueba 2"]) {
      yield* wait(() =>
        expect(page.getByRole("checkbox", { name, exact: true })).not.toBeChecked()
      );
    }
    expect(
      yield* wait(() => page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    ).toBe(false);
  });
for (const width of [selectionPhoneWidth, selectionDesktopWidth]) {
  test(`hidden bulk selections can be removed and explicitly cleared at ${width}px`, ({ page }) =>
    Effect.runPromise(clearHiddenSelection(page, width)));
}

const fitsHorizontally = (element: Element): boolean => element.scrollWidth <= element.clientWidth;
test("changing the transaction month requires explicitly discarding a nonempty selection", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(() => page.setViewportSize({ width: selectionPhoneWidth, height: 844 }));
      yield* installWorkspace(page);
      yield* wait(() => page.goto("/app/transactions"));
      yield* wait(() => page.getByRole("button", { name: "Editar varias", exact: true }).click());
      const checkbox = page.getByRole("checkbox", { name: "Seleccionar Prueba 1", exact: true });
      yield* wait(() => checkbox.check());
      const month = page.getByLabel("Mes de transacciones", { exact: true });
      yield* wait(() => page.evaluate(enlargeApplicationText));
      yield* wait(() => month.selectOption("09"));
      yield* wait(() =>
        expect(
          page.getByRole("dialog", {
            name: "¿Limpiar la selección para cambiar de vista?",
            exact: true,
          })
        ).toBeVisible()
      );
      const dialog = page.getByRole("dialog", {
        name: "¿Limpiar la selección para cambiar de vista?",
        exact: true,
      });
      expect(yield* wait(() => dialog.evaluate(fitsHorizontally))).toBe(true);
      yield* wait(() =>
        page.getByRole("button", { name: "Conservar selección", exact: true }).click()
      );
      yield* wait(() => expect(month).toHaveValue("10"));
      yield* wait(() => expect(checkbox).toBeChecked());
      yield* wait(() => month.selectOption("09"));
      yield* wait(() =>
        page.getByRole("button", { name: "Limpiar selección y continuar", exact: true }).click()
      );
      yield* wait(() => expect(month).toHaveValue("09"));
      yield* wait(() =>
        expect(page.getByRole("button", { name: "Editar varias", exact: true })).toBeVisible()
      );
    })
  ));

const waitForFonts = (page: Page): Promise<void> =>
  page.evaluate(() => document.fonts.ready.then(() => {}));
const headerAgentJourney = (page: Page): Journey =>
  Effect.gen(function* () {
    yield* wait(() => page.setViewportSize({ width: 1280, height: 720 }));
    yield* installWorkspace(page);
    yield* wait(() => page.goto("/app/transactions"));
    const agent = page.getByRole("button", { name: "Abrir agente Fidy", exact: true });
    const theme = page.getByRole("button", { name: /Activar tema (claro|oscuro)/u });
    const agentBounds = yield* wait(() => agent.boundingBox());
    const themeBounds = yield* wait(() => theme.boundingBox());
    expect(agentBounds).not.toBeNull();
    expect(themeBounds).not.toBeNull();
    if (agentBounds === null || themeBounds === null) throw new Error("Expected header controls");
    expect(agentBounds.y).toBe(themeBounds.y);
    expect(agentBounds.x + agentBounds.width).toBeLessThan(themeBounds.x);
    const registerBounds = yield* wait(() =>
      page.getByRole("button", { name: "+ Registrar", exact: true }).boundingBox()
    );
    if (registerBounds === null) throw new Error("Expected registration action");
    expect(registerBounds.x + registerBounds.width).toBeLessThan(agentBounds.x);
    yield* wait(() => agent.click());
    const chat = page.getByRole("dialog", { name: "Agente Fidy", exact: true });
    yield* wait(() => expect(chat).toBeVisible());
    const chatBounds = yield* wait(() => chat.boundingBox());
    expect(chatBounds).not.toBeNull();
    if (chatBounds === null) throw new Error("Expected chat bounds");
    expect(chatBounds.y).toBeGreaterThan(agentBounds.y + agentBounds.height);
    yield* wait(() => expect(page.getByLabel("Mensaje", { exact: true })).toBeInViewport());
    yield* wait(() => page.getByRole("button", { name: "Cerrar chat", exact: true }).click());
    yield* wait(() => page.getByRole("button", { name: "+ Registrar", exact: true }).click());
    yield* wait(() => page.getByRole("button", { name: "Cerrar registro", exact: true }).click());
    expect(yield* wait(() => agent.boundingBox())).toEqual(agentBounds);
  });
test("the assistant stays beside the theme switch before and after transaction editing and opens below it", ({
  page,
}) => Effect.runPromise(headerAgentJourney(page)));
const clearFormFooter = (page: Page, formName: string, submitLabel: string): Journey =>
  Effect.gen(function* () {
    const form = page.getByRole("form", { name: formName, exact: true });
    const cancel = form.getByRole("button", { name: "Cancelar", exact: true });
    const submit = form.getByRole("button", { name: submitLabel, exact: true });
    const agent = page.getByRole("button", { name: "Abrir agente Fidy", exact: true });
    for (const action of [cancel, submit]) {
      yield* wait(() => action.scrollIntoViewIfNeeded());
      yield* wait(() => expect(action).toBeInViewport({ ratio: 1 }));
      const bounds = yield* wait(() => action.boundingBox());
      if (bounds === null) throw new Error("Expected form action");
      yield* wait(() =>
        action.click({
          trial: true,
          position: { x: bounds.width - actionHitInset, y: bounds.height - actionHitInset },
        })
      );
    }
    yield* wait(() => cancel.focus());
    yield* wait(() => page.keyboard.press("Tab"));
    yield* wait(() => expect(submit).toBeFocused());
    yield* wait(() => cancel.tap());
    yield* wait(() => expect(form).toBeHidden());
    yield* wait(() => agent.tap());
    yield* wait(() => expect(page.getByLabel("Mensaje", { exact: true })).toBeInViewport());
    yield* wait(() => page.getByRole("button", { name: "Cerrar chat", exact: true }).tap());
  });
const clearEditingActionsJourney = (
  page: Page,
  viewport: Readonly<{ width: number; height: number }>
): Journey =>
  Effect.gen(function* () {
    yield* wait(() => page.setViewportSize(viewport));
    yield* installWorkspace(page);
    yield* openCapture(page);
    yield* clearFormFooter(page, "Registrar transacción", "Registrar");
    yield* wait(() =>
      page.getByRole("button", { name: "Ver transacción Prueba 1", exact: true }).click()
    );
    yield* clearFormFooter(page, "Corregir transacción", "Guardar");
    yield* wait(() => page.getByRole("button", { name: "Editar varias", exact: true }).click());
    yield* wait(() =>
      page.getByRole("checkbox", { name: "Seleccionar Prueba 1", exact: true }).check()
    );
    yield* wait(() =>
      page.getByRole("button", { name: "Editar selección de transacciones", exact: true }).click()
    );
    yield* clearFormFooter(page, "Editar transacciones seleccionadas", "Guardar");
  });
test.describe("transaction actions remain clear of the assistant", () => {
  test.use({ hasTouch: true });
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1024, height: 600 },
    { width: 390, height: 844 },
    { width: 667, height: 390 },
  ]) {
    test(`registration and correction actions support pointer, touch and keyboard at ${viewport.width} × ${viewport.height}`, ({
      page,
    }) => Effect.runPromise(clearEditingActionsJourney(page, viewport)));
  }
});
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
    yield* wait(() => expect(page.getByLabel("Monto", { exact: true })).toBeVisible());
    yield* wait(() => page.getByLabel("Monto", { exact: true }).press("Escape"));
    yield* wait(() => expect(trigger).toBeFocused());
  });
test("mobile keeps income and expense figures side by side and returns keyboard focus after Escape", ({
  page,
}) => Effect.runPromise(responsiveJourney(page)));

const reportedCounterpartyRepeats = 12;
const maximumCounterpartyRepeats = 15;
const fitsPage = (): boolean => document.documentElement.scrollWidth <= innerWidth;
const textFitsBounds = (element: HTMLElement | SVGElement): boolean => {
  const range = document.createRange();
  range.selectNodeContents(element);
  const bounds = element.getBoundingClientRect();
  return Array.from(range.getClientRects()).every(
    (rect) =>
      rect.left >= bounds.left &&
      rect.right <= bounds.right &&
      rect.top >= bounds.top &&
      rect.bottom <= bounds.bottom
  );
};
const longCounterpartyJourney = (
  page: Page,
  counterparty: string,
  { dark, width }: Readonly<{ dark: boolean; width: number }>
): Journey =>
  Effect.gen(function* () {
    yield* wait(() => page.emulateMedia({ colorScheme: dark ? "dark" : "light" }));
    yield* wait(() => page.setViewportSize({ width, height: 800 }));
    yield* installWorkspace(page, [{ ...first, counterparty }]);
    yield* wait(() => page.goto("/app/transactions"));
    const trigger = page.getByRole("button", {
      name: `Ver transacción ${counterparty}`,
      exact: true,
    });
    yield* wait(() => trigger.click());
    const detail = page.getByRole("dialog", { name: "Detalle de transacción", exact: true });
    yield* wait(() => expect(detail).toBeVisible());
    yield* wait(() => waitForFonts(page));
    const name = detail.getByText(counterparty, { exact: true });
    yield* wait(() => expect(name).toBeVisible());
    yield* wait(() => expect.poll(() => page.evaluate(fitsPage)).toBe(true));
    expect(yield* wait(() => name.evaluate(textFitsBounds))).toBe(true);
    yield* wait(() =>
      expect(page.getByLabel("Contraparte", { exact: true })).toHaveValue(counterparty)
    );
    yield* wait(() =>
      page.getByLabel("Notas (opcional)", { exact: true }).fill("Compra de prueba")
    );
    yield* wait(() =>
      expect(detail.getByRole("button", { name: "Guardar", exact: true })).toBeEnabled()
    );
    yield* wait(() =>
      detail.getByRole("button", { name: "Guardar", exact: true }).click({ trial: true })
    );
    yield* wait(() => detail.getByRole("button", { name: "Cancelar", exact: true }).click());
    yield* wait(() => expect(trigger).toBeFocused());
    yield* wait(() => expect.poll(() => page.evaluate(fitsPage)).toBe(true));
  });
for (const dark of [false, true]) {
  for (const example of [
    { label: "96-character unbroken", name: "FARMACIA".repeat(reportedCounterpartyRepeats) },
    { label: "120-character unbroken", name: "FARMACIA".repeat(maximumCounterpartyRepeats) },
    { label: "spaced", name: "Farmacia La Rebaja Sucursal Centro Servicio Farmacéutico Bogotá" },
  ]) {
    test(`${example.label} Counterparty stays fully readable with reachable correction controls at 320px in ${dark ? "Grafito" : "light"}`, ({
      page,
    }) => Effect.runPromise(longCounterpartyJourney(page, example.name, { dark, width: 320 })));
  }
}
test("120-character Counterparty stays fully readable in the desktop detail rail", ({ page }) =>
  Effect.runPromise(
    longCounterpartyJourney(page, "FARMACIA".repeat(maximumCounterpartyRepeats), {
      dark: false,
      width: 1440,
    })
  ));

const enlargeApplicationText = (): void => {
  document.documentElement.style.fontSize = "32px";
};
const captureTextWidths = { narrow: 320, intermediate: 900, mobile: 390 };
const captureOverflows = (): boolean => document.documentElement.scrollWidth > window.innerWidth;
const captureLayoutJourney = (page: Page): Journey =>
  Effect.gen(function* () {
    yield* wait(() => page.setViewportSize({ width: 390, height: 844 }));
    yield* installWorkspace(page);
    yield* openCapture(page);
    const notes = page.getByLabel("Notas (opcional)", { exact: true });
    const amount = page.getByLabel("Monto", { exact: true });
    const fields = [amount, page.getByLabel("Contraparte (opcional)", { exact: true }), notes];
    yield* wait(() => expect(amount).toHaveAttribute("inputmode", "decimal"));
    const form = page.getByRole("form", { name: "Registrar transacción" });
    yield* expectFinancialLabels(form, "14px");
    for (const field of fields) {
      yield* wait(() => expect(field).toHaveCSS("font-size", "16px"));
    }
    yield* wait(() => page.evaluate(enlargeApplicationText));
    yield* expectFinancialLabels(form, "28px");
    for (const name of [/^Categoría:/u, /^Fecha:/u]) {
      yield* wait(() => expect(form.getByRole("button", { name })).toHaveCSS("font-size", "26px"));
    }
    for (const field of fields) {
      yield* wait(() => expect(field).toHaveCSS("font-size", "32px"));
    }
    expect(yield* wait(() => page.evaluate(captureOverflows))).toBe(false);
    yield* wait(() =>
      page.getByRole("button", { name: "Activar tema oscuro", exact: true }).click()
    );
    for (const field of fields) {
      yield* wait(() => expect(field).toHaveCSS("font-size", "32px"));
    }
    for (const width of Object.values(captureTextWidths)) {
      yield* wait(() => page.setViewportSize({ width, height: 844 }));
      yield* expectFinancialLabels(form, "28px");
      expect(yield* wait(() => page.evaluate(captureOverflows))).toBe(false);
    }
    yield* wait(() =>
      page.screenshot({ path: test.info().outputPath("capture-enlarged-dark.png"), fullPage: true })
    );
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

const correctionLayout = (page: Page): Journey =>
  Effect.gen(function* () {
    yield* wait(() =>
      page.getByRole("button", { name: "Ver transacción Prueba 1", exact: true }).click()
    );
    const amount = page.getByLabel("Monto", { exact: true });
    const currency = page.getByRole("combobox", { name: "Moneda", exact: true });
    yield* wait(() => expect(currency).toHaveText("COP"));
    const amountBounds = yield* wait(() => amount.boundingBox());
    const currencyBounds = yield* wait(() => currency.boundingBox());
    expect(amountBounds).not.toBeNull();
    expect(currencyBounds).not.toBeNull();
    if (amountBounds !== null && currencyBounds !== null) {
      expect(Math.abs(amountBounds.y - currencyBounds.y)).toBeLessThanOrEqual(
        maximumControlAlignmentDifference
      );
      expect(amountBounds.x + amountBounds.width).toBeLessThan(currencyBounds.x);
    }
    expect(
      yield* wait(() => page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    ).toBe(false);
    yield* wait(() =>
      page.screenshot({ path: test.info().outputPath("currency-correction.png"), fullPage: true })
    );
    yield* wait(() => page.getByRole("button", { name: "Cancelar", exact: true }).click());
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
    yield* correctionLayout(page);
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

const rejectedStatus = 400;
const recoveryViewports = {
  narrow: { width: 320, height: 853 },
  wide: { width: 1280, height: 853 },
};
type RecoveryFixture = { requests: Array<unknown>; rejected: boolean; retry: boolean };
const installRejectedCorrection = (
  page: Page,
  failRefresh: boolean
): Effect.Effect<RecoveryFixture, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    yield* installWorkspace(page);
    const state: RecoveryFixture = { requests: [], rejected: false, retry: false };
    const { requests } = state;
    yield* wait(() =>
      page.route(`${apiOrigin}/transactions?*`, (route) =>
        route.fulfill({
          status: state.rejected && failRefresh && !state.retry ? unavailableStatus : okStatus,
          contentType: "application/json",
          body: response([{ ...first, revision: state.rejected ? 2 : 1 }]),
        })
      )
    );
    yield* wait(() =>
      page.route(`${apiOrigin}/transactions/${first.id}`, (route) => {
        if (route.request().method() === "GET") return route.fallback();
        requests.push(route.request().postDataJSON());
        state.rejected = true;
        return route.fulfill({
          status: requests.length === 1 ? rejectedStatus : okStatus,
          contentType: "application/json",
          body:
            requests.length === 1
              ? JSON.stringify({
                  error: { code: "validation_failed", message: "Invalid", fields: [] },
                  next: [],
                })
              : response({
                  ...first,
                  revision: 3,
                  notes: "Nota sin guardar",
                  money: { amount: "30000", currency: "COP" },
                }),
        });
      })
    );
    return state;
  });
const rejectedCorrectionJourney = (page: Page, failRefresh: boolean): Journey =>
  Effect.gen(function* () {
    const state = yield* installRejectedCorrection(page, failRefresh);
    const { requests } = state;
    yield* wait(() => page.goto("/app/transactions"));
    yield* wait(() =>
      page.getByRole("button", { name: "Ver transacción Prueba 1", exact: true }).press("Enter")
    );
    yield* wait(() =>
      page.getByLabel("Notas (opcional)", { exact: true }).fill("Nota sin guardar")
    );
    yield* wait(() => page.getByLabel("Monto", { exact: true }).fill("30.000"));
    const save = page.getByRole("button", { name: "Guardar", exact: true });
    yield* wait(() => save.press("Enter"));
    if (failRefresh) {
      yield* wait(() =>
        expect(page.getByRole("form", { name: "Corregir transacción" })).toContainText(
          "No pudimos actualizar el historial"
        )
      );
      yield* wait(() => expect(save).toBeDisabled());
      expect(requests).toHaveLength(1);
      state.retry = true;
      yield* wait(() =>
        page.getByRole("button", { name: "Reintentar", exact: true }).press("Enter")
      );
    }
    yield* wait(() =>
      expect(page.getByRole("form", { name: "Corregir transacción" })).toContainText(
        "Ya actualizamos el historial"
      )
    );
    yield* wait(() =>
      expect(page.getByLabel("Notas (opcional)", { exact: true })).toHaveValue("Nota sin guardar")
    );
    yield* wait(() => expect(page.getByLabel("Monto", { exact: true })).toHaveValue("30.000"));
    yield* wait(() => expect(save).toBeEnabled());
    yield* wait(() =>
      page.screenshot({ path: test.info().outputPath("correction-recovered.png"), fullPage: true })
    );
    expect(requests).toHaveLength(1);
    yield* wait(() => save.press("Enter"));
    yield* wait(() => expect(page.getByText("Cambios guardados", { exact: true })).toBeVisible());
    expect(requests[1]).toEqual({
      expectedRevision: 2,
      changes: { notes: "Nota sin guardar", money: { amount: "30000", currency: "COP" } },
    });
  });
for (const failRefresh of [false, true]) {
  test(`rejected Correction preserves its draft through ${failRefresh ? "failed refresh and explicit retry" : "automatic refresh at 320px"} without replay`, ({
    page,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* wait(() =>
          page.setViewportSize(failRefresh ? recoveryViewports.wide : recoveryViewports.narrow)
        );
        yield* rejectedCorrectionJourney(page, failRefresh);
      })
    ));
}

const installRejectedBulk = (
  page: Page,
  rows: ReadonlyArray<typeof first>
): Effect.Effect<RecoveryFixture, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    yield* installWorkspace(page, [...rows]);
    const state: RecoveryFixture = { requests: [], rejected: false, retry: false };
    const { requests } = state;
    const currentRows = (): ReadonlyArray<typeof first> =>
      rows.map((record) => ({ ...record, revision: record.revision + (state.rejected ? 1 : 0) }));
    yield* wait(() => installInspections(page, currentRows));
    yield* wait(() =>
      page.route(`${apiOrigin}/transactions?*`, (route) =>
        route.fulfill({
          contentType: "application/json",
          body: response(currentRows()),
        })
      )
    );
    yield* wait(() =>
      page.route(`${apiOrigin}/operations/atomic-batch`, (route) => {
        requests.push(route.request().postDataJSON());
        state.rejected = true;
        return route.fulfill({
          status: rejectedStatus,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "validation_failed",
              message: "Invalid",
              failedCallIndex: 0,
              operation: "transactions.updateTransaction",
              fields: [],
            },
            next: [],
          }),
        });
      })
    );
    return state;
  });
const cancelRecoveredBulk = (page: Page): Journey =>
  Effect.gen(function* () {
    const form = page.getByRole("form", { name: "Editar transacciones seleccionadas" });
    yield* wait(() => expect(form).toContainText("Ya actualizamos el historial"));
    yield* wait(() => page.getByRole("button", { name: "Cancelar", exact: true }).press("Enter"));
    yield* wait(() =>
      page.getByRole("searchbox", { name: "Buscar transacciones", exact: true }).fill("")
    );
    yield* wait(() =>
      page.getByRole("button", { name: "Ver transacción Prueba 1", exact: true }).press("Enter")
    );
    yield* wait(() =>
      expect(page.getByLabel("Notas (opcional)", { exact: true })).toHaveValue("Nota anterior")
    );
    yield* wait(() =>
      expect(page.getByRole("form", { name: "Corregir transacción" })).not.toContainText(
        "Ya actualizamos el historial"
      )
    );
  });
const rejectedBulkJourney = (page: Page): Journey =>
  Effect.gen(function* () {
    const rows = Array.from({ length: maximumSelection + 1 }, (_, index) => row(index + 1));
    const { requests } = yield* installRejectedBulk(page, rows);
    yield* selectTwelve(page);
    yield* wait(() =>
      page
        .getByRole("button", { name: "Categoría de la selección: Sin cambiar", exact: true })
        .click()
    );
    yield* wait(() => page.getByRole("menuitemradio", { name: "Transporte", exact: true }).click());
    yield* wait(() => page.getByLabel("Notas", { exact: true }).fill("Lote sin guardar"));
    yield* wait(() => page.getByLabel("Monto · COP", { exact: true }).fill("31.000"));
    yield* wait(() => page.getByRole("button", { name: "Guardar", exact: true }).press("Enter"));
    const form = page.getByRole("form", { name: "Editar transacciones seleccionadas" });
    yield* wait(() => expect(form).toContainText("Ya actualizamos el historial"));
    yield* wait(() => expect(form).toContainText("12 transacciones seleccionadas"));
    yield* wait(() =>
      expect(page.getByLabel("Notas", { exact: true })).toHaveValue("Lote sin guardar")
    );
    yield* wait(() =>
      expect(page.getByLabel("Monto · COP", { exact: true })).toHaveValue("31.000")
    );
    yield* wait(() =>
      expect(
        page.getByRole("button", { name: "Categoría de la selección: Transporte", exact: true })
      ).toBeEnabled()
    );
    expect(requests).toHaveLength(1);
    yield* wait(() => page.getByRole("button", { name: "Guardar", exact: true }).press("Enter"));
    yield* wait(() => expect.poll(() => requests.length).toBe(2));
    expect(requests[1]).toMatchObject({
      calls: rows.slice(0, maximumSelection).map((record) => ({
        operation: "transactions.updateTransaction",
        input: {
          params: { id: record.id },
          payload: {
            expectedRevision: record.revision + 1,
            changes: {
              categoryId: categories[1]?.id,
              notes: "Lote sin guardar",
              money: { amount: "31000", currency: "COP" },
            },
          },
        },
      })),
    });
    yield* cancelRecoveredBulk(page);
  });
test("rejected atomic Correction retains twelve selections and financial fields for an explicit save at fresh revisions", ({
  page,
}) => Effect.runPromise(rejectedBulkJourney(page)));

const fulfillInlineRead = (
  route: Route,
  state: RecoveryFixture,
  gate: Promise<void>
): Promise<void> =>
  (state.rejected ? gate : Promise.resolve()).then(() =>
    route.fulfill({
      contentType: "application/json",
      body: response([{ ...first, revision: state.rejected ? 2 : 1 }]),
    })
  );
const rejectedInlineJourney = (page: Page): Journey =>
  Effect.gen(function* () {
    const state = yield* installRejectedCorrection(page, false);
    const gate = Promise.withResolvers<void>();
    yield* wait(() =>
      page.route(`${apiOrigin}/transactions?*`, (route) =>
        fulfillInlineRead(route, state, gate.promise)
      )
    );
    try {
      yield* wait(() => page.goto("/app/transactions"));
      const category = page.getByRole("button", {
        name: "Cambiar categoría de Prueba 1",
        exact: true,
      });
      yield* wait(() => category.click());
      yield* wait(() =>
        page.getByRole("menuitemradio", { name: "Transporte", exact: true }).click()
      );
      yield* wait(() =>
        expect(
          page.getByText("No se guardó la categoría. Actualizando el historial automáticamente.", {
            exact: true,
          })
        ).toBeVisible()
      );
      expect(state.requests).toHaveLength(1);
      gate.resolve();
      yield* wait(() =>
        expect(
          page.getByText(
            "No se guardó la categoría. Ya actualizamos el historial. Puedes volver a elegirla.",
            { exact: true }
          )
        ).toBeVisible()
      );
      yield* wait(() => expect(category).toBeEnabled());
      expect(state.requests).toHaveLength(1);
    } finally {
      gate.resolve();
    }
  });
test("rejected inline Category keeps failure feedback distinct during and after automatic refresh", ({
  page,
}) => Effect.runPromise(rejectedInlineJourney(page)));
