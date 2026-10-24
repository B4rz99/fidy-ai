import type { Locator, Page } from "@playwright/test";
import { Effect } from "effect";
import { apiOrigin, installUser, response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";
import { signInDashboardThroughCore, signInNavigationThroughCore } from "./real-core-fixture";

const { expect, test } = playwright;

const mobileViewport = { width: 390, height: 844 };
const categoryBoundaryViewport = { width: 980, height: 1000 };
const recentTransactionCount = 10;
const transactionIdentityStart = 700;
const identitySuffixWidth = 12;
const readDimensions = (): Readonly<{ viewport: number; content: number }> => ({
  viewport: document.documentElement.clientWidth,
  content: document.documentElement.scrollWidth,
});
type Rectangle = Readonly<{ x: number; y: number; width: number; height: number }>;
const rectanglesOverlap = (box: Rectangle, other: Rectangle): boolean =>
  box.x < other.x + other.width &&
  box.x + box.width > other.x &&
  box.y < other.y + other.height &&
  box.y + box.height > other.y;
const expectSeparateControls = Effect.fnUntraced(function* (controls: ReadonlyArray<Locator>) {
  const boxes = [];
  for (const control of controls) {
    yield* Effect.tryPromise(() => expect(control).toBeVisible());
    const box = yield* Effect.tryPromise(() => control.boundingBox());
    if (box === null) throw new Error("Missing visible mobile header control");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(mobileViewport.width);
    boxes.push(box);
  }
  for (let index = 0; index < boxes.length; index++) {
    for (const other of boxes.slice(index + 1)) {
      const box = boxes[index];
      if (box === undefined) throw new Error("Missing measured control");
      const overlaps = rectanglesOverlap(box, other);
      expect(overlaps).toBe(false);
    }
  }
});

const recentTransactions = Array.from({ length: recentTransactionCount }, (_, index) => ({
  id: `24000000-0000-4000-8000-${String(index + transactionIdentityStart).padStart(identitySuffixWidth, "0")}`,
  money: {
    amount: index === 0 ? "123456789012345.67" : "25000",
    currency: index === 0 ? "USD" : "COP",
  },
  counterparty: `Comercio de prueba ${index + 1}`,
  direction: index === 0 ? "inflow" : "outflow",
  category: {
    id: "10000000-0000-4000-8000-000000000001",
    label: index === 0 ? "Entretenimiento" : "Restaurantes",
  },
  occurredAt: index < 4 ? "2026-10-24T06:00:00Z" : "2026-10-24T04:30:00Z",
}));

const readRecentColumns = (): ReadonlyArray<ReadonlyArray<number>> =>
  Array.from(document.querySelectorAll(".dashboard-recent-row"), (row) =>
    Array.from(row.children, (cell) => cell.getBoundingClientRect().x)
  );

const readCategoryCollisions = (): ReadonlyArray<boolean> =>
  Array.from(document.querySelectorAll(".dashboard-recent-row"), (row) => {
    const category = row.querySelector(".dashboard-recent-category > span:last-child");
    const direction = row.querySelector(".dashboard-recent-type");
    if (category === null || direction === null) {
      throw new Error("Missing recent category or type cell");
    }
    return category.getBoundingClientRect().right > direction.getBoundingClientRect().left;
  });

const recentCounterparties = recentTransactions.map((transaction) => transaction.counterparty);

const installRecentTransactions = Effect.fnUntraced(function* (page: Page) {
  yield* Effect.tryPromise(() => installUser(page));
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/dashboard/view`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: response({
          title: "Tablero de prueba",
          context: {
            serviceMarket: "CO",
            locale: "es-CO",
            timeZone: "America/Bogota",
            calculatedAt: "2026-10-24T12:00:00Z",
          },
          layout: {
            kind: "leaf",
            widget: {
              widget: {
                id: "24000000-0000-4000-8000-000000000699",
                type: "transaction-list",
                title: "Transacciones recientes",
                limit: 10,
              },
              result: { transactions: recentTransactions },
            },
          },
        }),
      })
    )
  );
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/dashboard/catalog`, (route) =>
      route.fulfill({ contentType: "application/json", body: response([]) })
    )
  );
});

test("application appearance follows the system until a manual choice survives navigation and logout", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => page.emulateMedia({ colorScheme: "dark" }));
      yield* Effect.tryPromise(() => signInDashboardThroughCore({ page, request }));
      yield* Effect.tryPromise(() => page.clock.resume());
      yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Activar tema claro" })).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.emulateMedia({ colorScheme: "light" }));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Activar tema oscuro" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Activar tema oscuro" }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Transacciones", exact: true }).click()
      );
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Activar tema claro" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Cerrar sesión", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Entra a tu Fidy" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Activar tema claro" })).toBeVisible()
      );
    })
  ));

test("mobile navigation keeps the header usable and hides the assistant until navigation closes", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const viewport = mobileViewport;
      yield* Effect.tryPromise(() => page.setViewportSize(viewport));
      yield* Effect.tryPromise(() =>
        signInNavigationThroughCore({ page, request, identity: "navigationDashboard" })
      );
      yield* Effect.tryPromise(() => page.clock.resume());
      yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
      const menu = page.getByRole("button", { name: "Menú de navegación", exact: true });
      const assistant = page.getByRole("button", { name: "Abrir agente Fidy", exact: true });
      const theme = page.getByRole("button", { name: /Activar tema (claro|oscuro)/u });
      const heading = page.getByRole("heading", { level: 1 });
      yield* expectSeparateControls([menu, assistant, theme, heading]);
      yield* Effect.tryPromise(() => assistant.click());
      const message = page.getByRole("textbox", { name: "Mensaje", exact: true });
      yield* Effect.tryPromise(() => message.fill("Borrador conservado al navegar"));
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Cerrar chat" }).click());
      yield* Effect.tryPromise(() => menu.click());
      yield* Effect.tryPromise(() => expect(assistant).toBeHidden());
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Transacciones", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/app\/transactions$/u));
      yield* Effect.tryPromise(() => expect(assistant).toBeVisible());
      yield* Effect.tryPromise(() => assistant.click());
      yield* Effect.tryPromise(() => expect(message).toHaveValue("Borrador conservado al navegar"));
      const composer = yield* Effect.tryPromise(() => message.boundingBox());
      if (composer === null) throw new Error("Missing mobile assistant composer");
      expect(composer.x).toBeGreaterThanOrEqual(0);
      expect(composer.x + composer.width).toBeLessThanOrEqual(viewport.width);
      expect(composer.y + composer.height).toBeLessThanOrEqual(viewport.height);
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Cerrar chat" }).click());
      yield* Effect.tryPromise(() => menu.click());
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Tablero", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Personalizar" })).toBeVisible()
      );
      const dimensions = yield* Effect.tryPromise(() => page.evaluate(readDimensions));
      expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
    })
  ));

test("recent Transactions retain ten canonical entries grouped by local date with separate currencies and directions", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* installRecentTransactions(page);
      yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
      const today = page.getByRole("region", { name: "24 de octubre de 2026", exact: true });
      const yesterday = page.getByRole("region", { name: "23 de octubre de 2026", exact: true });
      yield* Effect.tryPromise(() => expect(today).toBeVisible());
      yield* Effect.tryPromise(() => expect(yesterday).toBeVisible());
      yield* Effect.tryPromise(() =>
        expect(page.getByText(/^Comercio de prueba \d+$/u)).toHaveText(recentCounterparties)
      );
      for (const [index, transaction] of recentTransactions.entries()) {
        const group = index < 4 ? today : yesterday;
        yield* Effect.tryPromise(() =>
          expect(group.getByText(transaction.counterparty, { exact: true })).toBeVisible()
        );
      }
      yield* Effect.tryPromise(() => page.setViewportSize(categoryBoundaryViewport));
      yield* Effect.tryPromise(() =>
        expect(page.locator(".dashboard-recent-category").first()).toBeVisible()
      );
      const collisions = yield* Effect.tryPromise(() => page.evaluate(readCategoryCollisions));
      expect(collisions).toEqual(recentTransactions.map(() => false));
      const columns = yield* Effect.tryPromise(() => page.evaluate(readRecentColumns));
      const first = columns[0];
      if (first === undefined) throw new Error("Missing recent row columns");
      for (const row of columns) expect(row).toEqual(first);
      yield* Effect.tryPromise(() => expect(today).toContainText("USD"));
      yield* Effect.tryPromise(() => expect(today).toContainText("Ingreso"));
      yield* Effect.tryPromise(() => expect(today).toContainText("123.456.789.012.345,67"));
      yield* Effect.tryPromise(() => expect(yesterday).toContainText("COP"));
      yield* Effect.tryPromise(() => expect(yesterday).toContainText("Gasto"));
      yield* Effect.tryPromise(() => expect(yesterday).toContainText("25.000,00"));
      yield* Effect.tryPromise(() => expect(today.getByText(/total del día/iu)).toHaveCount(0));
      yield* Effect.tryPromise(() => expect(yesterday.getByText(/total del día/iu)).toHaveCount(0));
    })
  ));

test("long personalized Widget titles remain clear of the currency badge and edit controls on mobile", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        request.post("http://127.0.0.1:4175/dashboard/reset?dashboard=true")
      );
      yield* Effect.tryPromise(() => page.setViewportSize(mobileViewport));
      yield* Effect.tryPromise(() => signInDashboardThroughCore({ page, request }));
      yield* Effect.tryPromise(() => page.clock.resume());
      yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Personalizar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page
          .getByRole("button", { name: "Renombrar Presupuesto de restaurantes", exact: true })
          .click()
      );
      const title = "Mi presupuesto personal de gastos mensuales";
      yield* Effect.tryPromise(() => page.getByLabel("Nuevo nombre del Widget").fill(title));
      yield* Effect.tryPromise(() => page.getByLabel("Guardar nombre del Widget").click());
      const heading = page.getByRole("heading", { name: title, exact: true });
      const card = page.locator("[data-slot=card]").filter({ has: heading });
      const currency = card.getByText("COP", { exact: true });
      const remove = page.getByRole("button", { name: `Eliminar ${title}`, exact: true });
      yield* expectSeparateControls([heading, currency, remove]);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Guardar", exact: true }).click()
      );
      yield* expectSeparateControls([heading, currency]);
      const dimensions = yield* Effect.tryPromise(() => page.evaluate(readDimensions));
      expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
    })
  ));
