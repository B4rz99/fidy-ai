import { ResourceLimited } from "@fidy/server/client";
import { advanceNativeRetry } from "./acceptance-clock";
import type { APIResponse, Page, Route } from "@playwright/test";
import { type Cause, Effect, Option, Schema } from "effect";
import { apiOrigin, installCategories, installUser, response } from "./http-fixtures";
import { browserSessionHeaders, signInBudgetEditingThroughCore } from "./real-core-fixture";
import { playwright } from "./playwright-runtime";

const { AxeBuilder } = await import("@axe-core/playwright");
const { expect, test } = playwright;
const budgetJourneyMilliseconds = 60_000;
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
const report = {
  period,
  initialized: true,
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
    const result = yield* Effect.tryPromise(() => new AxeBuilder({ page }).analyze());
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
      expect(page.getByRole("heading", { name: "Gastos", exact: true })).toHaveCount(0)
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Resumen", exact: true }).click()
    );
  });

test("shows grouped currency totals and prevents replay after a lost save acknowledgement", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installUser(page));
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
      yield* Effect.tryPromise(() =>
        page.screenshot({ path: "/tmp/fidy-budgets-desktop.png", fullPage: true })
      );
      yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
      expect(yield* Effect.tryPromise(() => page.evaluate(fitsViewport))).toBe(true);
      yield* checkAccessibility(page);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Configurar Vivienda" }).click()
      );
      yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toBeVisible());
      yield* checkAccessibility(page);
      yield* Effect.tryPromise(() =>
        page.screenshot({ path: "/tmp/fidy-budgets-mobile.png", fullPage: true })
      );
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
  yield* Effect.tryPromise(() => installUser(page));
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
      yield* Effect.tryPromise(() => installUser(page));
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

test("saves a monthly cap from the view through real Core and retains it after reload", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      test.setTimeout(budgetJourneyMilliseconds);
      yield* Effect.tryPromise(() => signInBudgetEditingThroughCore({ page, request }));
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
        expect(page.getByRole("heading", { name: "Comida", exact: true })).toBeVisible()
      );
      yield* checkEarlierMonth(page);
      yield* checkGroupCurrency(page);
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
  yield* Effect.tryPromise(() => installUser(page));
  yield* Effect.tryPromise(() => installCategories({ page, categories: largeCategories }));
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/budget-status?**`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: response({
          ...report,
          statuses,
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
    expect(page.getByRole("button", { name: /^Grupo [0-9]+$/u })).toHaveCount(largeGroupCount)
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel(/^Presupuesto de Categoría/u)).toHaveCount(0)
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("region", { name: "Resumen COP" })).toContainText("1.000")
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Grupo 7", exact: true }).click()
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

const admissionProbeRequests = 12;
const admittedStatus = 200;
const resourceLimitedStatus = 429;
test("native admission still refuses the burst and recovers only after the fixture clock advances", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => signInBudgetEditingThroughCore({ page, request }));
      yield* Effect.tryPromise(() => page.goto("/auth/pair"));
      const headers = yield* Effect.tryPromise(() => browserSessionHeaders(page.request));
      let refusal = Option.none<APIResponse>();
      for (let attempt = 0; attempt < admissionProbeRequests; attempt++) {
        const result = yield* Effect.tryPromise(() =>
          page.request.get(`${apiOrigin}/categories`, { headers })
        );
        if (result.status() === resourceLimitedStatus) {
          refusal = Option.some(result);
          break;
        }
        expect(result.status()).toBe(admittedStatus);
      }
      expect(Option.isSome(refusal)).toBe(true);
      const refused = Option.getOrThrow(refusal);
      expect(refused.headers()["retry-after"]).toBe("1");
      expect(
        Option.isSome(
          Schema.decodeUnknownOption(Schema.toCodecJson(ResourceLimited))(
            yield* Effect.tryPromise(() => refused.json())
          )
        )
      ).toBe(true);
      expect(
        (yield* Effect.tryPromise(() =>
          page.request.get(`${apiOrigin}/categories`, { headers })
        )).status()
      ).toBe(resourceLimitedStatus);
      yield* Effect.tryPromise(() => advanceNativeRetry(request, 1));
      expect(
        (yield* Effect.tryPromise(() =>
          page.request.get(`${apiOrigin}/categories`, { headers })
        )).status()
      ).toBe(admittedStatus);
    })
  ));
