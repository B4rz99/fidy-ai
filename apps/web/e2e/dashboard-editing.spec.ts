import type { BrowserContext, Page, Route } from "@playwright/test";
import { Effect } from "effect";
import { apiOrigin, installUser, response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";

const { test, expect } = playwright;
const failView = (route: Route): Promise<void> => route.abort("failed");
const firstId = "24000000-0000-4000-8000-000000000255";
const secondId = "24000000-0000-4000-8000-000000000256";
const catalog = [
  {
    id: "monthly-spending",
    name: "Gastos del mes",
    description: "Gastos por categoría.",
    widget: { type: "spending-chart", groupBy: "category", period: "this-month" },
  },
  {
    id: "restaurant-budget-cop",
    name: "Presupuesto",
    description: "Presupuesto COP.",
    widget: {
      type: "budget-bar",
      categoryId: "24000000-0000-4000-8000-000000000257",
      currency: "COP",
    },
  },
  {
    id: "recent-transactions",
    name: "Transacciones",
    description: "Últimas transacciones.",
    widget: { type: "transaction-list", limit: 10 },
  },
  {
    id: "monthly-outflows",
    name: "Salidas",
    description: "Salidas del mes.",
    widget: { type: "custom-metric", label: "Salidas", aggregation: "sum", period: "this-month" },
  },
];
const leaf = (id: string, title: string): Readonly<Record<string, unknown>> => ({
  kind: "leaf",
  widget: {
    widget: { id, type: "spending-chart", title, groupBy: "category", period: "this-month" },
    result: {
      appliedPeriod: {
        requested: "this-month",
        from: "2026-10-01T05:00:00Z",
        toExclusive: "2026-11-01T05:00:00Z",
        timeZone: "America/Bogota",
      },
      buckets: [],
    },
  },
});
const view = {
  title: "Mi tablero",
  context: {
    serviceMarket: "CO",
    locale: "es-CO",
    timeZone: "America/Bogota",
    calculatedAt: "2026-10-11T12:00:00Z",
  },
  layout: {
    kind: "split",
    axis: "row",
    children: [
      { weight: 1, node: leaf(firstId, "Gastos visibles") },
      { weight: 1, node: leaf(secondId, "Otro Widget") },
    ],
  },
};
const delayedView =
  ({
    gate,
    value,
  }: Readonly<{ gate: Promise<void>; value: typeof view }>): ((route: Route) => Promise<void>) =>
  (route) =>
    gate.then(() => route.fulfill({ contentType: "application/json", body: response(value) }));

const install = Effect.fnUntraced(function* (page: Page, edits: Array<unknown>) {
  yield* Effect.tryPromise(() => installUser(page));
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/dashboard/view`, (route) =>
      route.fulfill({ contentType: "application/json", body: response(view) })
    )
  );
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/dashboard/catalog`, (route) =>
      route.fulfill({ contentType: "application/json", body: response(catalog) })
    )
  );
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/dashboard/edits`, (route) => {
      edits.push(route.request().postDataJSON());
      return route.fulfill({
        contentType: "application/json",
        body: response({
          title: view.title,
          layout: {
            kind: "leaf",
            widget: {
              id: firstId,
              type: "spending-chart",
              groupBy: "category",
              period: "this-month",
            },
          },
        }),
      });
    })
  );
  yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Personalizar", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(
      page.getByRole("button", { name: "Arrastrar Gastos visibles", exact: true })
    ).toBeEnabled()
  );
});
const expectSwap = (edits: Array<unknown>): Promise<void> =>
  expect
    .poll(() => edits)
    .toEqual([{ op: "swap-widgets", widgetId: firstId, withWidgetId: secondId }]);
const expectOneEdit = (edits: Array<unknown>): Promise<void> =>
  expect.poll(() => edits.length).toBe(1);
const startSwapDrag = Effect.fnUntraced(function* (page: Page) {
  const handle = yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Arrastrar Gastos visibles", exact: true }).boundingBox()
  );
  const destination = yield* Effect.tryPromise(() =>
    page.getByRole("region", { name: "Colocar sobre Otro Widget", exact: true }).boundingBox()
  );
  if (handle === null || destination === null) throw new Error("Missing native drag geometry");
  yield* Effect.tryPromise(() =>
    page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  );
  yield* Effect.tryPromise(() => page.mouse.down());
  yield* Effect.tryPromise(() =>
    page.mouse.move(destination.x + destination.width / 2, destination.y + destination.height / 2, {
      steps: 12,
    })
  );
  yield* Effect.tryPromise(() =>
    expect(
      page.getByRole("region", { name: "Colocar sobre Otro Widget", exact: true })
    ).toHaveClass(/dashboard-drop-active/u)
  );
});
const heldFailure =
  (acknowledgment: Promise<void>, edits: Array<unknown>): ((route: Route) => Promise<void>) =>
  (route) => {
    edits.push(route.request().postDataJSON());
    return acknowledgment.then(() => route.abort("failed"));
  };

const checkTouchCancellation = Effect.fnUntraced(function* (page: Page, context: BrowserContext) {
  const edits: Array<unknown> = [];
  yield* install(page, edits);
  const handle = page.getByRole("button", {
    name: "Arrastrar Gastos visibles",
    exact: true,
  });
  const destination = page.getByRole("region", { name: "Colocar sobre Otro Widget", exact: true });
  yield* Effect.tryPromise(() => destination.scrollIntoViewIfNeeded());
  const bounds = yield* Effect.tryPromise(() => handle.boundingBox());
  const target = yield* Effect.tryPromise(() => destination.boundingBox());
  if (bounds === null || target === null) throw new Error("Missing touch drag geometry");
  const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const input = yield* Effect.tryPromise(() => context.newCDPSession(page));
  try {
    yield* Effect.tryPromise(() =>
      input.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] })
    );
    yield* Effect.tryPromise(() => expect(handle).toHaveAttribute("aria-pressed", "false"));
    yield* Effect.tryPromise(() =>
      input.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    );
    yield* Effect.tryPromise(() => expect(handle).toHaveAttribute("aria-pressed", "false"));
    yield* Effect.tryPromise(() =>
      input.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] })
    );
    yield* Effect.tryPromise(() => expect(handle).toHaveAttribute("aria-pressed", "true"));
    yield* Effect.tryPromise(() =>
      input.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: target.x + target.width / 2, y: target.y + target.height / 2 }],
      })
    );
    yield* Effect.tryPromise(() => expect(destination).toHaveClass(/dashboard-drop-active/u));
    yield* Effect.tryPromise(() =>
      input.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] })
    );
    yield* Effect.tryPromise(() => expect(handle).toHaveAttribute("aria-pressed", "false"));
    expect(edits).toHaveLength(0);
  } finally {
    yield* Effect.tryPromise(() => input.detach());
  }
});
test.describe("Dashboard touch editing", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("a brief touch does not drag, while a held touch activates and can be canceled without saving", ({
    page,
    context,
  }) => Effect.runPromise(checkTouchCancellation(page, context)));
});

test("Dashboard drop updates its visible layout before the server acknowledges it", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const edits: Array<unknown> = [];
      yield* install(page, edits);
      const acknowledgment = Promise.withResolvers<void>();
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/dashboard/edits`, heldFailure(acknowledgment.promise, edits))
      );
      yield* startSwapDrag(page);
      const preview = page.getByLabel("Vista previa de la distribución", { exact: true });
      yield* Effect.tryPromise(() => expect(preview).toHaveCount(0));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { level: 2 }).last()).toHaveText("Otro Widget")
      );
      expect(edits).toHaveLength(0);
      yield* Effect.tryPromise(() => page.mouse.up());
      try {
        yield* Effect.tryPromise(() =>
          expect(preview.locator("h2").last()).toHaveText("Gastos visibles", {
            timeout: 500,
          })
        );
        yield* Effect.tryPromise(() => expectSwap(edits));
      } finally {
        acknowledgment.resolve();
      }
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("alert").filter({ hasText: "No pudimos confirmar el cambio" })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { level: 2 }).last()).toHaveText("Otro Widget")
      );
    })
  ));

test("Dashboard ignores small handle movements without starting a drag or saving", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const edits: Array<unknown> = [];
      yield* install(page, edits);
      const handle = page.getByRole("button", { name: "Arrastrar Gastos visibles", exact: true });
      const bounds = yield* Effect.tryPromise(() => handle.boundingBox());
      if (bounds === null) throw new Error("Missing drag handle");
      const centerX = bounds.x + bounds.width / 2;
      const centerY = bounds.y + bounds.height / 2;
      const accidentalMovement = 2;
      yield* Effect.tryPromise(() => page.mouse.move(centerX, centerY));
      yield* Effect.tryPromise(() => page.mouse.down());
      yield* Effect.tryPromise(() =>
        page.mouse.move(centerX + accidentalMovement, centerY + accidentalMovement)
      );
      yield* Effect.tryPromise(() => expect(handle).toHaveAttribute("aria-pressed", "false"));
      yield* Effect.tryPromise(() => page.mouse.up());
      expect(edits).toHaveLength(0);
    })
  ));
test("Dashboard successful drop stays pending until the canonical reread", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const edits: Array<unknown> = [];
      yield* install(page, edits);
      const refresh = Promise.withResolvers<void>();
      yield* Effect.tryPromise(() =>
        page.route(
          `${apiOrigin}/dashboard/view`,
          delayedView({
            gate: refresh.promise,
            value: {
              ...view,
              layout: { ...view.layout, children: [...view.layout.children].reverse() },
            },
          })
        )
      );
      yield* startSwapDrag(page);
      yield* Effect.tryPromise(() => page.mouse.up());
      const handle = page.getByRole("button", { name: "Arrastrar Gastos visibles", exact: true });
      try {
        yield* Effect.tryPromise(() => expectSwap(edits));
        yield* Effect.tryPromise(() => expect(handle).toBeDisabled());
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("status").filter({ hasText: "Guardando cambio" })).toBeVisible()
        );
      } finally {
        refresh.resolve();
      }
      yield* Effect.tryPromise(() => expect(handle).toBeEnabled());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("status").filter({ hasText: "Guardando cambio" })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { level: 2 }).last()).toHaveText("Gastos visibles")
      );
    })
  ));
test("native Dashboard supports keyboard resize and cancellation without another write", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const edits: Array<unknown> = [];
      yield* install(page, edits);
      // Hold the canonical reread so the test observes the pending render before retrying
      // input. Capturing the POST alone precedes the disabled-controls render.
      const refresh = Promise.withResolvers<void>();
      yield* Effect.tryPromise(() =>
        page.route(
          `${apiOrigin}/dashboard/view`,
          delayedView({ gate: refresh.promise, value: view })
        )
      );
      const separator = page.getByRole("separator", {
        name: "Redimensionar límite después de Gastos visibles",
        exact: true,
      });
      yield* Effect.tryPromise(() => separator.press("ArrowRight"));
      yield* Effect.tryPromise(() => expectOneEdit(edits));
      expect(edits[0]).toMatchObject({
        op: "resize-region",
        widgetIds: [firstId],
        size: { kind: "weight", weight: 1.1 },
      });
      const handle = page.getByRole("button", { name: "Arrastrar Gastos visibles", exact: true });
      yield* Effect.tryPromise(() => expect(handle).toBeDisabled());
      refresh.resolve();
      yield* Effect.tryPromise(() => expect(handle).toBeEnabled());
      yield* Effect.tryPromise(() => handle.press("Space"));
      yield* Effect.tryPromise(() => expect(handle).toHaveAttribute("aria-pressed", "true"));
      yield* Effect.tryPromise(() => handle.press("Escape"));
      yield* Effect.tryPromise(() => expect(handle).toHaveAttribute("aria-pressed", "false"));
      expect(edits).toHaveLength(1);
    })
  ));

test("Dashboard abandons pending placement when the successful save cannot be reread", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const edits: Array<unknown> = [];
      yield* install(page, edits);
      yield* Effect.tryPromise(() => page.route(`${apiOrigin}/dashboard/view`, failView));
      yield* startSwapDrag(page);
      yield* Effect.tryPromise(() => page.mouse.up());
      yield* Effect.tryPromise(() => expectSwap(edits));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert").filter({ hasText: "se guardó" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Vista previa de la distribución", { exact: true })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { level: 2 }).last()).toHaveText("Otro Widget")
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Guardar", exact: true })).toBeEnabled()
      );
      expect(edits).toHaveLength(1);
    })
  ));
