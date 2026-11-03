import type { Page } from "@playwright/test";
import { Effect } from "effect";
import { apiOrigin, installUser, response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;
test.use({ reducedMotion: "reduce", hasTouch: true });
const identitySuffixWidth = 12;
const categoryCount = 16;
const halfCategoryCount = 8;
const keyDelayMilliseconds = 50;
const labels = [
  "Restaurantes",
  "Domicilios",
  "Mercado",
  "Transporte",
  "Vivienda",
  "Servicios",
  "Salud",
  "Educación",
  "Compras",
  "Entretenimiento",
  "Viajes",
  "Impuestos",
  "Transferencias",
  "Retiros de efectivo",
  "Ingresos",
  "Otros gastos con un nombre de categoría especialmente largo",
];
const categories = labels.map((label, index) => ({
  id: `10000000-0000-4000-8000-${String(index + 1).padStart(identitySuffixWidth, "0")}`,
  label,
}));
const spendingView = {
  title: "Tablero de categorías",
  context: {
    serviceMarket: "CO",
    locale: "es-CO",
    timeZone: "America/Bogota",
    calculatedAt: "2026-11-02T12:00:00Z",
  },
  layout: {
    kind: "leaf",
    widget: {
      widget: {
        id: "24000000-0000-4000-8000-000000000255",
        type: "spending-chart",
        title: "Gastos por categoría",
        groupBy: "category",
        period: "this-month",
      },
      result: {
        appliedPeriod: {
          requested: "this-month",
          from: "2026-11-01T05:00:00Z",
          toExclusive: "2026-12-01T05:00:00Z",
          timeZone: "America/Bogota",
        },
        buckets: categories.map((category, index) => ({
          key: { kind: "category", category },
          moneyGroups: [
            {
              currency: "COP",
              inflow: { amount: "0", currency: "COP" },
              outflow: { amount: index === 0 ? "45000" : "1", currency: "COP" },
            },
          ],
        })),
      },
    },
  },
};
const catalog = [
  {
    id: "monthly-spending",
    name: "Gastos por categoría",
    description: "Gastos por categoría.",
    widget: { type: "spending-chart", groupBy: "category", period: "this-month" },
  },
  {
    id: "restaurant-budget-cop",
    name: "Presupuesto",
    description: "Presupuesto COP.",
    widget: {
      type: "budget-bar",
      categoryId: "10000000-0000-4000-8000-000000000001",
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
const installSpending = Effect.fnUntraced(function* (page: Page, value = spendingView) {
  yield* Effect.tryPromise(() => installUser(page));
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/dashboard/catalog`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: response(catalog),
      })
    )
  );
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/dashboard/view`, (route) =>
      route.fulfill({ contentType: "application/json", body: response(value) })
    )
  );
});

test("16 spending categories use readable emoji labels below even the smallest bars", ({
  page,
}, testInfo) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* installSpending(page);
      yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
      const restaurant = page.getByRole("img", { name: "Restaurantes", exact: true });
      yield* Effect.tryPromise(() => expect(restaurant).toHaveText("🍽️"));
      const other = page.getByRole("img", { name: labels[15], exact: true });
      yield* Effect.tryPromise(() => expect(other).toHaveText("📦"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("region", { name: "Serie COP" }).getByRole("img")).toHaveCount(
          categoryCount
        )
      );
      yield* Effect.tryPromise(() => page.locator(".recharts-bar-rectangle").first().hover());
      yield* Effect.tryPromise(() => expect(page.getByRole("status")).toContainText("45.000,00"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("status")).toContainText("Restaurantes")
      );
      yield* Effect.tryPromise(() =>
        page
          .locator("[data-slot=card]")
          .screenshot({ path: testInfo.outputPath("categories-desktop.png") })
      );
    })
  ));

test("keyboard navigation exposes exact amounts separately for each Currency", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const first = spendingView.layout.widget.result.buckets[0];
      if (first === undefined) throw new Error("Missing spending fixture");
      const value = {
        ...spendingView,
        layout: {
          ...spendingView.layout,
          widget: {
            ...spendingView.layout.widget,
            result: {
              ...spendingView.layout.widget.result,
              buckets: [
                {
                  ...first,
                  moneyGroups: [
                    ...first.moneyGroups,
                    {
                      currency: "USD",
                      inflow: { amount: "0", currency: "USD" },
                      outflow: { amount: "9007199254740993.12", currency: "USD" },
                    },
                  ],
                },
              ],
            },
          },
        },
      };
      yield* installSpending(page, value);
      yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
      const cop = page.getByRole("region", { name: "Serie COP" });
      const usd = page.getByRole("region", { name: "Serie USD" });
      yield* Effect.tryPromise(() => cop.getByRole("application").focus());
      yield* Effect.tryPromise(() => expect(cop.getByRole("status")).toContainText("45.000,00"));
      yield* Effect.tryPromise(() => usd.getByRole("application").focus());
      yield* Effect.tryPromise(() =>
        expect(usd.getByRole("status")).toContainText("9.007.199.254.740.993,12")
      );
      yield* Effect.tryPromise(() => expect(usd.getByRole("status")).toContainText("Restaurantes"));
      yield* Effect.tryPromise(() =>
        expect(cop.getByRole("img", { name: "Restaurantes", exact: true })).toHaveText("🍽️")
      );
      yield* Effect.tryPromise(() =>
        expect(usd.getByRole("img", { name: "Restaurantes", exact: true })).toHaveText("🍽️")
      );
    })
  ));

test("an empty spending period retains its empty state", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* installSpending(page, {
        ...spendingView,
        layout: {
          ...spendingView.layout,
          widget: {
            ...spendingView.layout.widget,
            result: { ...spendingView.layout.widget.result, buckets: [] },
          },
        },
      });
      yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
      yield* Effect.tryPromise(() =>
        expect(
          page.getByText("No hay transacciones en este periodo", { exact: true })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("region", { name: "Serie COP" })).toHaveCount(0)
      );
    })
  ));

test("touch selection reveals a category's exact amount on a phone", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
      yield* installSpending(page);
      yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
      const series = page.getByRole("region", { name: "Serie COP" });
      yield* Effect.tryPromise(() => series.locator(".recharts-bar-rectangle").first().tap());
      yield* Effect.tryPromise(() =>
        expect(series.getByRole("status")).toContainText("Restaurantes")
      );
      yield* Effect.tryPromise(() => expect(series.getByRole("status")).toContainText("45.000,00"));
    })
  ));

const enlargeText = (): void => {
  document.documentElement.style.fontSize = "32px";
};
const readEmojiSeparation = (expectedCount: number): boolean => {
  const boxes = Array.from(document.querySelectorAll(".dashboard-category-emoji text"), (element) =>
    element.getBoundingClientRect()
  );
  const chartBottom =
    document.querySelector(".dashboard-chart")?.getBoundingClientRect().bottom ?? 0;
  const baseline =
    document.querySelector(".recharts-bar-rectangle")?.getBoundingClientRect().bottom ?? 0;
  return (
    boxes.length === expectedCount &&
    boxes.every((box) => box.top >= baseline && box.bottom <= chartBottom) &&
    boxes.slice(1).every((box, index) => box.left >= (boxes[index]?.right ?? 0))
  );
};
const expectEmojisSeparate = (page: Page, expectedCount: number): Promise<void> =>
  expect.poll(() => page.evaluate(readEmojiSeparation, expectedCount)).toBe(true);
const readOverflow = (): boolean =>
  document.documentElement.scrollWidth > document.documentElement.clientWidth;

const readTooltipFits = (): boolean => {
  const series = document.querySelector(".dashboard-chart-series")?.getBoundingClientRect();
  const tooltip = document.querySelector('[role="status"]')?.getBoundingClientRect();
  return (
    series !== undefined &&
    tooltip !== undefined &&
    tooltip.width > 0 &&
    tooltip.left >= series.left &&
    tooltip.right <= series.right
  );
};
const expectTooltipFits = (page: Page): Promise<void> =>
  expect.poll(() => page.evaluate(readTooltipFits)).toBe(true);

const expectLastCategoryDetails = Effect.fnUntraced(function* (page: Page, count: number) {
  const series = page.getByRole("region", { name: "Serie COP" });
  const chart = series.getByRole("application");
  yield* Effect.tryPromise(() => chart.focus());
  for (let index = 1; index < count; index++) {
    yield* Effect.tryPromise(() => chart.press("ArrowRight", { delay: keyDelayMilliseconds }));
  }
  yield* Effect.tryPromise(() =>
    expect(series.getByRole("status")).toContainText(labels[count - 1] ?? "")
  );
  yield* Effect.tryPromise(() => expectTooltipFits(page));
  yield* Effect.tryPromise(() => expect(series.getByRole("status")).toContainText("1,00"));
});

for (const count of [halfCategoryCount, categoryCount]) {
  test(`${count} category emojis remain separate on a phone with enlarged text and while editing`, ({
    page,
  }, testInfo) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
        yield* installSpending(page, {
          ...spendingView,
          layout: {
            ...spendingView.layout,
            widget: {
              ...spendingView.layout.widget,
              result: {
                ...spendingView.layout.widget.result,
                buckets: spendingView.layout.widget.result.buckets.slice(0, count),
              },
            },
          },
        });
        yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
        const series = page.getByRole("region", { name: "Serie COP" });
        yield* Effect.tryPromise(() => expect(series.getByRole("img")).toHaveCount(count));
        yield* Effect.tryPromise(() =>
          page
            .locator("[data-slot=card]")
            .screenshot({ path: testInfo.outputPath("categories-phone.png") })
        );
        yield* Effect.tryPromise(() => page.evaluate(enlargeText));
        yield* Effect.tryPromise(() => expectEmojisSeparate(page, count));
        yield* expectLastCategoryDetails(page, count);

        yield* Effect.tryPromise(() =>
          page
            .locator("[data-slot=card]")
            .screenshot({ path: testInfo.outputPath("categories-phone-keyboard.png") })
        );
        yield* Effect.tryPromise(() =>
          page.getByRole("button", { name: "Personalizar", exact: true }).click()
        );
        yield* Effect.tryPromise(() =>
          expect(series.getByRole("img", { name: "Restaurantes", exact: true })).toHaveText("🍽️")
        );
        const overflow = yield* Effect.tryPromise(() => page.evaluate(readOverflow));
        expect(overflow).toBe(false);
        yield* Effect.tryPromise(() => page.emulateMedia({ colorScheme: "dark" }));
        yield* Effect.tryPromise(() =>
          page
            .locator("[data-slot=card]")
            .screenshot({ path: testInfo.outputPath("categories-phone-enlarged-editing.png") })
        );
      })
    ));
}
