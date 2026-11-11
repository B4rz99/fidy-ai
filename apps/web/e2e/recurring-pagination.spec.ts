import { analyzeAccessibility } from "./accessibility";
import type { APIRequestContext, Locator, Page, Route } from "@playwright/test";
import { type Cause, DateTime, Effect } from "effect";
import { apiOrigin, installCategories, response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";
import { signInRecurringThroughCore } from "./real-core-fixture";

const { expect, test } = playwright;
const planCount = 100;
const pageCount = 5;
const mobileCalendarWidth = 390;
const intermediateCalendarWidth = 715;
const desktopCalendarWidth = 1440;
const wideCalendarWidth = 1920;
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
  linkedTransactions: [],
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
        signInRecurringThroughCore({
          page,
          deferFreshEntry: true,
          request,
          identity: "recurringPagination",
        })
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
      const accessibility = yield* Effect.tryPromise(() => analyzeAccessibility(page));
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
    yield* openLastDayItem(page);
    yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
    yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toHaveCSS("width", "390px"));
    yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toHaveCSS("opacity", "1"));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Cerrar", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: /^31 · 100 recurrentes/u }).press("Enter")
    );
    yield* openLastDayItem(page);
    yield* expectNoCalendarOverflow(page);
    const accessibility = yield* Effect.tryPromise(() => analyzeAccessibility(page));
    expect(accessibility.violations).toEqual([]);
  });

test("the recurring calendar preserves empty days and opens a day's agenda on narrow screens", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* openSparseCalendar({ page, request });
      const calendar = page.getByLabel("Calendario de recurrentes", { exact: true });
      yield* Effect.tryPromise(() =>
        expect(calendar.getByRole("region", { name: "2026-10-01", exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(calendar.getByRole("region", { name: "2026-10-31", exact: true })).toBeVisible()
      );
      const day = calendar.getByRole("button", {
        name: "15 · 1 recurrente · jueves, 15 de octubre de 2026",
        exact: true,
      });
      yield* Effect.tryPromise(() => expect(day).toHaveAttribute("aria-current", "date"));
      yield* Effect.tryPromise(() => day.press("Enter"));
      const agenda = page.getByRole("dialog");
      yield* Effect.tryPromise(() => expect(agenda).toContainText("Recurrentes del 2026-10-15"));
      const item = agenda.getByRole("button", { name: /^Plan 001 /u });
      yield* Effect.tryPromise(() => expect(item).toContainText("100,00"));
      yield* Effect.tryPromise(() => expect(item).toHaveAccessibleName(/Próximo/u));
      yield* Effect.tryPromise(() => item.press("Enter"));
      yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toContainText("Plan 001"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Cerrar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(day).toBeFocused());
      const accessibility = yield* Effect.tryPromise(() => analyzeAccessibility(page));
      expect(accessibility.violations).toEqual([]);
      yield* inspectCalendarLayouts(page);
    })
  ));

const serveSparseMonth = (route: Route): Promise<void> => {
  const dates = ["2026-10-02", "2026-10-15", "2026-10-30"];
  const sparse = {
    ...workspace,
    occurrences: workspace.occurrences.slice(0, dates.length).map((item, index) => ({
      ...item,
      date: dates[index],
      expectedDate: dates[index],
    })),
  };
  const month = new URL(route.request().url()).searchParams.get("month");
  const data = month === "2026-11" ? { ...workspace, month, occurrences: [], summary: [] } : sparse;
  return route.fulfill({ contentType: "application/json", body: response(data) });
};

const inspectCalendarLayouts = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const calendar = page.getByLabel("Calendario de recurrentes", { exact: true });
    for (const width of [
      mobileCalendarWidth,
      intermediateCalendarWidth,
      desktopCalendarWidth,
      wideCalendarWidth,
    ]) {
      yield* Effect.tryPromise(() => page.setViewportSize({ width, height: 1080 }));
      const first = calendar.getByRole("region", { name: "2026-10-01", exact: true });
      const second = calendar.getByRole("region", { name: "2026-10-02", exact: true });
      const following = calendar.getByRole("region", { name: "2026-10-08", exact: true });
      yield* Effect.tryPromise(() => expect(first).toBeVisible());
      const boxes = yield* Effect.tryPromise(() =>
        Promise.all([dayPosition(first), dayPosition(second), dayPosition(following)])
      );
      expect(boxes[0].x).toBe(boxes[2].x);
      expect(boxes[0].y).toBeLessThan(boxes[2].y);
      expect(boxes[0].x).toBeLessThan(boxes[1].x);
      yield* expectNoCalendarOverflow(page);
      yield* Effect.tryPromise(() =>
        page.screenshot({ path: test.info().outputPath(`calendar-${width}.png`), fullPage: true })
      );
    }
    yield* Effect.tryPromise(() => calendar.getByRole("button", { name: /^Plan 001 /u }).click());
    yield* Effect.tryPromise(() => page.setViewportSize({ width: 1440, height: 1080 }));
    yield* Effect.tryPromise(() =>
      expect(calendar.getByRole("button", { name: /^15 · 1 recurrente/u })).toBeVisible()
    );
    yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toContainText("Plan 001"));
    yield* expectNoCalendarOverflow(page);
    yield* Effect.tryPromise(() =>
      page.screenshot({ path: test.info().outputPath("calendar-detail-panel.png"), fullPage: true })
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Cerrar", exact: true }).click()
    );
    yield* inspectEnlargedCalendar(page);
  });

const expectNoCalendarOverflow = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true)
  );

const inspectEnlargedCalendar = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Activar tema oscuro", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Todos los recurrentes", exact: true })).toHaveCSS(
        "color",
        "rgb(199, 199, 199)"
      )
    );
    yield* Effect.tryPromise(() =>
      page.evaluate(() => {
        document.documentElement.style.fontSize = "200%";
      })
    );
    yield* expectNoCalendarOverflow(page);
    const accessibility = yield* Effect.tryPromise(() => analyzeAccessibility(page));
    expect(accessibility.violations).toEqual([]);
    yield* Effect.tryPromise(() =>
      page.screenshot({
        path: test.info().outputPath("calendar-dark-enlarged.png"),
        fullPage: true,
      })
    );
  });

const openSparseCalendar = ({
  page,
  request,
}: Readonly<{ page: Page; request: APIRequestContext }>): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      signInRecurringThroughCore({
        page,
        deferFreshEntry: true,
        request,
        identity: "recurringPagination",
      })
    );
    yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
    yield* Effect.tryPromise(() => page.route(`${apiOrigin}/recurring-plans?*`, serveSparseMonth));
    yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
    yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-10"));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Calendario", exact: true }).click()
    );
  });

test("empty recurring months retain their calendar and explain empty days", ({ page, request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* openSparseCalendar({ page, request });
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Mes siguiente", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "noviembre de 2026", exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("heading", { name: "Sin recurrentes para este mes", exact: true })
        ).toBeVisible()
      );
      const calendar = page.getByLabel("Calendario de recurrentes", { exact: true });
      yield* Effect.tryPromise(() =>
        expect(calendar.getByRole("region", { name: "2026-11-30", exact: true })).toBeVisible()
      );
      const day = calendar
        .getByRole("region", { name: "2026-11-01", exact: true })
        .getByRole("button");
      yield* Effect.tryPromise(() => day.press("Enter"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("dialog")).toContainText("Sin recurrentes para este día.")
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Cerrar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(day).toBeFocused());
    })
  ));

const dayPosition = (day: Locator): Promise<Readonly<{ x: number; y: number }>> =>
  day.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { x: bounds.x, y: bounds.y };
  });

const openLastDayItem = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    for (let index = 1; index < pageCount; index++) {
      yield* Effect.tryPromise(() =>
        page
          .getByRole("button", { name: "Página siguiente de 2026-10-31", exact: true })
          .press("Enter")
      );
    }
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: /^Plan 099 /u }).press("Enter")
    );
    yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toContainText("Plan 099"));
  });

test("future pause and stop keep today's standing and settings while lifecycle admission uses retained boundaries", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInRecurringThroughCore({
          page,
          deferFreshEntry: true,
          request,
          identity: "recurringPagination",
        })
      );
      yield* Effect.tryPromise(() =>
        page.clock.setSystemTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-30T02:00:00Z"))
        )
      );
      let stopped = false;
      const serve = (route: Route): Promise<void> =>
        route.fulfill({ contentType: "application/json", body: datedWorkspace(stopped) });
      yield* Effect.tryPromise(() => page.route(`${apiOrigin}/recurring-plans?*`, serve));
      yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-10"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Todos los recurrentes", exact: true }).click()
      );
      const row = page.getByRole("button", { name: "Editar Dated plan", exact: true });
      yield* Effect.tryPromise(() => expect(row).toContainText("Activo"));
      yield* Effect.tryPromise(() => row.click());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Reanudar plan", exact: true })).toBeDisabled()
      );
      stopped = true;
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Todos los recurrentes", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(row).toContainText("Activo"));
      yield* Effect.tryPromise(() => row.click());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Reanudar plan", exact: true })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Pausar plan", exact: true })).toHaveCount(0)
      );
    })
  ));

const datedWorkspace = (stopped: boolean): string => {
  const settings = {
    name: "Dated plan",
    kind: "expense",
    currency: "COP",
    amountMode: "unknown",
    frequency: "monthly",
    firstDate: "2026-01-01",
    timeZone: "America/Bogota",
  };
  return response({
    ...workspace,
    occurrences: [],
    document: {
      ...workspace.document,
      plans: [
        {
          id: "71000000-0000-4000-8000-000000000001",
          revisions: [
            { from: "2026-01-01", plan: settings },
            { from: "2026-11-01", plan: { ...settings, name: "Future name" } },
          ],
          pauses: [{ from: "2026-10-30" }],
          ...(stopped ? { stoppedOn: "2026-11-02" } : {}),
        },
      ],
    },
  });
};
