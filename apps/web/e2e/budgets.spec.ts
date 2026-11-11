import { captureVisualEvidence } from "./visual-evidence";
import { analyzeAccessibility } from "./accessibility";
import type { Page, Route } from "@playwright/test";
import { type Cause, Effect } from "effect";
import { apiOrigin, installCategories, installUser, response } from "./http-fixtures";
import { signInBudgetEditingThroughCore } from "./real-core-fixture";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;
const budgetJourneyMilliseconds = 60_000;
const installBudgetUser = (page: Page): Promise<void> =>
  installUser(page)
    .then(() =>
      page.route(`${apiOrigin}/web/session/binding`, (route) =>
        route.fulfill({ json: { binding: null } })
      )
    )
    .then(() => {});

const categories = [
  { id: "24000000-0000-4000-8000-000000000301", label: "Vivienda" },
  { id: "24000000-0000-4000-8000-000000000302", label: "Restaurantes" },
  { id: "24000000-0000-4000-8000-000000000303", label: "Mercado" },
];
const period = {
  from: "2026-10-01T05:00:00Z",
  to: "2026-11-01T05:00:00Z",
  timeZone: "America/Bogota",
};
const budget = ({
  index,
  amount,
  currency,
  groupName,
}: Readonly<{ index: number; amount: string; currency: string; groupName: string }>): object => ({
  id: `24000000-0000-4000-8000-00000000031${index}`,
  categoryId: categories[index]?.id,
  cap: { amount, currency },
  groupName,
  createdAt: "2026-10-01T12:00:00Z",
  updatedAt: "2026-10-01T12:00:00Z",
});
const reportBase = {
  period,
  initialized: true,
  unbudgetedExpenses: [],
  cashFlow: {
    income: [{ amount: "300000", currency: "COP" }],
    expenses: [
      { amount: "130000", currency: "COP" },
      { amount: "10.1", currency: "USD" },
    ],
  },
  statuses: [
    {
      budget: budget({ index: 0, amount: "100000", currency: "COP", groupName: "Hogar" }),
      spent: { amount: "130000", currency: "COP" },
      period,
      type: "over",
      overBy: { amount: "30000", currency: "COP" },
    },
    {
      budget: budget({ index: 1, amount: "50.25", currency: "USD", groupName: "Alimentación" }),
      spent: { amount: "10.1", currency: "USD" },
      period,
      type: "under",
      remaining: { amount: "40.15", currency: "USD" },
    },
  ],
};

const report = { ...reportBase, budgets: reportBase.statuses.map((status) => status.budget) };

const deletedReport = {
  ...report,
  budgets: report.budgets.slice(1),
  statuses: report.statuses.slice(1),
  unbudgetedExpenses: [
    { categoryId: categories[0]?.id, spent: { amount: "130000", currency: "COP" } },
  ],
};

const fitsViewport = (): boolean => document.documentElement.scrollWidth <= window.innerWidth;
const installBudgetReport = (page: Page): Promise<unknown> =>
  page
    .route(`${apiOrigin}/budget-status?**`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: response(report) })
    )
    .then(() =>
      page.route(`${apiOrigin}/budgets`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: response(report.statuses.map((status) => status.budget)),
        })
      )
    );
const installLostAcknowledgement = ({
  page,
  edits,
}: Readonly<{ page: Page; edits: { count: number } }>): Promise<unknown> =>
  page.route(`${apiOrigin}/budgets/*`, (route) => {
    edits.count += 1;
    return route.abort("failed");
  });

const checkAccessibility = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise(() => analyzeAccessibility(page));
    expect(
      result.violations.filter(({ impact }) => impact === "serious" || impact === "critical")
    ).toEqual([]);
  });

const checkAmountEntry = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const input = page.getByLabel("Presupuesto de Vivienda (COP)");
    yield* Effect.tryPromise(() => input.pressSequentially("abc"));
    yield* Effect.tryPromise(() => expect(input).toHaveValue("100000"));
    yield* Effect.tryPromise(() => input.fill("12abc34"));
    yield* Effect.tryPromise(() => expect(input).toHaveValue("100000"));
  });

const checkSummaryViews = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Ingresos", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("region", { name: "Resumen COP" })).toContainText("300.000")
    );
    yield* Effect.tryPromise(() =>
      expect(
        page
          .getByRole("region", { name: "Resumen COP" })
          .getByRole("heading", { name: "Gasto total del mes", exact: true })
      ).toHaveCount(0)
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Resumen", exact: true }).click()
    );
  });

const checkCurrencyPresentation = Effect.fn(function* (page: Page) {
  const group = page.getByRole("region", { name: "Grupo Alimentación USD", exact: true });
  yield* Effect.tryPromise(() => expect(group).toBeVisible());
  yield* Effect.tryPromise(() =>
    expect(group.getByRole("heading", { name: "Alimentación USD" })).toBeVisible()
  );
  yield* Effect.tryPromise(() => expect(group.getByText("USD 50,25")).toBeVisible());
  yield* Effect.tryPromise(() =>
    expect(group.getByText("USD 40,15", { exact: true })).toHaveCount(2)
  );
  yield* Effect.tryPromise(() =>
    expect(group.getByRole("button", { name: /Ver movimientos de Restaurantes/u })).toHaveText(
      "USD 10,10"
    )
  );
  const input = group.getByRole("textbox", { name: "Presupuesto de Restaurantes (USD)" });
  yield* Effect.tryPromise(() => expect(input).toHaveValue("50.25"));
  yield* Effect.tryPromise(() => expect(input).toHaveAccessibleDescription("USD"));
  yield* Effect.tryPromise(() =>
    expect(group.getByRole("progressbar")).toHaveAccessibleName("Gasto de Restaurantes: USD 10,10")
  );
  yield* Effect.tryPromise(() =>
    expect(
      page.getByRole("region", { name: "Grupo Hogar COP", exact: true }).getByText("COP 100.000,00")
    ).toBeVisible()
  );
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`identifies Budget Group and Category currencies without settings in ${colorScheme}`, ({
    page,
  }, testInfo) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() => installBudgetUser(page));
        yield* Effect.tryPromise(() => installCategories({ page, categories }));
        yield* Effect.tryPromise(() => installBudgetReport(page));
        yield* Effect.tryPromise(() => page.emulateMedia({ colorScheme }));
        yield* Effect.tryPromise(() => page.goto("/app/budgets?month=2026-10"));
        for (const viewport of [
          { width: 1920, height: 1080 },
          { width: 1440, height: 900 },
          { width: 715, height: 900 },
          { width: 320, height: 640 },
        ]) {
          yield* Effect.tryPromise(() => page.setViewportSize(viewport));
          yield* checkCurrencyPresentation(page);
          const group = page.getByRole("region", { name: "Grupo Alimentación USD", exact: true });
          expect(yield* Effect.tryPromise(() => page.evaluate(fitsViewport))).toBe(true);
          yield* Effect.tryPromise(() => group.scrollIntoViewIfNeeded());
          yield* Effect.tryPromise(() =>
            captureVisualEvidence({
              target: page,
              options: {
                path: testInfo.outputPath(`currency-${viewport.width}.png`),
                fullPage: true,
              },
            })
          );
          const toggle = group.getByRole("button", { name: "Alimentación USD", exact: true });
          yield* Effect.tryPromise(() => toggle.click());
          yield* Effect.tryPromise(() => expect(toggle).toHaveAttribute("aria-expanded", "false"));
          yield* Effect.tryPromise(() =>
            expect(group.getByRole("heading", { name: "Alimentación USD" })).toBeVisible()
          );
          yield* Effect.tryPromise(() => toggle.click());
        }
        yield* checkAccessibility(page);
      })
    ));
}

test("shows grouped currency totals and prevents replay after a lost save acknowledgement", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installBudgetUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories }));
      const edits = { count: 0 };
      yield* Effect.tryPromise(() => installBudgetReport(page));
      yield* Effect.tryPromise(() => installLostAcknowledgement({ page, edits }));
      yield* Effect.tryPromise(() => page.goto("/app/budgets?month=2026-10"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Resumen del mes" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "USD", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("region", { name: "Resumen USD" })).toContainText("40,15")
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "COP", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("region", { name: "Resumen COP" })).toContainText("excedido")
      );
      yield* checkSummaryViews(page);
      yield* checkAmountEntry(page);

      const input = page.getByLabel("Presupuesto de Vivienda (COP)");
      yield* Effect.tryPromise(() => input.fill("150000"));
      yield* Effect.tryPromise(() => input.press("Enter"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toContainText("No pudimos confirmar el guardado")
      );
      yield* Effect.tryPromise(() => expect(input).toBeDisabled());
      expect(edits.count).toBe(1);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Actualizar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(input).toHaveValue("100000"));
      yield* checkAccessibility(page);
      yield* Effect.tryPromise(() => expect(input).toBeEnabled());
      yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
      expect(yield* Effect.tryPromise(() => page.evaluate(fitsViewport))).toBe(true);
      yield* checkAccessibility(page);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Configurar Vivienda" }).click()
      );
      yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toBeVisible());
      yield* checkAccessibility(page);
    })
  ));

const checkFailedRecovery = Effect.fn(function* (page: Page) {
  const unavailable = (route: Route): Promise<void> => route.fulfill({ status: 503 });
  yield* Effect.tryPromise(() => page.route(`${apiOrigin}/budget-status?**`, unavailable));
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Actualizar", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("alert")).toContainText("No pudimos cargar tus presupuestos")
  );
  const input = page.getByLabel("Presupuesto de Vivienda (COP)");
  yield* Effect.tryPromise(() => expect(input).toHaveValue("100000"));
  yield* Effect.tryPromise(() => expect(input).toBeDisabled());
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("button", { name: "Mes siguiente" })).toBeDisabled()
  );
  yield* Effect.tryPromise(() => page.unroute(`${apiOrigin}/budget-status?**`, unavailable));
});

const checkCommittedRefresh = Effect.fn(function* (page: Page) {
  yield* Effect.tryPromise(() => installBudgetUser(page));
  yield* Effect.tryPromise(() => installCategories({ page, categories }));
  yield* Effect.tryPromise(() => installBudgetReport(page));
  let mutations = 0;
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/budgets/*`, (route) => {
      mutations += 1;
      return route.abort("failed");
    })
  );
  yield* Effect.tryPromise(() => page.goto("/app/budgets?month=2026-10"));
  const input = page.getByLabel("Presupuesto de Vivienda (COP)");
  yield* Effect.tryPromise(() => input.fill("150000"));
  yield* Effect.tryPromise(() => input.press("Enter"));
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("alert")).toContainText("No pudimos confirmar el guardado")
  );
  yield* checkFailedRecovery(page);
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/budget-status?**`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: response({
          ...report,
          budgets: [
            budget({ index: 0, amount: "150000", currency: "COP", groupName: "Hogar" }),
            report.budgets[1],
          ],
          statuses: [
            {
              budget: budget({
                index: 0,
                amount: "150000",
                currency: "COP",
                groupName: "Hogar",
              }),
              spent: { amount: "130000", currency: "COP" },
              period,
              type: "under",
              remaining: { amount: "20000", currency: "COP" },
            },
            report.statuses[1],
          ],
        }),
      })
    )
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Actualizar", exact: true }).click()
  );
  yield* Effect.tryPromise(() => expect(input).toHaveValue("150000"));
  yield* Effect.tryPromise(() => expect(input).toBeEnabled());
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("region", { name: "Resumen COP" })).toContainText("20.000")
  );
  yield* Effect.tryPromise(() => input.focus());
  yield* Effect.tryPromise(() => input.press("Tab"));
  expect(mutations).toBe(1);
});
test("an uncertain save stays locked after a failed refresh, then recovers the committed cap without replay", ({
  page,
}) => Effect.runPromise(checkCommittedRefresh(page)));

const checkEarlierMonth = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => page.goto("/app/budgets?month=2026-09"));
    yield* Effect.tryPromise(() =>
      expect(page.getByText("Aún no tienes presupuestos.", { exact: false })).toBeVisible()
    );
    yield* Effect.tryPromise(() =>
      page
        .locator("section")
        .filter({ has: page.getByRole("heading", { name: "Alimentación", exact: true }) })
        .first()
        .locator("details > summary")
        .click()
    );
    yield* Effect.tryPromise(() =>
      page
        .getByText("Restaurantes", { exact: true })
        .locator("..")
        .getByRole("button", { name: "Asignar presupuesto" })
        .click()
    );
    yield* Effect.tryPromise(() => page.getByLabel("Presupuesto", { exact: true }).fill("300000"));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Guardar presupuesto" }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Presupuesto de Restaurantes (COP)")).toHaveValue("300000")
    );
    yield* Effect.tryPromise(() => page.goto("/app/budgets?month=2026-10"));
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Presupuesto de Restaurantes (COP)")).toHaveValue("500000")
    );
  });

test("recovers initial load failure and keeps stale budgets read-only until refresh succeeds", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installBudgetUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories }));
      yield* Effect.tryPromise(() => installBudgetReport(page));
      let unavailable = true;
      const statusRoute = (route: Route): Promise<void> =>
        unavailable
          ? route.fulfill({ status: 503, contentType: "application/json", body: "{}" })
          : route.fulfill({ status: 200, contentType: "application/json", body: response(report) });
      yield* Effect.tryPromise(() => page.route(`${apiOrigin}/budget-status?**`, statusRoute));
      yield* Effect.tryPromise(() => page.goto("/app/budgets?month=2026-10"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toContainText("No pudimos cargar tus presupuestos")
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Presupuesto de Vivienda (COP)")).toHaveCount(0)
      );
      unavailable = false;
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Reintentar", exact: true }).click()
      );
      const amount = page.getByLabel("Presupuesto de Vivienda (COP)");
      yield* Effect.tryPromise(() => expect(amount).toHaveValue("100000"));
      unavailable = true;
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Actualizar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toContainText("No pudimos cargar tus presupuestos")
      );
      yield* Effect.tryPromise(() => expect(amount).toHaveValue("100000"));
      yield* Effect.tryPromise(() => expect(amount).toBeDisabled());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Mes siguiente" })).toBeDisabled()
      );
      unavailable = false;
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Reintentar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(amount).toBeEnabled());
      yield* Effect.tryPromise(() => expect(page.getByRole("alert")).toHaveCount(0));
    })
  ));

const checkCleanEditor = Effect.fn(function* (page: Page, category: string) {
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: `Configurar ${category}`, exact: true }).click()
  );
  const editor = page.getByRole("form", { name: `Configurar presupuesto de ${category}` });
  yield* Effect.tryPromise(() => expect(editor.getByRole("status")).toHaveCount(0));
  yield* Effect.tryPromise(() => expect(editor.getByRole("alert")).toHaveCount(0));
  yield* Effect.tryPromise(() =>
    editor.getByRole("button", { name: "Cerrar", exact: true }).click()
  );
});

test("saves a monthly cap from the view through real Core and retains it after reload", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      test.setTimeout(budgetJourneyMilliseconds);
      yield* Effect.tryPromise(() =>
        signInBudgetEditingThroughCore({ page, deferFreshEntry: true, request })
      );
      yield* Effect.tryPromise(() => page.clock.resume());
      yield* Effect.tryPromise(() => page.goto("/app/budgets?month=2026-10"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Presupuestos", exact: true })).toBeVisible()
      );
      const group = page
        .locator("section")
        .filter({ has: page.getByRole("heading", { name: "Alimentación", exact: true }) })
        .first();
      yield* Effect.tryPromise(() => group.locator("details > summary").click());
      yield* Effect.tryPromise(() =>
        page
          .getByText("Restaurantes", { exact: true })
          .locator("..")
          .getByRole("button", { name: "Asignar presupuesto" })
          .click()
      );
      yield* Effect.tryPromise(() =>
        page.getByLabel("Presupuesto", { exact: true }).fill("500000")
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Guardar presupuesto" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Presupuesto de Restaurantes (COP)")).toHaveValue("500000")
      );
      yield* checkCleanEditor(page, "Restaurantes");
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Presupuesto de Restaurantes (COP)")).toHaveValue("500000")
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Configurar grupo Alimentación" }).click()
      );
      yield* Effect.tryPromise(() => page.getByLabel("Grupo", { exact: true }).fill("Comida"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Guardar presupuesto" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Comida COP", exact: true })).toBeVisible()
      );
      yield* checkEarlierMonth(page);
      yield* checkGroupCurrency(page);
      yield* checkPermanentRemoval(page);
    })
  ));

const checkGroupCurrency = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => page.goto("/app/budgets?month=2026-11"));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Configurar grupo Comida" }).click()
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("combobox", { name: "Moneda del grupo", exact: true }).click()
    );
    yield* Effect.tryPromise(() => page.getByRole("option", { name: "USD", exact: true }).click());
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Guardar presupuesto" }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Presupuesto de Restaurantes (USD)")).toHaveValue("500000")
    );
    yield* Effect.tryPromise(() => page.reload());
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Presupuesto de Restaurantes (USD)")).toHaveValue("500000")
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Configurar Restaurantes" }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByText("Moneda del grupo: USD", { exact: true })).toBeVisible()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("combobox", { name: "Moneda del grupo", exact: true })).toHaveCount(0)
    );
    yield* Effect.tryPromise(() => page.goto("/app/budgets?month=2026-10"));
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Presupuesto de Restaurantes (COP)")).toHaveValue("500000")
    );
  });

const checkPermanentRemoval = Effect.fn(function* (page: Page) {
  for (const month of ["2026-11", "2026-12"]) {
    yield* Effect.tryPromise(() => page.getByRole("button", { name: "Mes siguiente" }).click());
    yield* Effect.tryPromise(() => expect(page).toHaveURL(new RegExp(`month=${month}`, "u")));
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Presupuesto de Restaurantes (USD)")).toHaveValue("500000")
    );
  }
  yield* Effect.tryPromise(() =>
    expect(page.getByText("Plan heredado del mes anterior.", { exact: false })).toBeVisible()
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
  for (const month of ["2026-11", "2026-10", "2026-09"]) {
    yield* Effect.tryPromise(() => page.getByRole("button", { name: "Mes anterior" }).click());
    yield* Effect.tryPromise(() => expect(page).toHaveURL(new RegExp(`month=${month}`, "u")));
    yield* Effect.tryPromise(() =>
      expect(page.getByText("Aún no tienes presupuestos.", { exact: false })).toBeVisible()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel(/^Presupuesto de Restaurantes/u)).toHaveCount(0)
    );
  }
  yield* Effect.tryPromise(() => page.reload());
  yield* Effect.tryPromise(() =>
    expect(page.getByText("Aún no tienes presupuestos.", { exact: false })).toBeVisible()
  );
});

const largeReportSize = 1000;
const largeGroupCount = 16;
const categoryIdOffset = 400000;
const budgetIdOffset = 500000;
const identityDigits = 12;
const installLargeReport = Effect.fn(function* (page: Page) {
  const largeCategories = Array.from({ length: largeReportSize }, (_, index) => ({
    id: `24000000-0000-4000-8000-${String(categoryIdOffset + index).padStart(identityDigits, "0")}`,
    label: `Categoría ${index}`,
  }));
  const statuses = largeCategories.map((category, index) => ({
    budget: {
      id: `24000000-0000-4000-8000-${String(budgetIdOffset + index).padStart(identityDigits, "0")}`,
      categoryId: category.id,
      cap: { amount: "1", currency: "COP" },
      groupName: `Grupo ${index % largeGroupCount}`,
      createdAt: "2026-10-01T12:00:00Z",
      updatedAt: "2026-10-01T12:00:00Z",
    },
    spent: { amount: "0", currency: "COP" },
    period,
    type: "under",
    remaining: { amount: "1", currency: "COP" },
  }));
  const caps = statuses.map((status) => status.budget);
  yield* Effect.tryPromise(() => installBudgetUser(page));
  yield* Effect.tryPromise(() => installCategories({ page, categories: largeCategories }));
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/budget-status?**`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: response({
          ...report,
          statuses,
          budgets: caps,
          unbudgetedExpenses: [],
          cashFlow: { income: [], expenses: [] },
        }),
      })
    )
  );
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/budgets`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: response(caps),
      })
    )
  );
});
const checkLargeReport = Effect.fn(function* (page: Page) {
  yield* installLargeReport(page);
  yield* Effect.tryPromise(() => page.goto("/app/budgets?month=2026-10"));
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("button", { name: /^Grupo [0-9]+ COP$/u })).toHaveCount(largeGroupCount)
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel(/^Presupuesto de Categoría/u)).toHaveCount(0)
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("region", { name: "Resumen COP" })).toContainText("1.000")
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Grupo 7 COP", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Presupuesto de Categoría 999 (COP)", { exact: true })).toHaveValue("1")
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel(/^Presupuesto de Categoría/u)).toHaveCount(
      Math.ceil(largeReportSize / largeGroupCount)
    )
  );
  yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
  expect(yield* Effect.tryPromise(() => page.evaluate(fitsViewport))).toBe(true);
});
test("a thousand-cap report keeps all sixteen groups and the final Category reachable", ({
  page,
}) => Effect.runPromise(checkLargeReport(page)));

const checkDeletionReview = Effect.fn(function* (page: Page) {
  const review = page.getByRole("region", { name: "Eliminar presupuesto de Vivienda" });
  for (const consequence of [
    "2026-10",
    "meses anteriores",
    "planes futuros",
    "marcas de alerta",
    "transacciones se conservan",
  ]) {
    yield* Effect.tryPromise(() => expect(review).toContainText(consequence));
  }
  yield* Effect.tryPromise(() =>
    review.getByRole("button", { name: "Cancelar", exact: true }).click()
  );
});

const checkBudgetDeletion = Effect.fn(function* (page: Page) {
  yield* Effect.tryPromise(() => installBudgetUser(page));
  yield* Effect.tryPromise(() => installCategories({ page, categories }));
  yield* Effect.tryPromise(() => installBudgetReport(page));
  let deletions = 0;
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/budgets/*`, (route) => {
      expect(route.request().method()).toBe("DELETE");
      deletions += 1;
      return route.fulfill({
        contentType: "application/json",
        body: response("24000000-0000-4000-8000-000000000310"),
      });
    })
  );
  yield* Effect.tryPromise(() => page.goto("/app/budgets?month=2026-10"));
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Configurar Vivienda", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Eliminar presupuesto", exact: true }).click()
  );
  const review = page.getByRole("region", { name: "Eliminar presupuesto de Vivienda" });
  yield* checkDeletionReview(page);
  expect(deletions).toBe(0);
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Presupuesto", { exact: true })).toHaveValue("100000")
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Eliminar presupuesto", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/budget-status?**`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: response(deletedReport),
      })
    )
  );
  yield* Effect.tryPromise(() =>
    review.getByRole("button", { name: "Eliminar de todos los meses", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(
      page.getByText("Presupuesto eliminado de todos los meses.", { exact: true })
    ).toBeVisible()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Presupuesto de Vivienda (COP)")).toHaveCount(0)
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Presupuesto de Restaurantes (USD)")).toHaveValue("50.25")
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("region", { name: "Resumen COP" })).toContainText("130.000")
  );
  expect(deletions).toBe(1);
});
test("removes a Category Budget only after reviewing all-month scope and allows cancellation", ({
  page,
}) => Effect.runPromise(checkBudgetDeletion(page)));

const checkDeletionLock = Effect.fn(function* (page: Page) {
  yield* Effect.tryPromise(() =>
    expect(
      page.getByRole("button", { name: "Eliminar de todos los meses", exact: true })
    ).toBeDisabled()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("button", { name: "Cancelar", exact: true })).toBeDisabled()
  );
  yield* Effect.tryPromise(() =>
    expect(page.locator('button[aria-label="Mes siguiente"]')).toBeDisabled()
  );
});

const checkDeletionReread = Effect.fn(function* (
  page: Page,
  availability: { unavailable: boolean }
) {
  availability.unavailable = true;
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Actualizar presupuestos", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("alert")).toContainText("No pudimos cargar tus presupuestos")
  );
  yield* Effect.tryPromise(() =>
    expect(page.locator('button[aria-label="Mes siguiente"]')).toBeDisabled()
  );
  availability.unavailable = false;
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Reintentar", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(page.locator('button[aria-label="Mes siguiente"]')).toBeEnabled()
  );
});

const checkDeletionRecovery = Effect.fn(function* (page: Page, committed: boolean) {
  yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/ingestion/review-workspace?**`, (route) =>
      route.fulfill({ status: 503 })
    )
  );

  yield* Effect.tryPromise(() => installBudgetUser(page));
  yield* Effect.tryPromise(() => installCategories({ page, categories }));
  let deleted = false;
  const availability = { unavailable: false };
  let deletions = 0;
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/budget-status?**`, (route) =>
      availability.unavailable
        ? route.fulfill({ status: 503 })
        : route.fulfill({
            contentType: "application/json",
            body: response(deleted ? deletedReport : report),
          })
    )
  );
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/budgets/*`, (route) => {
      expect(route.request().method()).toBe("DELETE");
      deletions += 1;
      deleted = committed;
      return route.abort("failed");
    })
  );
  yield* Effect.tryPromise(() => page.goto("/app/budgets?month=2026-10"));
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Configurar Vivienda", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Eliminar presupuesto", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Eliminar de todos los meses", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("alert")).toContainText("No pudimos confirmar la eliminación")
  );
  yield* checkDeletionLock(page);
  yield* checkDeletionReread(page, availability);
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Presupuesto de Vivienda (COP)")).toHaveCount(committed ? 0 : 1)
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("region", { name: "Eliminar presupuesto de Vivienda" })).toHaveCount(0)
  );
  expect(deletions).toBe(1);
});
for (const committed of [false, true]) {
  test(`an uncertain deletion recovers a ${committed ? "removed" : "retained"} Budget without replay after a failed reread`, ({
    page,
  }) => Effect.runPromise(checkDeletionRecovery(page, committed)));
}

const checkMissingBudget = Effect.fn(function* (page: Page) {
  yield* Effect.tryPromise(() => installBudgetUser(page));
  yield* Effect.tryPromise(() => installCategories({ page, categories }));
  yield* Effect.tryPromise(() => installBudgetReport(page));
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/budgets/*`, (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "not_found", message: "Budget not found" },
          next: [],
        }),
      })
    )
  );
  yield* Effect.tryPromise(() => page.goto("/app/budgets?month=2026-10"));
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Configurar Vivienda", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Eliminar presupuesto", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Eliminar de todos los meses", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("alert")).toContainText("No se pudo eliminar el presupuesto")
  );
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/budget-status?**`, (route) =>
      route.fulfill({ contentType: "application/json", body: response(deletedReport) })
    )
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Actualizar presupuestos", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Presupuesto de Vivienda (COP)")).toHaveCount(0)
  );
  yield* Effect.tryPromise(() => expect(page.getByRole("alert")).toHaveCount(0));
});
test("a Budget removed elsewhere reports a refusal and rereads canonical state", ({ page }) =>
  Effect.runPromise(checkMissingBudget(page)));

type ReportFixture = typeof report | typeof deletedReport;
const deletionMonthReport = (source: ReportFixture, future: boolean): ReportFixture => {
  const appliedPeriod = future
    ? { ...period, from: "2026-11-01T05:00:00Z", to: "2026-12-01T05:00:00Z" }
    : period;
  return {
    ...source,
    initialized: !future,
    period: appliedPeriod,
    statuses: source.statuses.map((status) => ({ ...status, period: appliedPeriod })),
  };
};

const checkLateDeletion = Effect.fn(function* (page: Page) {
  yield* Effect.tryPromise(() => page.setViewportSize({ width: 1600, height: 1000 }));
  yield* Effect.tryPromise(() => installBudgetUser(page));
  yield* Effect.tryPromise(() => installCategories({ page, categories }));
  let deleted = false;
  let deletionRequested = false;
  let oldRereads = 0;
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/budget-status?**`, (route) => {
      const source = deleted ? deletedReport : report;
      const future = new URL(route.request().url()).searchParams.get("month") === "2026-11";
      if (deletionRequested && !deleted) oldRereads += 1;
      return route.fulfill({
        contentType: "application/json",
        body: response(deletionMonthReport(source, future)),
      });
    })
  );
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/budgets/*`, (route) => {
      deletionRequested = true;
      return route.abort("failed");
    })
  );
  yield* Effect.tryPromise(() => page.goto("/app/budgets?month=2026-11"));
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Presupuesto de Vivienda (COP)")).toHaveValue("100000")
  );
  yield* Effect.tryPromise(() => page.getByRole("button", { name: "Mes anterior" }).click());
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Configurar Vivienda", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Eliminar presupuesto", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Eliminar de todos los meses", exact: true }).click()
  );
  yield* Effect.tryPromise(() => expect.poll(() => oldRereads).toBeGreaterThanOrEqual(2));
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("button", { name: "Actualizar presupuestos", exact: true })).toBeVisible()
  );
  deleted = true;
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Actualizar presupuestos", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Presupuesto de Vivienda (COP)")).toHaveCount(0)
  );
  yield* Effect.tryPromise(() => page.getByRole("button", { name: "Mes siguiente" }).click());
  yield* Effect.tryPromise(() => expect(page).toHaveURL(/month=2026-11/u));
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Presupuesto de Restaurantes (USD)")).toHaveValue("50.25")
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Presupuesto de Vivienda (COP)")).toHaveCount(0)
  );
});
test("explicit deletion recovery refreshes cached inherited plans after a late commit", ({
  page,
}) => Effect.runPromise(checkLateDeletion(page)));

const unavailableStatus = 503;
const absentDashboardStatus = 404;
const installFailedDashboard = Effect.fn(function* (
  page: Page,
  observation: { reads: number; initializationPaths: Array<string> }
) {
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/dashboard/view`, (route) => {
      observation.reads += 1;
      return route.fulfill({
        status: observation.reads === 1 ? unavailableStatus : absentDashboardStatus,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: observation.reads === 1 ? "unavailable" : "dashboard_uninitialized",
            message: "Dashboard unavailable",
          },
          next: [],
        }),
      });
    })
  );
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/dashboard/initialize`, (route) => {
      observation.initializationPaths.push(new URL(page.url()).pathname);
      return route.fulfill({ status: 503 });
    })
  );
});

const checkBackgroundDashboard = Effect.fn(function* (page: Page) {
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/dashboard/catalog`, (route) =>
      route.fulfill({ contentType: "application/json", body: response([]) })
    )
  );
  yield* Effect.tryPromise(() => page.setViewportSize({ width: 1600, height: 1000 }));
  yield* Effect.tryPromise(() => installBudgetUser(page));
  yield* Effect.tryPromise(() => installCategories({ page, categories }));
  yield* Effect.tryPromise(() => installBudgetReport(page));
  const observation = { reads: 0, initializationPaths: new Array<string>() };
  yield* installFailedDashboard(page, observation);
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/budgets/*`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: response("24000000-0000-4000-8000-000000000310"),
      })
    )
  );
  yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
  yield* Effect.tryPromise(() => expect(page.getByRole("alert")).toBeVisible());
  yield* Effect.tryPromise(() =>
    page.getByRole("link", { name: "Presupuestos", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Configurar Vivienda", exact: true }).click()
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
  yield* Effect.tryPromise(() => expect.poll(() => observation.reads).toBeGreaterThanOrEqual(2));
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Actualizar", exact: true }).click()
  );
  yield* Effect.tryPromise(() => expect.poll(() => observation.reads).toBeGreaterThanOrEqual(3));
  expect(observation.initializationPaths).toEqual([]);
});
test("Budget removal and recovery never initialize a retained failed Dashboard outside its visit", ({
  page,
}) => Effect.runPromise(checkBackgroundDashboard(page)));

const holdDeletion = Effect.fn(function* (page: Page) {
  const pending = Promise.withResolvers<void>();
  const abort = (route: Route): Promise<void> => pending.promise.then(() => route.abort("failed"));
  yield* Effect.tryPromise(() => page.route(`${apiOrigin}/budgets/*`, abort));
  return pending.resolve;
});
const checkDeletionDesign = Effect.fn(function* (page: Page, colorScheme: "light" | "dark") {
  yield* Effect.tryPromise(() => page.emulateMedia({ colorScheme, reducedMotion: "reduce" }));
  yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
  yield* Effect.tryPromise(() => installBudgetUser(page));
  yield* Effect.tryPromise(() => installCategories({ page, categories }));
  yield* Effect.tryPromise(() => installBudgetReport(page));
  const release = yield* holdDeletion(page);
  yield* Effect.tryPromise(() => page.goto("/app/budgets?month=2026-10"));
  yield* Effect.tryPromise(() =>
    page.evaluate(() => {
      document.documentElement.style.fontSize = "32px";
    })
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Configurar Vivienda", exact: true }).click()
  );
  const opener = page.getByRole("button", { name: "Eliminar presupuesto", exact: true });
  yield* Effect.tryPromise(() => opener.press("Enter"));
  const review = page.getByRole("region", { name: "Eliminar presupuesto de Vivienda" });
  const cancel = review.getByRole("button", { name: "Cancelar", exact: true });
  yield* Effect.tryPromise(() => expect(cancel).toBeFocused());
  expect(
    yield* Effect.tryPromise(() =>
      review.evaluate((element) => element.scrollWidth <= element.clientWidth)
    )
  ).toBe(true);
  yield* Effect.tryPromise(() => cancel.press("Space"));
  yield* Effect.tryPromise(() => expect(opener).toBeFocused());
  yield* Effect.tryPromise(() => opener.press("Enter"));
  yield* Effect.tryPromise(() => expect(cancel).toBeFocused());
  yield* Effect.tryPromise(() => page.keyboard.press("Tab"));
  const confirm = review.getByRole("button", { name: "Eliminar de todos los meses", exact: true });
  yield* Effect.tryPromise(() => expect(confirm).toBeFocused());
  yield* Effect.tryPromise(() => page.keyboard.press("Enter"));
  yield* Effect.tryPromise(() =>
    expect(review.getByRole("status")).toContainText("Eliminando presupuesto")
  );
  yield* Effect.tryPromise(() => expect(confirm).toBeDisabled());
  release();
  yield* Effect.tryPromise(() =>
    expect(review.getByRole("alert")).toContainText("No pudimos confirmar la eliminación")
  );
  yield* Effect.tryPromise(() =>
    expect(
      review.getByRole("button", { name: "Actualizar presupuestos", exact: true })
    ).toBeVisible()
  );
  yield* checkAccessibility(page);
});
for (const colorScheme of ["light", "dark"] as const) {
  test(`Budget deletion keeps focus, enlarged-text actions and local progress in ${colorScheme}`, ({
    page,
  }) => Effect.runPromise(checkDeletionDesign(page, colorScheme)));
}

const reconciliationReport = (moved: boolean): object => ({
  ...report,
  statuses: [
    {
      budget: budget({ index: 1, amount: "10000", currency: "COP", groupName: "Alimentación" }),
      spent: { amount: moved ? "0" : "20000", currency: "COP" },
      period,
      ...(moved
        ? { type: "under", remaining: { amount: "10000", currency: "COP" } }
        : { type: "over", overBy: { amount: "10000", currency: "COP" } }),
    },
  ],
  cashFlow: { income: [], expenses: [{ amount: "25000", currency: "COP" }] },
  unbudgetedExpenses: [
    { categoryId: categories[2]?.id, spent: { amount: moved ? "25000" : "5000", currency: "COP" } },
  ],
});
const spendingCursor =
  "2026-10-15T12:00:00.000Z|2026-10-15T12:00:00.000Z|24000000-0000-4000-8000-000000000401";
const installSpendingHistory = (
  page: Page,
  requests: Array<URL>,
  fixture: { failing: boolean }
): Promise<unknown> =>
  page.route(`${apiOrigin}/transactions?**`, (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    if (fixture.failing) return route.fulfill({ status: 503 });
    const more = url.searchParams.has("cursor");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          {
            id: more
              ? "24000000-0000-4000-8000-000000000402"
              : "24000000-0000-4000-8000-000000000401",
            revision: 0,
            categoryId: categories[2]?.id,
            money: { amount: more ? "5000" : "20000", currency: "COP" },
            direction: "outflow",
            counterparty: more ? "Segundo mercado" : "Mercado de prueba",
            occurredAt: "2026-10-15T12:00:00Z",
            createdAt: "2026-10-15T12:00:00Z",
          },
        ],
        next: more
          ? []
          : [
              {
                tool: "transactions.listTransactions",
                hint: "Continue history.",
                args: { query: { cursor: spendingCursor } },
              },
            ],
      }),
    });
  });
const checkSpendingTrace = Effect.fn(function* (page: Page) {
  const requests: Array<URL> = [];
  const fixture = { failing: true };
  yield* Effect.tryPromise(() => installSpendingHistory(page, requests, fixture));
  yield* Effect.tryPromise(() =>
    page
      .getByRole("region", { name: "Gastos sin presupuesto" })
      .getByRole("button", { name: "Ver movimientos de Mercado en COP" })
      .click()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("button", { name: "Reintentar movimientos" })).toBeVisible()
  );
  fixture.failing = false;
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Reintentar movimientos" }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("dialog")).toContainText("Mercado de prueba")
  );
  yield* Effect.tryPromise(() => page.getByRole("button", { name: "Ver más movimientos" }).click());
  yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toContainText("Segundo mercado"));
  expect(requests.at(-1)?.searchParams.get("cursor")).toBe(spendingCursor);
  expect(requests.at(-1)?.searchParams.get("from")).toBe("2026-10-01T05:00:00.000Z");
  expect(requests.at(-1)?.searchParams.get("to")).toBe("2026-11-01T05:00:00.000Z");
  expect(requests.at(-1)?.searchParams.get("categoryId")).toBe(categories[2]?.id);
  expect(requests.at(-1)?.searchParams.get("currency")).toBe("COP");
  expect(requests.at(-1)?.searchParams.get("direction")).toBe("outflow");
  yield* checkAccessibility(page);
  yield* Effect.tryPromise(() => page.getByRole("button", { name: "Cerrar", exact: true }).click());
});
const checkSpendingReconciliation = Effect.fn(function* (page: Page) {
  yield* Effect.tryPromise(() => installBudgetUser(page));
  yield* Effect.tryPromise(() => installCategories({ page, categories }));
  let moved = false;
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/budget-status?**`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: response(reconciliationReport(moved)),
      })
    )
  );
  yield* Effect.tryPromise(() => page.goto("/app/budgets?month=2026-10"));
  const totals = page.getByRole("region", { name: "Gasto total del mes COP" });
  yield* Effect.tryPromise(() => expect(totals).toContainText("20.000"));
  yield* Effect.tryPromise(() => expect(totals).toContainText("5.000"));
  yield* Effect.tryPromise(() => expect(totals).toContainText("25.000"));
  yield* Effect.tryPromise(() => expect(totals).toContainText("15.000"));
  const withoutBudget = page.getByRole("region", { name: "Gastos sin presupuesto" });
  yield* Effect.tryPromise(() => expect(withoutBudget).toContainText("Mercado"));
  yield* Effect.tryPromise(() => expect(withoutBudget).toContainText("5.000"));
  moved = true;
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Actualizar", exact: true }).click()
  );
  yield* Effect.tryPromise(() => expect(withoutBudget).toContainText("25.000"));
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("region", { name: "Resumen COP" })).toContainText("25.000")
  );
  yield* checkSpendingTrace(page);
  yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
  expect(yield* Effect.tryPromise(() => page.evaluate(fitsViewport))).toBe(true);
});
test("reconciles budgeted and unbudgeted spending and traces the selected monthly transactions", ({
  page,
}) => Effect.runPromise(checkSpendingReconciliation(page)));

const checkUnbudgetedCurrencies = Effect.fn(function* (page: Page) {
  yield* Effect.tryPromise(() => installBudgetUser(page));
  yield* Effect.tryPromise(() => installCategories({ page, categories }));
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/budget-status?**`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: response({
          ...report,
          statuses: [],
          budgets: [],
          cashFlow: {
            income: [],
            expenses: [
              { amount: "15000", currency: "COP" },
              { amount: "7.25", currency: "USD" },
            ],
          },
          unbudgetedExpenses: [
            { categoryId: categories[2]?.id, spent: { amount: "15000", currency: "COP" } },
            { categoryId: categories[2]?.id, spent: { amount: "7.25", currency: "USD" } },
          ],
        }),
      })
    )
  );
  yield* Effect.tryPromise(() => page.goto("/app/budgets?month=2026-10"));
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("region", { name: "Gasto total del mes COP" })).toContainText("15.000")
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("region", { name: "Gasto total del mes USD" })).toContainText("7,25")
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("region", { name: "Gastos sin presupuesto" })).toContainText(
      "Mercado · USD"
    )
  );
  yield* Effect.tryPromise(() => page.getByRole("button", { name: "USD", exact: true }).click());
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("region", { name: "Resumen USD" })).toContainText("7,25")
  );
  yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
  expect(yield* Effect.tryPromise(() => page.evaluate(fitsViewport))).toBe(true);
  yield* checkAccessibility(page);
});
test("shows spending in each Currency when no Categories have a budget", ({ page }) =>
  Effect.runPromise(checkUnbudgetedCurrencies(page)));

const budgetRevalidationMilliseconds = 6000;
const reassignedReport = {
  ...report,
  budgets: report.budgets.map((value) => ({ ...value, groupName: "Nuevo" })),
  statuses: report.statuses.map((status) => ({
    ...status,
    budget: { ...status.budget, groupName: "Nuevo" },
  })),
};
const checkRetiredCategory = Effect.fn(function* (page: Page, reassigned: boolean) {
  yield* Effect.tryPromise(() => installBudgetUser(page));
  yield* Effect.tryPromise(() => installCategories({ page, categories }));
  let removed = false;
  const replacement = reassigned ? reassignedReport : deletedReport;
  let reads = 0;
  let writes = 0;
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/budget-status?**`, (route) => {
      reads += 1;
      return route.fulfill({
        contentType: "application/json",
        body: response(removed ? replacement : report),
      });
    })
  );
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/budgets/*`, (route) => {
      writes += 1;
      return route.abort("failed");
    })
  );
  yield* Effect.tryPromise(() => page.goto("/app/budgets?month=2026-10"));
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Configurar Vivienda", exact: true }).click()
  );
  yield* Effect.tryPromise(() => page.getByLabel("Presupuesto", { exact: true }).fill("150000"));
  removed = true;
  const initialReads = reads;
  yield* Effect.tryPromise(() => page.clock.install());
  yield* Effect.tryPromise(() => page.clock.fastForward(budgetRevalidationMilliseconds));
  yield* Effect.tryPromise(() =>
    page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")))
  );
  yield* Effect.tryPromise(() => expect.poll(() => reads).toBeGreaterThan(initialReads));
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Presupuesto de Vivienda (COP)")).toHaveCount(reassigned ? 1 : 0)
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Guardar presupuesto", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(
      page.getByRole("form", { name: "Configurar presupuesto de Vivienda" }).getByRole("alert")
    ).toContainText("No se pudo guardar")
  );
  expect(writes).toBe(0);
});
test("an open Budget editor cannot write a target removed by a fresh monthly report", ({ page }) =>
  Effect.runPromise(checkRetiredCategory(page, false)));
test("an open Budget editor cannot undo a fresh group reassignment", ({ page }) =>
  Effect.runPromise(checkRetiredCategory(page, true)));

const checkSameTickSave = Effect.fn(function* (page: Page) {
  yield* Effect.tryPromise(() => installBudgetUser(page));
  yield* Effect.tryPromise(() => installCategories({ page, categories }));
  yield* Effect.tryPromise(() => installBudgetReport(page));
  const requests = new Array<unknown>();
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/budgets/*`, (route) => {
      requests.push(route.request().postDataJSON());
      return route.abort("failed");
    })
  );
  yield* Effect.tryPromise(() => page.goto("/app/budgets?month=2026-10"));
  const amount = page.getByLabel("Presupuesto de Restaurantes (USD)");
  yield* Effect.tryPromise(() => amount.fill("75,25"));
  yield* Effect.tryPromise(() =>
    amount.locator("xpath=ancestor::form").evaluate((form) => {
      if (form instanceof HTMLFormElement) {
        form.requestSubmit();
        form.requestSubmit();
      }
    })
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("alert")).toContainText("No pudimos confirmar el guardado")
  );
  expect(requests).toEqual([
    {
      categoryId: categories[1]?.id,
      cap: { amount: "75.25", currency: "USD" },
      month: "2026-10",
      groupName: "Alimentación",
    },
  ]);
  yield* Effect.tryPromise(() => expect(amount).toBeDisabled());
});
test("same-tick monthly submissions admit one exact Money write", ({ page }) =>
  Effect.runPromise(checkSameTickSave(page)));

const checkFailedLocalRead = Effect.fn(function* (page: Page, path: "categories" | "user") {
  yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
  yield* Effect.tryPromise(() => installBudgetUser(page));
  yield* Effect.tryPromise(() => installCategories({ page, categories }));
  yield* Effect.tryPromise(() => installBudgetReport(page));
  let unavailable = false;
  let writes = 0;
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/${path}`, (route) =>
      unavailable ? route.fulfill({ status: 503 }) : route.fallback()
    )
  );
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/budgets/*`, (route) => {
      writes += 1;
      return route.abort("failed");
    })
  );
  yield* Effect.tryPromise(() => page.goto("/app/budgets?month=2026-10"));
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Configurar Vivienda", exact: true }).click()
  );
  yield* Effect.tryPromise(() => page.getByLabel("Presupuesto", { exact: true }).fill("150000"));
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Guardar presupuesto", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("alert")).toContainText("No pudimos confirmar el guardado")
  );
  const editor = page.getByRole("form", { name: "Configurar presupuesto de Vivienda" });
  yield* Effect.tryPromise(() =>
    expect(editor.getByRole("alert")).toContainText("No pudimos confirmar el guardado")
  );
  yield* Effect.tryPromise(() =>
    expect(editor.getByRole("button", { name: "Guardar presupuesto", exact: true })).toBeDisabled()
  );
  unavailable = true;
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Actualizar presupuestos", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("form", { name: "Configurar presupuesto de Vivienda" })).toHaveCount(0)
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByText("No pudimos confirmar el guardado", { exact: false })).toHaveCount(0)
  );
  const amount = page.getByLabel("Presupuesto de Vivienda (COP)");
  yield* Effect.tryPromise(() => expect(amount).toHaveValue("100000"));
  yield* Effect.tryPromise(() => expect(amount).toBeDisabled());
  unavailable = false;
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Reintentar", exact: true }).first().click()
  );
  yield* Effect.tryPromise(() => expect(amount).toBeEnabled());
  expect(writes).toBe(1);
});
for (const path of ["categories", "user"] as const) {
  test(`Refresh discards an uncertain draft while a failed ${path} read still blocks Budget writes`, ({
    page,
  }) => Effect.runPromise(checkFailedLocalRead(page, path)));
}

const installEditorRefusal = Effect.fn(function* (page: Page, observation: { attempts: number }) {
  const pending = Promise.withResolvers<void>();
  const refuse = (route: Route): Promise<void> =>
    pending.promise.then(() =>
      route.fulfill({
        status: 400,
        json: { error: { code: "validation_failed", message: "Refused", fields: [] }, next: [] },
      })
    );
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/budgets/*`, (route) => {
      observation.attempts += 1;
      return observation.attempts === 1 ? refuse(route) : route.abort("failed");
    })
  );
  return pending.resolve;
});

const checkEditorFeedback = Effect.fn(function* (page: Page) {
  yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
  yield* Effect.tryPromise(() => installBudgetUser(page));
  yield* Effect.tryPromise(() => installCategories({ page, categories }));
  yield* Effect.tryPromise(() => installBudgetReport(page));
  const observation = { attempts: 0 };
  const release = yield* installEditorRefusal(page, observation);
  yield* Effect.tryPromise(() => page.goto("/app/budgets?month=2026-10"));
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Configurar Vivienda", exact: true }).click()
  );
  const editor = page.getByRole("form", { name: "Configurar presupuesto de Vivienda" });
  yield* Effect.tryPromise(() => editor.getByLabel("Presupuesto", { exact: true }).fill("150000"));
  yield* Effect.tryPromise(() =>
    editor.getByRole("button", { name: "Guardar presupuesto", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(editor.getByRole("status")).toContainText("Guardando presupuesto")
  );
  yield* Effect.tryPromise(() =>
    expect(editor.getByRole("button", { name: "Guardando…", exact: true })).toBeDisabled()
  );
  release();
  yield* Effect.tryPromise(() =>
    expect(editor.getByRole("alert")).toContainText("No se pudo guardar")
  );
  yield* Effect.tryPromise(() =>
    expect(editor.getByRole("button", { name: "Guardar presupuesto", exact: true })).toBeEnabled()
  );
  yield* Effect.tryPromise(() =>
    editor.getByRole("button", { name: "Cerrar", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Configurar Vivienda", exact: true }).click()
  );
  yield* Effect.tryPromise(() => expect(editor.getByRole("alert")).toHaveCount(0));
  yield* Effect.tryPromise(() => expect(editor.getByRole("status")).toHaveCount(0));
  yield* Effect.tryPromise(() =>
    editor.getByRole("button", { name: "Guardar presupuesto", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(editor.getByRole("alert")).toContainText("No pudimos confirmar el guardado")
  );
  yield* Effect.tryPromise(() =>
    expect(editor.getByRole("button", { name: "Guardar presupuesto", exact: true })).toBeDisabled()
  );
  yield* Effect.tryPromise(() =>
    expect(
      editor.getByRole("button", { name: "Actualizar presupuestos", exact: true })
    ).toBeEnabled()
  );
  expect(observation.attempts).toBe(2);
  yield* checkAccessibility(page);
});
test("the mobile Budget editor distinguishes pending, refused and uncertain saves locally", ({
  page,
}) => Effect.runPromise(checkEditorFeedback(page)));
