import type { Page, Route } from "@playwright/test";
import { DateTime, Effect, Option } from "effect";
import { apiOrigin, installCategories, installUser } from "./http-fixtures";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;
const category = { id: "24000000-0000-4000-8000-000000000242", label: "Restaurantes" };
const pageSize = 100;
const unauthorized = 401;
const multiplePages = pageSize * 2 + 1;
const wait = Effect.tryPromise;
const uuidWidth = 12;
const beyondPage = pageSize + 1;
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
  pending: Option.Option<Route>;
};
const pageBody = (fixture: HistoryFixture, url: URL): string => {
  const cursor = url.searchParams.get("cursor");
  const previous = fixture.rows.findIndex(
    (row) => `${row.occurredAt}|${row.createdAt}|${row.id}` === cursor
  );
  const start = cursor === null ? 0 : previous + 1;
  const data = fixture.rows.slice(start, start + pageSize);
  const last = data.at(-1);
  const next =
    start + pageSize < fixture.rows.length && last !== undefined
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
    pending: Option.none(),
  };
  return page
    .route(`${apiOrigin}/transactions?*`, (route) => {
      const url = new URL(route.request().url());
      fixture.requests.push(url);
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
      yield* wait(() => installUser(page));
      yield* wait(() => installCategories({ page, categories: [category] }));
      const fixture = yield* wait(() => installHistory(page, beyondPage));
      yield* wait(() => page.goto("/app/transactions"));
      const rows = page.getByRole("button", { name: /^Ver transacción Registro /u });
      yield* wait(() => expect(rows).toHaveCount(pageSize));
      expect(fixture.requests).toHaveLength(1);
      yield* wait(() => page.getByLabel("Continuación de transacciones").scrollIntoViewIfNeeded());
      yield* wait(() => expect(rows).toHaveCount(beyondPage));
      expect(fixture.requests).toHaveLength(2);
    })
  ));
test("pauses automatic continuation while a capture draft is open", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(() => installUser(page));
      yield* wait(() => installCategories({ page, categories: [category] }));
      const fixture = yield* wait(() => installHistory(page, beyondPage));
      yield* wait(() => page.goto("/app/transactions"));
      yield* wait(() => page.getByRole("button", { name: "+ Registrar", exact: true }).click());
      yield* wait(() => page.getByLabel("Monto ($)", { exact: true }).fill("123"));
      yield* wait(() => page.getByLabel("Continuación de transacciones").scrollIntoViewIfNeeded());
      yield* wait(() => expect(page.getByLabel("Monto ($)", { exact: true })).toHaveValue("123"));
      expect(fixture.requests).toHaveLength(1);
      yield* wait(() => page.getByRole("button", { name: "Cancelar", exact: true }).click());
      yield* wait(() => page.getByLabel("Continuación de transacciones").scrollIntoViewIfNeeded());
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
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [category] }));
      const fixture = yield* Effect.tryPromise(() => installHistory(page, beyondPage));
      fixture.mode = "hold";
      yield* Effect.tryPromise(() => page.goto("/app/transactions"));
      yield* Effect.tryPromise(() =>
        expect(
          page.getByText("Filtros y resumen aplican a las transacciones cargadas.")
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Buscar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => page.getByLabel("Buscar transacciones").fill("Registro 101"));
      yield* Effect.tryPromise(() =>
        expect(
          page.getByText("No hay coincidencias entre las transacciones cargadas")
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() => expect.poll(pendingReceived(fixture)).toBe(true));
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
        yield* wait(() => installUser(page));
        yield* wait(() => installCategories({ page, categories: [category] }));
        const fixture = yield* wait(() => installHistory(page, count));
        yield* wait(() => page.goto("/app/transactions"));
        const rows = page.getByRole("button", { name: /^Ver transacción Registro /u });
        yield* wait(() => expect(rows).toHaveCount(Math.min(count, pageSize)));
        for (let loaded = pageSize; loaded < count; loaded += pageSize) {
          yield* wait(() =>
            page.getByLabel("Continuación de transacciones").scrollIntoViewIfNeeded()
          );
          yield* wait(() => expect(rows).toHaveCount(Math.min(loaded + pageSize, count)));
        }
        expect(yield* wait(() => rows.allTextContents())).toEqual(
          fixture.rows.map((row) => `${row.counterparty}${category.label}`)
        );
        yield* wait(() =>
          expect(
            page.getByRole("button", { name: "Cargar más transacciones", exact: true })
          ).toHaveCount(0)
        );
        expect(fixture.requests.length).toBe(Math.max(1, Math.ceil(count / pageSize)));
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
      yield* wait(() => installUser(page));
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
          pageSize
        )
      );
      yield* wait(() => expect.poll(pendingReceived(fixture)).toBe(true));
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
          pageSize
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
      yield* wait(() => installUser(page));
      yield* wait(() => installCategories({ page, categories: [category] }));
      const fixture = yield* wait(() => installHistory(page, beyondPage));
      fixture.mode = "hold";
      yield* wait(() => page.goto("/app/transactions"));
      yield* wait(() => page.getByRole("button", { name: "Editar varias", exact: true }).click());
      yield* wait(() =>
        page.getByRole("checkbox", { name: "Seleccionar Registro 1", exact: true }).click()
      );
      yield* wait(() => expect(page.getByText("1 seleccionadas", { exact: true })).toBeVisible());
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
          pageSize
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
test("expires authentication during continuation and starts a clean replacement lifetime", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(() => installUser(page));
      yield* wait(() => installCategories({ page, categories: [category] }));
      const fixture = yield* wait(() => installHistory(page, beyondPage));
      fixture.mode = "expired";
      yield* wait(() => page.goto("/app/transactions"));
      yield* wait(() => page.getByLabel("Continuación de transacciones").scrollIntoViewIfNeeded());
      yield* wait(() =>
        expect(page.getByText("Tu sesión venció. Inicia sesión de nuevo.")).toBeVisible()
      );
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

test("saving a later Transaction resets pages and reloads its correction without duplicates", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(() => installUser(page));
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
      yield* wait(() => page.getByLabel("Monto ($)", { exact: true }).fill("0.02"));
      yield* wait(() => page.getByRole("button", { name: "Guardar cambios", exact: true }).click());
      yield* wait(() => expect(page.getByText("Cambios guardados", { exact: true })).toBeVisible());
      yield* wait(() =>
        expect(page.getByRole("button", { name: /^Ver transacción Registro /u })).toHaveCount(
          pageSize
        )
      );
      yield* wait(() => page.getByLabel("Continuación de transacciones").scrollIntoViewIfNeeded());
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
      yield* wait(() => expect(page.getByLabel("Monto ($)", { exact: true })).toHaveValue("0.02"));
    })
  ));
