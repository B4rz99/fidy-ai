import type { Page, Route } from "@playwright/test";
import { DateTime, Effect, Option } from "effect";
import { apiOrigin, installBoundUser, installCategories } from "./http-fixtures";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;
test.describe.configure({ mode: "parallel" });
const category = { id: "24000000-0000-4000-8000-000000000242", label: "Restaurantes" };
const pageSize = 100;
const initialPageSize = 25;
const unauthorized = 401;
const multiplePages = pageSize * 2 + 1;
const wait = Effect.tryPromise;
const uuidWidth = 12;
const beyondPage = pageSize + 1;
const middleRow = 50;
const scrollTolerance = 64;
const scrollPosition = (page: Page): Promise<number> => page.evaluate(() => window.scrollY);
const expectScrollAt = (page: Page, expected: number): Promise<void> =>
  expect
    .poll(() => scrollPosition(page).then((actual) => Math.abs(actual - expected)))
    .toBeLessThan(scrollTolerance);
type HistoryRow = Readonly<{
  id: string;
  categoryId: string;
  money: Readonly<{ amount: string; currency: string }>;
  counterparty: string;
  direction: string;
  occurredAt: string;
  createdAt: string;
  revision: number;
}>;
const fixtureRows = (count: number): ReadonlyArray<HistoryRow> => {
  const occurredAt = DateTime.formatIso(Effect.runSync(DateTime.now));
  return Array.from({ length: count }, (_, index) => ({
    id: `25000000-0000-4000-8000-${String(count - index).padStart(uuidWidth, "0")}`,
    categoryId: category.id,
    money: { amount: "0.01", currency: "USD" },
    counterparty: `Registro ${index + 1}`,
    direction: "outflow",
    occurredAt,
    createdAt: occurredAt,
    revision: 0,
  }));
};
type HistoryFixture = {
  rows: ReadonlyArray<HistoryRow>;
  requests: Array<URL>;
  mode: "ready" | "hold" | "failure" | "expired";
  firstFailure: boolean;
  pending: Option.Option<Route>;
};
const pageBody = (fixture: HistoryFixture, url: URL): string => {
  const cursor = url.searchParams.get("cursor");
  const previous = fixture.rows.findIndex(
    (row) => `${row.occurredAt}|${row.createdAt}|${row.id}` === cursor
  );
  const start = cursor === null ? 0 : previous + 1;
  const requestedSize = Number(url.searchParams.get("limit") ?? pageSize);
  const data = fixture.rows.slice(start, start + requestedSize);
  const last = data.at(-1);
  const next =
    start + requestedSize < fixture.rows.length && last !== undefined
      ? [
          {
            tool: "transactions.listTransactions",
            hint: "Continue browsing the next page of your FinancialRecord.",
            args: {
              query: {
                from: url.searchParams.get("from"),
                to: url.searchParams.get("to"),
                cursor: `${last.occurredAt}|${last.createdAt}|${last.id}`,
              },
            },
          },
        ]
      : [];
  return JSON.stringify({ data, next });
};
const fulfillPage = (fixture: HistoryFixture, route: Route): Promise<void> =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: pageBody(fixture, new URL(route.request().url())),
  });
const interruptPending = (fixture: HistoryFixture): Promise<void> =>
  Option.match(fixture.pending, {
    onNone: () => Promise.resolve(),
    onSome: (route) => route.abort("failed"),
  });
const completePending = (fixture: HistoryFixture): Promise<void> =>
  Option.match(fixture.pending, {
    onNone: () => Promise.resolve(),
    onSome: (route) => fulfillPage(fixture, route),
  });
const installCorrection = (page: Page, fixture: HistoryFixture, last: HistoryRow): Promise<void> =>
  page
    .route(`${apiOrigin}/transactions/${last.id}`, (route) => {
      if (route.request().method() === "GET") {
        const current = Option.getOrThrow(
          Option.fromUndefinedOr(fixture.rows.find((record) => record.id === last.id))
        );
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              ...current,
              presentation: { kind: "independent" },
              reconciliation: { kind: "independent" },
              sources: [],
            },
            next: [],
          }),
        });
      }
      const corrected = { ...last, money: { amount: "0.02", currency: "USD" }, revision: 1 };
      fixture.rows = fixture.rows.map((row) => (row.id === last.id ? corrected : row));
      return route
        .fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: corrected, next: [] }),
        })
        .then(() => {});
    })
    .then(() => {});
const pendingReceived =
  (fixture: HistoryFixture): (() => boolean) =>
  () =>
    Option.isSome(fixture.pending);
const installHistory = (page: Page, count: number): Promise<HistoryFixture> => {
  const fixture: HistoryFixture = {
    rows: fixtureRows(count),
    requests: [],
    mode: "ready",
    firstFailure: false,
    pending: Option.none(),
  };
  return page
    .route(`${apiOrigin}/transactions?*`, (route) => {
      const url = new URL(route.request().url());
      fixture.requests.push(url);
      if (fixture.firstFailure && !url.searchParams.has("cursor")) return route.abort("failed");
      if (url.searchParams.has("cursor")) {
        if (fixture.mode === "hold") {
          fixture.pending = Option.some(route);
          return;
        }
        if (fixture.mode === "failure") return route.abort("failed");
        if (fixture.mode === "expired") {
          return route.fulfill({
            status: unauthorized,
            contentType: "application/json",
            body: JSON.stringify({
              error: { code: "unauthenticated", message: "internal-session-detail" },
              next: [],
            }),
          });
        }
      }
      return fulfillPage(fixture, route);
    })
    .then(() => fixture);
};
test("loads the next Transaction page only when scrolling to the end", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(() => installBoundUser(page));
      yield* wait(() => installCategories({ page, categories: [category] }));
      const fixture = yield* wait(() => installHistory(page, beyondPage));
      yield* wait(() => page.goto("/app/transactions"));
      const rows = page.getByRole("button", { name: /^Ver transacción Registro /u });
      yield* wait(() => expect(rows).toHaveCount(initialPageSize));
      expect(fixture.requests).toHaveLength(1);
      yield* wait(() => page.getByLabel("Continuación de transacciones").scrollIntoViewIfNeeded());
      yield* wait(() => expect(rows).toHaveCount(beyondPage));
      expect(fixture.requests).toHaveLength(2);
    })
  ));
const installBudgetReturn = (page: Page): Promise<void> =>
  page
    .route(`${apiOrigin}/budget-status**`, (route) => route.fulfill({ status: 503, body: "{}" }))
    .then(() => {});
const chooseFixtureDay = (page: Page, fixture: HistoryFixture): Promise<void> => {
  const first = fixture.rows[0];
  if (first === undefined) throw new Error("Missing fixture Transaction");
  const label = DateTime.format(DateTime.makeUnsafe(first.occurredAt), {
    locale: "es-CO",
    timeZone: "America/Bogota",
    dateStyle: "full",
  });
  return page
    .getByRole("button", { name: "Fecha", exact: true })
    .click()
    .then(() => page.getByRole("button", { name: label }).click());
};
test("Back restores each same-month history entry's visited pages independently", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(() => installBoundUser(page));
      yield* wait(() => installCategories({ page, categories: [category] }));
      const fixture = yield* wait(() => installHistory(page, multiplePages));
      yield* wait(() => page.goto("/app/transactions"));
      const rows = page.getByRole("button", { name: /^Ver transacción Registro /u });
      yield* wait(() => page.getByLabel("Continuación de transacciones").scrollIntoViewIfNeeded());
      yield* wait(() => expect(rows).toHaveCount(initialPageSize + pageSize));
      yield* wait(() =>
        page.getByRole("searchbox", { name: "Buscar transacciones" }).fill("Registro")
      );
      yield* wait(() => chooseFixtureDay(page, fixture));
      yield* wait(() => page.getByLabel("Continuación de transacciones").scrollIntoViewIfNeeded());
      yield* wait(() => expect(rows).toHaveCount(multiplePages));
      yield* wait(() => rows.nth(middleRow).scrollIntoViewIfNeeded());
      yield* wait(() => page.goBack());
      yield* wait(() => expect(rows).toHaveCount(initialPageSize + pageSize));
    })
  ));
test("a correction retains all loaded filtered rows while a later page refresh is pending", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(() => installBoundUser(page));
      yield* wait(() => installCategories({ page, categories: [category] }));
      const fixture = yield* wait(() => installHistory(page, multiplePages));
      const last = fixture.rows.at(-1);
      if (last === undefined) throw new Error("Missing fixture Transaction");
      yield* wait(() => installCorrection(page, fixture, last));
      yield* wait(() => page.goto("/app/transactions"));
      const rows = page.getByRole("button", { name: /^Ver transacción Registro /u });
      for (const count of [initialPageSize + pageSize, multiplePages]) {
        yield* wait(() =>
          page.getByLabel("Continuación de transacciones").scrollIntoViewIfNeeded()
        );
        yield* wait(() => expect(rows).toHaveCount(count));
      }
      yield* wait(() =>
        page.getByRole("searchbox", { name: "Buscar transacciones" }).fill("Registro")
      );
      yield* wait(() => rows.last().click());
      yield* wait(() => page.getByLabel("Monto", { exact: true }).fill("0,02"));
      fixture.mode = "hold";
      yield* wait(() => page.getByRole("button", { name: "Guardar", exact: true }).click());
      yield* wait(() => expect(page.getByText("Cambios guardados", { exact: true })).toBeVisible());
      yield* wait(() => expect.poll(pendingReceived(fixture)).toBe(true));
      yield* wait(() => expect(rows).toHaveCount(multiplePages));
      yield* wait(() =>
        expect(page.getByRole("button", { name: "Editar varias", exact: true })).toBeDisabled()
      );
      fixture.mode = "failure";
      yield* wait(() => interruptPending(fixture));
      yield* wait(() =>
        expect(
          page.getByText(
            "No pudimos cargar más transacciones. Conservamos las transacciones cargadas."
          )
        ).toBeVisible()
      );
      yield* wait(() => expect(rows).toHaveCount(multiplePages));
      fixture.mode = "ready";
      yield* wait(() =>
        page
          .getByRole("button", { name: "Reintentar carga de más transacciones", exact: true })
          .click()
      );
      yield* wait(() =>
        expect(page.getByRole("button", { name: "Editar varias", exact: true })).toBeEnabled()
      );
      yield* wait(() => expect(rows).toHaveCount(multiplePages));
      yield* wait(() => expect(rows.last()).toBeInViewport());
    })
  ));

test("a searched later page survives Back, correction and reload", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(() => installBoundUser(page));
      yield* wait(() => installCategories({ page, categories: [category] }));
      const fixture = yield* wait(() => installHistory(page, beyondPage));
      const last = fixture.rows.at(-1);
      if (last === undefined) throw new Error("Missing last fixture Transaction");
      yield* wait(() => installCorrection(page, fixture, last));
      yield* wait(() => installBudgetReturn(page));
      yield* wait(() => page.goto("/app/transactions"));
      const rows = page.getByRole("button", { name: /^Ver transacción Registro /u });
      yield* wait(() => expect(rows).toHaveCount(initialPageSize));
      yield* wait(() => page.getByLabel("Continuación de transacciones").scrollIntoViewIfNeeded());
      yield* wait(() => expect(rows).toHaveCount(beyondPage));
      const search = page.getByRole("searchbox", { name: "Buscar transacciones" });
      yield* wait(() => search.fill("Registro"));
      yield* wait(() => expect(rows).toHaveCount(beyondPage));
      yield* wait(() => rows.nth(middleRow).scrollIntoViewIfNeeded());
      const before = yield* wait(() => scrollPosition(page));
      yield* wait(() => page.getByRole("link", { name: "Presupuestos", exact: true }).click());
      yield* wait(() => expect(page).toHaveURL(/\/app\/budgets/u));
      yield* wait(() => page.goBack());
      yield* wait(() => expect(search).toHaveValue("Registro"));
      yield* wait(() => expect(rows).toHaveCount(beyondPage));
      yield* wait(() => expectScrollAt(page, before));
      yield* wait(() => rows.last().click());
      yield* wait(() => page.getByLabel("Monto", { exact: true }).fill("0,02"));
      yield* wait(() => page.getByRole("button", { name: "Guardar", exact: true }).click());
      yield* wait(() => expect(page.getByText("Cambios guardados", { exact: true })).toBeVisible());
      yield* wait(() => expect(rows).toHaveCount(beyondPage));
      yield* wait(() => expect(rows.last()).toBeInViewport());
      yield* wait(() => rows.nth(middleRow).scrollIntoViewIfNeeded());
      const savedPosition = yield* wait(() => scrollPosition(page));
      fixture.mode = "hold";
      yield* wait(() => page.reload());
      yield* wait(() => expect(search).toHaveValue("Registro"));
      yield* wait(() => expect.poll(pendingReceived(fixture)).toBe(true));
      fixture.mode = "ready";
      yield* wait(() => completePending(fixture));
      yield* wait(() => expect(rows).toHaveCount(beyondPage));
      yield* wait(() => expectScrollAt(page, savedPosition));
      yield* wait(() => expect(rows.nth(middleRow)).toBeInViewport());
    })
  ));
test("pauses automatic continuation while a capture draft is open", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(() => installBoundUser(page));
      yield* wait(() => installCategories({ page, categories: [category] }));
      const fixture = yield* wait(() => installHistory(page, beyondPage));
      yield* wait(() => page.goto("/app/transactions"));
      yield* wait(() => page.getByRole("button", { name: "+ Registrar", exact: true }).click());
      yield* wait(() => page.getByLabel("Monto", { exact: true }).fill("123"));
      yield* wait(() =>
        expect(page.getByRole("button", { name: "Mes anterior", exact: true })).toBeDisabled()
      );
      yield* wait(() => page.getByLabel("Continuación de transacciones").scrollIntoViewIfNeeded());
      yield* wait(() => expect(page.getByLabel("Monto", { exact: true })).toHaveValue("123"));
      expect(fixture.requests).toHaveLength(1);
      yield* wait(() => page.getByRole("button", { name: "Cancelar", exact: true }).click());
      yield* wait(() =>
        expect(page.getByRole("button", { name: /^Ver transacción Registro /u })).toHaveCount(
          beyondPage
        )
      );
    })
  ));

test("browses beyond 100 Transactions and discloses loaded filter and summary scope", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installBoundUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [category] }));
      const fixture = yield* Effect.tryPromise(() => installHistory(page, beyondPage));
      fixture.mode = "hold";
      yield* Effect.tryPromise(() => page.goto("/app/transactions"));
      yield* Effect.tryPromise(() =>
        expect(
          page.getByText("Filtros y resumen aplican a las transacciones cargadas.")
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.getByLabel("Buscar transacciones").fill("Registro 101"));
      yield* Effect.tryPromise(() =>
        expect(
          page.getByText("No hay coincidencias entre las transacciones cargadas")
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() => expect.poll(pendingReceived(fixture)).toBe(true));
      yield* wait(() => expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0));
      yield* wait(() =>
        expect(
          page.getByRole("status", { name: "Cargando transacciones", exact: true })
        ).toHaveAttribute("aria-busy", "true")
      );
      yield* wait(() => completePending(fixture));
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("button", { name: "Ver transacción Registro 101", exact: true })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Limpiar filtros" }).click());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: /^Ver transacción Registro /u })).toHaveCount(
          beyondPage
        )
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Cargar más transacciones" })).toHaveCount(0)
      );
    })
  ));

for (const count of [0, pageSize, multiplePages]) {
  test(`exhausts ${count} Transactions with equal sort keys in canonical order`, ({ page }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* wait(() => installBoundUser(page));
        yield* wait(() => installCategories({ page, categories: [category] }));
        const fixture = yield* wait(() => installHistory(page, count));
        yield* wait(() => page.goto("/app/transactions"));
        const rows = page.getByRole("button", { name: /^Ver transacción Registro /u });
        if (count === 0) {
          yield* wait(() =>
            expect(page.getByRole("heading", { name: /^No hay transacciones en /u })).toBeVisible()
          );
        }
        yield* wait(() => expect(rows).toHaveCount(Math.min(count, initialPageSize)));
        for (let loaded = initialPageSize; loaded < count; loaded += pageSize) {
          yield* wait(() =>
            page.getByLabel("Continuación de transacciones").scrollIntoViewIfNeeded()
          );
          yield* wait(() => expect(rows).toHaveCount(Math.min(loaded + pageSize, count)));
        }
        expect(yield* wait(() => rows.getByText(/^Registro \d+$/u).allTextContents())).toEqual(
          fixture.rows.map((row) => row.counterparty)
        );
        yield* wait(() =>
          expect(
            page.getByRole("button", { name: "Cargar más transacciones", exact: true })
          ).toHaveCount(0)
        );
        expect(fixture.requests.length).toBe(
          1 + Math.max(0, Math.ceil((count - initialPageSize) / pageSize))
        );
        for (const request of fixture.requests) {
          expect(request.searchParams.get("from")).toBe(
            fixture.requests[0]?.searchParams.get("from")
          );
          expect(request.searchParams.get("to")).toBe(fixture.requests[0]?.searchParams.get("to"));
        }
      })
    ));
}

test("retains loaded Transactions on interruption and retries the same bounded page", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(() => installBoundUser(page));
      yield* wait(() => installCategories({ page, categories: [category] }));
      const fixture = yield* wait(() => installHistory(page, beyondPage));
      fixture.mode = "hold";
      yield* wait(() => page.goto("/app/transactions"));
      yield* wait(() => page.getByLabel("Continuación de transacciones").scrollIntoViewIfNeeded());
      yield* wait(() =>
        expect(page.getByLabel("Continuación de transacciones")).toHaveAttribute(
          "aria-busy",
          "true"
        )
      );
      yield* wait(() =>
        expect(page.getByRole("button", { name: /^Ver transacción Registro /u })).toHaveCount(
          initialPageSize
        )
      );
      yield* wait(() => expect.poll(pendingReceived(fixture)).toBe(true));
      yield* wait(() => expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0));
      fixture.mode = "failure";
      yield* wait(() => interruptPending(fixture));
      yield* wait(() =>
        expect(
          page.getByText(
            "No pudimos cargar más transacciones. Conservamos las transacciones cargadas."
          )
        ).toBeVisible()
      );
      yield* wait(() =>
        expect(page.getByRole("button", { name: /^Ver transacción Registro /u })).toHaveCount(
          initialPageSize
        )
      );
      fixture.mode = "ready";
      yield* wait(() =>
        page.getByRole("button", { name: "Reintentar carga de más transacciones" }).click()
      );
      yield* wait(() =>
        expect(page.getByRole("button", { name: /^Ver transacción Registro /u })).toHaveCount(
          beyondPage
        )
      );
      const cursors = fixture.requests
        .filter((request) => request.searchParams.has("cursor"))
        .map((request) => request.searchParams.get("cursor"));
      expect(new Set(cursors).size).toBe(1);
    })
  ));
test("refresh clears selection and ignores the old pending continuation", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(() => installBoundUser(page));
      yield* wait(() => installCategories({ page, categories: [category] }));
      const fixture = yield* wait(() => installHistory(page, beyondPage));
      fixture.mode = "hold";
      yield* wait(() => page.goto("/app/transactions"));
      yield* wait(() => page.getByRole("button", { name: "Editar varias", exact: true }).click());
      yield* wait(() =>
        page.getByRole("checkbox", { name: "Seleccionar Registro 1", exact: true }).click()
      );
      yield* wait(() =>
        expect(
          page
            .getByRole("region", { name: "Selección de transacciones" })
            .getByText("1 seleccionadas", { exact: true })
        ).toBeVisible()
      );
      yield* wait(() => page.getByLabel("Continuación de transacciones").scrollIntoViewIfNeeded());
      yield* wait(() => expect.poll(pendingReceived(fixture)).toBe(true));
      yield* wait(() =>
        page.getByRole("button", { name: "Actualizar transacciones", exact: true }).click()
      );
      yield* wait(() =>
        expect(page.getByRole("region", { name: "Resumen de transacciones" })).toBeVisible()
      );
      yield* wait(() => completePending(fixture));
      yield* wait(() =>
        expect(page.getByRole("button", { name: /^Ver transacción Registro /u })).toHaveCount(
          initialPageSize
        )
      );
      fixture.mode = "ready";
      yield* wait(() => page.getByLabel("Continuación de transacciones").scrollIntoViewIfNeeded());
      yield* wait(() =>
        expect(page.getByRole("button", { name: /^Ver transacción Registro /u })).toHaveCount(
          beyondPage
        )
      );
    })
  ));
test("retains completed history pages through a failed refresh and recovery", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(() => installBoundUser(page));
      yield* wait(() => installCategories({ page, categories: [category] }));
      const fixture = yield* wait(() => installHistory(page, beyondPage));
      yield* wait(() => page.goto("/app/transactions"));
      const rows = page.getByRole("button", { name: /^Ver transacción Registro /u });
      yield* wait(() => expect(rows).toHaveCount(initialPageSize));
      yield* wait(() => page.getByLabel("Continuación de transacciones").scrollIntoViewIfNeeded());
      yield* wait(() => expect(rows).toHaveCount(beyondPage));
      fixture.firstFailure = true;
      yield* wait(() =>
        page.getByRole("button", { name: "Actualizar transacciones", exact: true }).click()
      );
      yield* wait(() =>
        expect(page.getByRole("alert")).toContainText("No pudimos actualizar las transacciones")
      );
      yield* wait(() => expect(rows).toHaveCount(beyondPage));
      fixture.firstFailure = false;
      yield* wait(() =>
        page.getByRole("button", { name: "Reintentar actualización", exact: true }).click()
      );
      yield* wait(() => expect(page.getByRole("alert")).toHaveCount(0));
      yield* wait(() => expect(rows).toHaveCount(beyondPage));
      yield* wait(() =>
        expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeEnabled()
      );
    })
  ));

test("expires authentication during continuation and starts a clean replacement lifetime", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(() => installBoundUser(page));
      yield* wait(() => installCategories({ page, categories: [category] }));
      const fixture = yield* wait(() => installHistory(page, beyondPage));
      fixture.mode = "expired";
      yield* wait(() => page.goto("/app/transactions"));
      yield* wait(() => page.getByLabel("Continuación de transacciones").scrollIntoViewIfNeeded());
      yield* wait(() => expect(page.getByText("No pudimos autorizar esta acción.")).toBeVisible());
      yield* wait(() =>
        expect(page.getByRole("button", { name: /^Ver transacción Registro /u })).toHaveCount(0)
      );
      fixture.mode = "ready";
      fixture.rows = fixtureRows(1).map((row) => ({ ...row, counterparty: "Usuario nuevo" }));
      yield* wait(() => page.reload());
      yield* wait(() =>
        expect(
          page.getByRole("button", { name: "Ver transacción Usuario nuevo", exact: true })
        ).toBeVisible()
      );
      yield* wait(() =>
        expect(page.getByRole("button", { name: /^Ver transacción Registro /u })).toHaveCount(0)
      );
      yield* wait(() =>
        expect(
          page.getByRole("button", { name: "Cargar más transacciones", exact: true })
        ).toHaveCount(0)
      );
    })
  ));

test("saving a later Transaction retains loaded pages and refreshes its correction without duplicates", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(() => installBoundUser(page));
      yield* wait(() => installCategories({ page, categories: [category] }));
      const fixture = yield* wait(() => installHistory(page, beyondPage));
      const last = Option.getOrThrow(Option.fromNullishOr(fixture.rows.at(-1)));
      yield* wait(() => installCorrection(page, fixture, last));
      yield* wait(() => page.goto("/app/transactions"));
      yield* wait(() => page.getByLabel("Continuación de transacciones").scrollIntoViewIfNeeded());
      yield* wait(() =>
        page
          .getByRole("button", { name: `Ver transacción ${last.counterparty}`, exact: true })
          .click()
      );
      yield* wait(() => page.getByLabel("Monto", { exact: true }).fill("0,02"));
      fixture.mode = "hold";
      yield* wait(() => page.getByRole("button", { name: "Guardar", exact: true }).click());
      yield* wait(() => expect(page.getByText("Cambios guardados", { exact: true })).toBeVisible());
      yield* wait(() =>
        expect(page.getByRole("button", { name: /^Ver transacción Registro /u })).toHaveCount(
          beyondPage
        )
      );
      yield* wait(() => expect.poll(pendingReceived(fixture)).toBe(true));
      fixture.mode = "ready";
      yield* wait(() => completePending(fixture));
      yield* wait(() =>
        expect(page.getByRole("button", { name: /^Ver transacción Registro /u })).toHaveCount(
          beyondPage
        )
      );
      yield* wait(() =>
        page
          .getByRole("button", { name: `Ver transacción ${last.counterparty}`, exact: true })
          .click()
      );
      yield* wait(() => expect(page.getByLabel("Monto", { exact: true })).toHaveValue("0,02"));
    })
  ));

const installCalendarHistory = (
  page: Page,
  historical: DateTime.Utc
): Promise<ReadonlyArray<URL>> => {
  const row = {
    ...fixtureRows(1)[0],
    counterparty: "Registro histórico",
    occurredAt: DateTime.formatIso(historical),
  };
  const requests: Array<URL> = [];
  return page
    .route(`${apiOrigin}/transactions?*`, (route) => {
      const url = new URL(route.request().url());
      requests.push(url);
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const included =
        from !== null &&
        to !== null &&
        Date.parse(from) <= historical.epochMilliseconds &&
        historical.epochMilliseconds < Date.parse(to);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: included ? [row] : [], next: [] }),
      });
    })
    .then(() => requests);
};
test("calendar selection loads the selected month and clearing the day retains that month", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(() => installBoundUser(page));
      yield* wait(() => installCategories({ page, categories: [category] }));
      const current = yield* DateTime.now;
      const historical = DateTime.subtract(current, { months: 2 });
      const date = DateTime.formatIsoDate(
        DateTime.setZone(historical, DateTime.zoneMakeNamedUnsafe("America/Bogota"))
      );
      const requests = yield* wait(() => installCalendarHistory(page, historical));
      yield* wait(() => page.goto("/app/transactions"));
      yield* wait(() =>
        expect(page.getByRole("heading", { name: /^No hay transacciones en /u })).toBeVisible()
      );
      yield* wait(() => page.getByRole("button", { name: "Fecha", exact: true }).click());
      yield* wait(() =>
        page.getByRole("button", { name: "Ir al mes anterior", exact: true }).click()
      );
      yield* wait(() =>
        page.getByRole("button", { name: "Ir al mes anterior", exact: true }).click()
      );
      const label = new Intl.DateTimeFormat("es", {
        dateStyle: "full",
        timeZone: "America/Bogota",
      }).format(historical.epochMilliseconds);
      yield* wait(() => page.getByRole("button", { name: label }).click());
      yield* wait(() =>
        expect(
          page.getByRole("button", {
            name: /^Ver transacción Registro histórico(?: Restaurantes)?$/u,
          })
        ).toBeVisible()
      );
      expect(requests.at(-1)?.searchParams.get("from")?.slice(0, "YYYY-MM".length)).toBe(
        date.slice(0, "YYYY-MM".length)
      );
      const count = requests.length;
      yield* wait(() => page.getByRole("button", { name: /^Fecha: / }).click());
      yield* wait(() =>
        page.getByRole("button", { name: "Quitar filtro de día", exact: true }).click()
      );
      yield* wait(() =>
        expect(
          page.getByRole("button", {
            name: /^Ver transacción Registro histórico(?: Restaurantes)?$/u,
          })
        ).toBeVisible()
      );
      expect(requests).toHaveLength(count);
    })
  ));

const prepareHistoricalMonth = Effect.fnUntraced(function* (page: Page) {
  yield* wait(() => installBoundUser(page));
  yield* wait(() => installCategories({ page, categories: [category] }));
  yield* wait(() => installCalendarHistory(page, DateTime.makeUnsafe("2026-10-31T23:00:00Z")));
});

const expectHistoricalTransaction = Effect.fn((page: Page) =>
  wait(() =>
    expect(
      page.getByRole("button", { name: /^Ver transacción Registro histórico(?: Restaurantes)?$/u })
    ).toBeVisible()
  )
);

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
]) {
  test(`history exposes its month and day across empty results, reload and Back at ${viewport.width}px`, ({
    page,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* wait(() => page.setViewportSize(viewport));
        yield* prepareHistoricalMonth(page);
        yield* wait(() => page.goto("/app/transactions?month=2026-11&date=2026-11-01"));
        yield* wait(() =>
          expect(
            page.getByRole("button", { name: "Fecha: 1 de noviembre de 2026", exact: true })
          ).toBeVisible()
        );
        yield* wait(() =>
          expect(
            page.getByRole("heading", {
              name: "No hay transacciones para el 1 de noviembre de 2026",
              exact: true,
            })
          ).toBeVisible()
        );
        yield* wait(() =>
          expect(
            page.getByText("0 transacciones · para el 1 de noviembre de 2026", { exact: true })
          ).toBeVisible()
        );
        yield* wait(() => page.getByRole("button", { name: "Mes anterior", exact: true }).click());
        yield* expectHistoricalTransaction(page);
        yield* wait(() =>
          expect(page.getByLabel("Mes de transacciones", { exact: true })).toHaveValue("10")
        );
        yield* wait(() => page.reload());
        yield* expectHistoricalTransaction(page);
        yield* wait(() =>
          page.getByLabel("Mes de transacciones", { exact: true }).selectOption("12")
        );
        yield* wait(() =>
          expect(
            page.getByRole("heading", {
              name: "No hay transacciones en diciembre de 2026",
              exact: true,
            })
          ).toBeVisible()
        );
        yield* wait(() => page.goBack());
        yield* expectHistoricalTransaction(page);
      })
    ));
}

test("the day picker opens the displayed history month without requiring a selected day", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* prepareHistoricalMonth(page);
      yield* wait(() => page.goto("/app/transactions?month=2026-10"));
      yield* wait(() => page.getByRole("button", { name: "Fecha", exact: true }).click());
      yield* wait(() =>
        expect(
          page.getByRole("button", { name: "jueves, 15 de octubre de 2026", exact: true })
        ).toBeVisible()
      );
      yield* wait(() =>
        page.getByRole("button", { name: "jueves, 15 de octubre de 2026", exact: true }).click()
      );
      yield* wait(() =>
        expect(
          page.getByRole("button", { name: "Fecha: 15 de octubre de 2026", exact: true })
        ).toBeVisible()
      );
    })
  ));

const delayConsentRead = (page: Page, released: Promise<void>): Promise<void> =>
  page
    .route(`${apiOrigin}/web/consent`, (route) =>
      released.then(() =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ status: "Granted", withdrawal: null }),
        })
      )
    )
    .then(() => {});

test("changing and clearing a day preserves the active search within the mounted month", ({
  page,
}) => {
  const released = Promise.withResolvers<void>();
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* prepareHistoricalMonth(page);
      yield* wait(() => page.goto("/app/transactions?month=2026-10"));
      const search = page.getByRole("searchbox", { name: "Buscar transacciones", exact: true });
      yield* wait(() => search.fill("histórico"));
      yield* expectHistoricalTransaction(page);
      yield* wait(() => delayConsentRead(page, released.promise));
      yield* wait(() => page.getByRole("button", { name: "Fecha", exact: true }).click());
      yield* wait(() =>
        page.getByRole("button", { name: "jueves, 15 de octubre de 2026", exact: true }).click()
      );
      yield* wait(() => expect(search).toHaveValue("histórico"));
      yield* wait(() =>
        page.getByRole("button", { name: "Fecha: 15 de octubre de 2026", exact: true }).click()
      );
      yield* wait(() =>
        page.getByRole("button", { name: "Quitar filtro de día", exact: true }).click()
      );
      yield* wait(() => expect(search).toHaveValue("histórico"));
      yield* expectHistoricalTransaction(page);
    }).pipe(Effect.ensuring(Effect.sync(() => released.resolve())))
  );
});

test("month and year remain readable and selectable with enlarged text on a narrow screen", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(() => page.setViewportSize({ width: 320, height: 800 }));
      yield* prepareHistoricalMonth(page);
      yield* wait(() => page.goto("/app/transactions?month=2026-10"));
      yield* expectHistoricalTransaction(page);
      yield* wait(() => page.evaluate(enlargeText));
      const month = page.getByRole("combobox", { name: "Mes de transacciones", exact: true });
      const year = page.getByRole("combobox", { name: "Año de transacciones", exact: true });
      const monthFits = (): Promise<boolean> => month.evaluate(selectedValueFits);
      const viewportFits = (): Promise<boolean> => page.evaluate(pageFits);
      yield* wait(() => expect(month).toHaveValue("10"));
      yield* wait(() => expect(year).toHaveText("2026"));
      yield* wait(() => month.selectOption({ label: "septiembre" }));
      yield* wait(() => expect(page).toHaveURL(/month=2026-09/u));
      yield* wait(() => expect(month).toHaveValue("09"));
      yield* wait(() => expect.poll(monthFits).toBe(true));
      yield* wait(() => expect.poll(viewportFits).toBe(true));
      yield* wait(() => chooseYear(page, "2025"));
      yield* wait(() => expect(page).toHaveURL(/month=2025-09/u));
      yield* wait(() => month.selectOption("12"));
      yield* wait(() => expect(page.getByText("diciembre de 2025", { exact: true })).toBeVisible());
      yield* wait(() => page.getByRole("button", { name: "Mes siguiente", exact: true }).click());
      yield* wait(() => expect(month).toHaveValue("01"));
      yield* wait(() => expect(year).toHaveText("2026"));
      yield* wait(() => page.getByRole("button", { name: "Mes anterior", exact: true }).click());
      yield* wait(() => expect(month).toHaveValue("12"));
      yield* wait(() => expect(year).toHaveText("2025"));
    })
  ));

const enlargeText = (): void => {
  document.documentElement.style.fontSize = "32px";
};
const pageFits = (): boolean => document.documentElement.scrollWidth <= window.innerWidth;
const selectedValueFits = (element: HTMLSelectElement): boolean => {
  const style = getComputedStyle(element);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context === null) return false;
  context.font = style.font;
  const label = element.selectedOptions[0]?.textContent ?? "";
  const available =
    element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  return context.measureText(label).width <= available;
};

const chooseYear = (page: Page, value: string): Promise<void> =>
  page
    .getByRole("combobox", { name: "Año de transacciones", exact: true })
    .click()
    .then(() =>
      page.getByRole("combobox", { name: "Buscar: Año de transacciones", exact: true }).fill(value)
    )
    .then(() => page.getByRole("option", { name: value, exact: true }).click())
    .then(() =>
      expect(page.getByRole("combobox", { name: "Año de transacciones", exact: true })).toHaveText(
        value
      )
    );

test("period controls share one row on desktop and support keyboard year selection and recovery", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(() => page.setViewportSize({ width: 1280, height: 800 }));
      yield* prepareHistoricalMonth(page);
      yield* wait(() => page.goto("/app/transactions?month=2026-10"));
      yield* expectHistoricalTransaction(page);
      const period = page.getByRole("navigation", { name: "Periodo de transacciones" });
      const month = period.getByRole("combobox", { name: "Mes de transacciones", exact: true });
      const year = period.getByRole("combobox", { name: "Año de transacciones", exact: true });
      const bottom = yield* wait(() => month.evaluate(controlBottom));
      for (const control of [
        year,
        period.getByRole("button", { name: "Mes anterior" }),
        period.getByRole("button", { name: "Mes siguiente" }),
      ]) {
        expect(yield* wait(() => control.evaluate(controlBottom))).toBeCloseTo(bottom, 0);
      }
      yield* wait(() => year.press("Enter"));
      const search = page.getByRole("combobox", {
        name: "Buscar: Año de transacciones",
        exact: true,
      });
      yield* wait(() => search.fill("sin año"));
      yield* wait(() => expect(page.getByText("Sin resultados.", { exact: true })).toBeVisible());
      yield* wait(() => search.press("Escape"));
      yield* wait(() => expect(year).toBeFocused());
      yield* wait(() => expect(year).toHaveText("2026"));
      yield* wait(() => year.press("Enter"));
      yield* wait(() => search.fill("2027"));
      yield* wait(() => search.press("ArrowDown"));
      yield* wait(() => search.press("Enter"));
      yield* wait(() => expect(page).toHaveURL(/month=2027-10/u));
      yield* wait(() => chooseYear(page, "0002"));
      yield* wait(() => month.selectOption("01"));
      yield* wait(() =>
        expect(period.getByRole("button", { name: "Mes anterior" })).toBeDisabled()
      );
      yield* wait(() => chooseYear(page, "9998"));
      yield* wait(() => month.selectOption("12"));
      yield* wait(() =>
        expect(period.getByRole("button", { name: "Mes siguiente" })).toBeDisabled()
      );
    })
  ));

const controlBottom = (element: Element): number => element.getBoundingClientRect().bottom;

test("year choices stay reachable by keyboard in a short enlarged-text viewport", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(() => page.setViewportSize({ width: 320, height: 480 }));
      yield* prepareHistoricalMonth(page);
      yield* wait(() => page.goto("/app/transactions?month=2026-10"));
      yield* expectHistoricalTransaction(page);
      yield* wait(() => page.evaluate(enlargeText));
      yield* wait(() =>
        page.getByRole("combobox", { name: "Año de transacciones", exact: true }).click()
      );
      const search = page.getByRole("combobox", {
        name: "Buscar: Año de transacciones",
        exact: true,
      });
      yield* wait(() => search.fill("202"));
      const choices = page.getByRole("option");
      const count = yield* wait(() => choices.count());
      const lastId = yield* wait(() => choices.last().getAttribute("id"));
      for (let index = 0; index < count; index++) {
        if ((yield* wait(() => search.getAttribute("aria-activedescendant"))) === lastId) break;
        yield* wait(() => search.press("ArrowDown"));
      }
      yield* wait(() => expect(choices.last()).toBeInViewport({ ratio: 1 }));
      yield* wait(() => expect(search).toBeInViewport({ ratio: 1 }));
      yield* wait(() => search.press("Enter"));
      yield* wait(() => expect(page).toHaveURL(/month=9202-10/u));
    })
  ));
