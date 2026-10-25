import type { Page, Route } from "@playwright/test";
import { type Cause, Effect } from "effect";
import { apiOrigin, installCategories, response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";
import { signInRecurringThroughCore } from "./real-core-fixture";

const { expect, test } = playwright;
const { AxeBuilder } = await import("@axe-core/playwright");
const planCount = 100;
const pageCount = 5;
const unsafeName = '<img src=x onerror="alert(1)">';
const idDigits = 12;
const plans = Array.from({ length: planCount }, (_, index) => ({
  id: `71000000-0000-4000-8000-${String(index).padStart(idDigits, "0")}`,
  revisions: [
    {
      from: "2026-10-31",
      plan: {
        name: index === 0 ? unsafeName : `Plan ${String(index).padStart(3, "0")}`,
        kind: "expense",
        currency: "COP",
        amountMode: "fixed",
        money: { amount: "100", currency: "COP" },
        frequency: "monthly",
        firstDate: "2026-10-31",
        timeZone: "America/Bogota",
      },
    },
  ],
  pauses: [],
}));
const workspace = {
  document: {
    revision: 1,
    plans,
    exceptions: [],
    fulfillments: [],
    excludedTransactionIds: [],
    suggestions: [],
  },
  month: "2026-10",
  today: "2026-10-15",
  occurrences: plans.map((plan) => ({
    planId: plan.id,
    date: "2026-10-31",
    expectedDate: "2026-10-31",
    plan: plan.revisions[0]?.plan,
    status: "upcoming",
    completed: { amount: "0", currency: "COP" },
    remaining: { amount: "100", currency: "COP" },
    fulfillments: [],
  })),
  previous: [],
  summary: [
    {
      kind: "expense",
      currency: "COP",
      completed: { amount: "0", currency: "COP" },
      remaining: { amount: "10000", currency: "COP" },
      estimated: { amount: "0", currency: "COP" },
      unknown: 0,
    },
  ],
  invalidFulfillmentIds: [],
  matches: [],
  matchesComplete: true,
};
const serveWorkspace = (route: Route): Promise<void> =>
  route.fulfill({ contentType: "application/json", body: response(workspace) });

test("all 100 recurring items remain reachable in list pages and a crowded calendar day, with complete totals", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInRecurringThroughCore({ page, request, identity: "recurringPagination" })
      );
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() => page.route(`${apiOrigin}/recurring-plans?*`, serveWorkspace));
      yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-10"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("region", { name: "Gastos", exact: true })).toContainText("10.000,00")
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText(unsafeName, { exact: true }).filter({ visible: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() => expect(page.locator("img[src=x]")).toHaveCount(0));
      for (let index = 1; index < pageCount; index++) {
        yield* Effect.tryPromise(() =>
          page.getByRole("button", { name: "Página siguiente de Próximos", exact: true }).click()
        );
      }
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Plan 099", { exact: true }).filter({ visible: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("button", { name: "Página siguiente de Próximos", exact: true })
        ).toBeDisabled()
      );
      const accessibility = yield* Effect.tryPromise(() => new AxeBuilder({ page }).analyze());
      expect(accessibility.violations).toEqual([]);
      yield* inspectCrowdedDay(page);
    })
  ));

const inspectCrowdedDay = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => page.setViewportSize({ width: 1920, height: 1080 }));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Calendario", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      page
        .getByRole("button", { name: "+97 más · Ver 100 recurrentes del 2026-10-31", exact: true })
        .click()
    );
    for (let index = 1; index < pageCount; index++) {
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Página siguiente de 2026-10-31", exact: true }).click()
      );
    }
    yield* Effect.tryPromise(() => page.getByRole("button", { name: /^Plan 099 /u }).click());
    yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toContainText("Plan 099"));
    yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
    yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toHaveCSS("width", "390px"));
    yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toHaveCSS("opacity", "1"));
    const overflow = yield* Effect.tryPromise(() =>
      page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    );
    expect(overflow).toBe(false);
    const accessibility = yield* Effect.tryPromise(() => new AxeBuilder({ page }).analyze());
    expect(accessibility.violations).toEqual([]);
  });
