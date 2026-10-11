import type { Page } from "@playwright/test";
import { Effect } from "effect";
import { apiOrigin, installUser, response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";

const { test, expect } = playwright;
const firstId = "24000000-0000-4000-8000-000000000255";
const secondId = "24000000-0000-4000-8000-000000000256";
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
const install = Effect.fnUntraced(function* (page: Page, edits: Array<unknown>) {
  yield* Effect.tryPromise(() => installUser(page));
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/dashboard/view`, (route) =>
      route.fulfill({ contentType: "application/json", body: response(view) })
    )
  );
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/dashboard/catalog`, (route) =>
      route.fulfill({ contentType: "application/json", body: response([]) })
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
test("native Dashboard pointer drop emits exactly one canonical swap", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const edits: Array<unknown> = [];
      yield* install(page, edits);
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
        page.mouse.move(
          destination.x + destination.width / 2,
          destination.y + destination.height / 2,
          { steps: 12 }
        )
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("region", { name: "Colocar sobre Otro Widget", exact: true })
        ).toHaveClass(/dashboard-drop-active/u)
      );
      yield* Effect.tryPromise(() => page.mouse.up());
      yield* Effect.tryPromise(() => expectSwap(edits));
    })
  ));
test("native Dashboard supports keyboard resize and cancellation without another write", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const edits: Array<unknown> = [];
      yield* install(page, edits);
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
      yield* Effect.tryPromise(() => expect(handle).toBeEnabled());
      yield* Effect.tryPromise(() => handle.press("Space"));
      yield* Effect.tryPromise(() => expect(handle).toHaveAttribute("aria-pressed", "true"));
      yield* Effect.tryPromise(() => handle.press("Escape"));
      yield* Effect.tryPromise(() => expect(handle).toHaveAttribute("aria-pressed", "false"));
      expect(edits).toHaveLength(1);
    })
  ));
