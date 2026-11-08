import type { Page } from "@playwright/test";
import { Effect } from "effect";
import { apiOrigin, installBoundUser, installCategories, response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;
const wait = Effect.tryPromise;
const unavailableStatus = 503;
const okStatus = 200;
const category = { id: "24000000-0000-4000-8000-000000000242", label: "Mercado" };
const transaction = {
  id: "25000000-0000-4000-8000-000000000001",
  categoryId: category.id,
  money: { amount: "85000", currency: "COP" },
  counterparty: "Mercado de octubre",
  direction: "outflow",
  occurredAt: "2026-10-15T12:00:00.000Z",
  createdAt: "2026-10-15T12:00:00.000Z",
  revision: 1,
};
const installHistory = Effect.fn(function* (page: Page, failed: boolean) {
  yield* wait(() => installBoundUser(page));
  yield* wait(() => installCategories({ page, categories: [category] }));
  const fixture = { failed, requests: new Array<URL>() };
  yield* wait(() =>
    page.route(`${apiOrigin}/transactions?*`, (route) => {
      fixture.requests.push(new URL(route.request().url()));
      return route.fulfill({
        status: fixture.failed ? unavailableStatus : okStatus,
        contentType: "application/json",
        body: fixture.failed ? response([]) : response([transaction]),
      });
    })
  );
  return fixture;
});

const initialFailureJourney = Effect.fn(function* (page: Page) {
  const fixture = yield* installHistory(page, true);
  yield* wait(() => page.goto("/app/transactions?month=2026-10"));
  yield* wait(() => expect(page.getByRole("alert")).toContainText("octubre de 2026"));
  yield* wait(() => expect(page.getByText("Movimientos del mes actual.")).toHaveCount(0));
  yield* wait(() => expect(page.getByLabel("Mes de transacciones")).toHaveValue("10"));
  yield* wait(() =>
    expect(page.getByRole("combobox", { name: "Año de transacciones", exact: true })).toHaveText(
      "2026"
    )
  );
  yield* wait(() =>
    page.screenshot({ path: test.info().outputPath("initial-failure.png"), fullPage: true })
  );
  fixture.failed = false;
  yield* wait(() => page.getByRole("button", { name: "Reintentar carga", exact: true }).click());
  yield* wait(() =>
    expect(
      page.getByRole("button", { name: /^Ver transacción Mercado de octubre(?: Mercado)?$/u })
    ).toBeVisible()
  );
  yield* wait(() => expect(page).toHaveURL(/month=2026-10/u));
  for (const request of fixture.requests) {
    expect(request.searchParams.get("from")).toBe("2026-10-01T05:00:00.000Z");
    expect(request.searchParams.get("to")).toBe("2026-11-01T05:00:00.000Z");
  }
  fixture.failed = true;
  yield* wait(() => page.getByRole("button", { name: "Mes anterior", exact: true }).click());
  yield* wait(() => expect(page.getByRole("alert")).toContainText("septiembre de 2026"));
  yield* wait(() => page.getByRole("button", { name: "Mes siguiente", exact: true }).click());
  yield* wait(() => expect(page.getByLabel("Mes de transacciones")).toHaveValue("10"));
  yield* wait(() =>
    expect(page.getByRole("combobox", { name: "Año de transacciones", exact: true })).toHaveText(
      "2026"
    )
  );
});
const refreshFailureJourney = Effect.fn(function* (page: Page) {
  const fixture = yield* installHistory(page, false);
  yield* wait(() => page.goto("/app/transactions?month=2026-10&date=2026-10-15"));
  const row = page.getByRole("button", {
    name: /^Ver transacción Mercado de octubre(?: Mercado)?$/u,
  });
  yield* wait(() => expect(row).toBeVisible());
  fixture.failed = true;
  yield* wait(() =>
    page.getByRole("button", { name: "Actualizar transacciones", exact: true }).click()
  );
  yield* wait(() => expect(page.getByRole("alert")).toContainText("octubre de 2026"));
  yield* wait(() => expect(row).toBeVisible());
  yield* wait(() => expect(page.getByLabel("Mes de transacciones")).toHaveValue("10"));
  yield* wait(() =>
    expect(page.getByRole("combobox", { name: "Año de transacciones", exact: true })).toHaveText(
      "2026"
    )
  );
  yield* wait(() =>
    expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeDisabled()
  );
  yield* wait(() =>
    page.screenshot({ path: test.info().outputPath("refresh-failure.png"), fullPage: true })
  );
  fixture.failed = false;
  yield* wait(() =>
    page.getByRole("button", { name: "Reintentar actualización", exact: true }).click()
  );
  yield* wait(() =>
    expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeEnabled()
  );
  yield* wait(() => expect(row).toBeVisible());
  yield* wait(() => expect(page).toHaveURL(/month=2026-10&date=2026-10-15/u));
  for (const request of fixture.requests) {
    expect(request.searchParams.get("from")).toBe("2026-10-01T05:00:00.000Z");
    expect(request.searchParams.get("to")).toBe("2026-11-01T05:00:00.000Z");
  }
});
const invalidPeriodJourney = Effect.fn(function* (page: Page) {
  const fixture = yield* installHistory(page, false);
  for (const query of ["month=2026-13", "month=2026-11&date=2026-10-31", "date=2026-02-30"]) {
    yield* wait(() => page.goto(`/app/transactions?${query}`));
    yield* wait(() =>
      expect(page.getByRole("alert")).toContainText("El enlace de transacciones no es válido")
    );
    yield* wait(() => expect(page.getByLabel("Mes de transacciones")).toHaveCount(0));
    yield* wait(() =>
      expect(page.getByRole("button", { name: "Reintentar carga", exact: true })).toHaveCount(0)
    );
    expect(fixture.requests).toHaveLength(0);
  }
  yield* wait(() =>
    page.screenshot({ path: test.info().outputPath("invalid-period.png"), fullPage: true })
  );
  yield* wait(() => page.getByRole("link", { name: "Ir al mes actual", exact: true }).click());
  yield* wait(() => expect(page.getByLabel("Mes de transacciones")).toBeVisible());
  yield* wait(() => expect(page).toHaveURL(/\/app\/transactions$/u));
});
const viewports = {
  mobile: { width: 390, height: 844 },
  desktop: { width: 1440, height: 1000 },
};
for (const [viewportName, viewport] of Object.entries(viewports)) {
  for (const colorScheme of ["light", "dark"] as const) {
    test.describe(`${viewportName} ${colorScheme}`, () => {
      test.use({ viewport, colorScheme, locale: "es-CO" });
      test("preserves the requested month through initial history failure, retry and month navigation", ({
        page,
      }) => Effect.runPromise(initialFailureJourney(page)));
      test("retains loaded history and its selected day through a failed refresh and recovery", ({
        page,
      }) => Effect.runPromise(refreshFailureJourney(page)));
      test("rejects invalid periods without requesting history and offers an explicit return to the current month", ({
        page,
      }) => Effect.runPromise(invalidPeriodJourney(page)));
    });
  }
}
