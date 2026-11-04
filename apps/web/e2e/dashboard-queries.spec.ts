import type { Page } from "@playwright/test";
import { Effect } from "effect";
import { apiOrigin, installUser, response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;
test.describe.configure({ mode: "parallel" });
const ok = 200;
const absentStatus = 404;
const view = {
  revision: 1,
  title: "Tablero inicializado",
  context: {
    serviceMarket: "CO",
    locale: "es-CO",
    timeZone: "America/Bogota",
    calculatedAt: "2026-09-27T12:00:00Z",
  },
  layout: {
    kind: "leaf",
    widget: {
      widget: {
        id: "24000000-0000-4000-8000-000000000255",
        type: "spending-chart",
        title: "Gastos visibles",
        groupBy: "category",
        period: "this-month",
      },
      result: {
        appliedPeriod: {
          requested: "this-month",
          from: "2026-09-01T05:00:00Z",
          toExclusive: "2026-10-01T05:00:00Z",
          timeZone: "America/Bogota",
        },
        buckets: [],
      },
    },
  },
};
const absent = JSON.stringify({
  error: {
    code: "dashboard_uninitialized",
    message: "Initialize your Dashboard explicitly, then read it again.",
  },
  next: [],
});
const failure = (code: string): string =>
  JSON.stringify({ error: { code, message: "Retry on the authorized surface." }, next: [] });
const scenarios = [
  {
    name: "fresh",
    first: 404,
    initialize: 200,
    second: 200,
    visible: true,
    notice: "",
    calls: ["read", "initialize", "read"],
  },
  {
    name: "existing",
    first: 200,
    initialize: 200,
    second: 200,
    visible: true,
    notice: "",
    calls: ["read"],
  },
  {
    name: "denied",
    first: 404,
    initialize: 403,
    second: 200,
    visible: false,
    notice: "No pudimos crear tu tablero. Intenta de nuevo.",
    calls: ["read", "initialize"],
  },
  {
    name: "initialization-failed",
    first: 404,
    initialize: 503,
    second: 200,
    visible: false,
    notice: "No pudimos crear tu tablero. Intenta de nuevo.",
    calls: ["read", "initialize"],
  },
  {
    name: "second-read-failed",
    first: 404,
    initialize: 200,
    second: 503,
    visible: false,
    notice: "No pudimos cargar tu tablero",
    calls: ["read", "initialize", "read"],
  },
  {
    name: "second-read-absent",
    first: 404,
    initialize: 200,
    second: 404,
    visible: false,
    notice: "No pudimos cargar tu tablero",
    calls: ["read", "initialize", "read"],
  },
  {
    name: "read-failed",
    first: 503,
    initialize: 200,
    second: 200,
    visible: false,
    notice: "",
    calls: ["read"],
  },
] as const;
type Scenario = (typeof scenarios)[number];
const readBody = (status: number): string => {
  if (status === ok) return `<main><h1>${view.title}</h1><h2>Gastos visibles</h2></main>`;
  return status === absentStatus ? absent : failure("unavailable");
};
const assertScenario = Effect.fnUntraced(function* (
  page: Page,
  scenario: Scenario,
  calls: Array<string>
) {
  if (scenario.visible) {
    yield* Effect.tryPromise(() => expect(page.getByText("Gastos visibles").first()).toBeVisible());
  } else {
    if (scenario.name === "second-read-absent") {
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Crear tablero", exact: true })).toBeEnabled()
      );
      yield* Effect.tryPromise(() => expect.poll(() => calls).toEqual(scenario.calls));
    } else {
      yield* Effect.tryPromise(() => expect(page.getByRole("alert")).toBeVisible());
    }
    yield* Effect.tryPromise(() => expect(page.getByText("Gastos visibles")).toHaveCount(0));
    if (scenario.notice !== "" && scenario.name !== "second-read-absent") {
      yield* Effect.tryPromise(() => expect(page.getByText(scenario.notice)).toBeVisible());
    }
  }
});
const installEntry = Effect.fnUntraced(function* (page: Page) {
  yield* Effect.tryPromise(() => installUser(page));
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/transactions?*`, (route) =>
      route.fulfill({ json: { data: [], next: [] } })
    )
  );
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/categories`, (route) =>
      route.fulfill({ json: { data: [], next: [] } })
    )
  );
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/dashboard/catalog`, (route) =>
      route.fulfill({ contentType: "application/json", body: response([]) })
    )
  );
});
const runScenario = Effect.fnUntraced(function* (page: Page, scenario: Scenario) {
  const calls: Array<string> = [];
  let initialized = scenario.first === ok;
  yield* installEntry(page);
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/dashboard/view`, (route) => {
      calls.push("read");
      const status = initialized ? scenario.second : scenario.first;
      const body = readBody(status);
      return route.fulfill({
        status,
        contentType: status === ok ? "text/html" : "application/json",
        body,
      });
    })
  );
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/dashboard/initialize`, (route) => {
      calls.push("initialize");
      expect(route.request().method()).toBe("POST");
      if (scenario.initialize === ok) initialized = true;
      const body =
        scenario.initialize === ok
          ? response({
              revision: 1,
              title: view.title,
              layout: { kind: "leaf", widget: view.layout.widget.widget },
            })
          : failure(scenario.name === "denied" ? "scope_missing" : "unavailable");
      return route.fulfill({ status: scenario.initialize, contentType: "application/json", body });
    })
  );
  // Enter through navigation so the browser owns the mocked HTML-fragment boundary.
  yield* Effect.tryPromise(() => page.goto("/app/transactions"));
  yield* Effect.tryPromise(() => page.getByRole("link", { name: "Tablero", exact: true }).click());
  if (scenario.first === absentStatus) {
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Crear tablero", exact: true })).toBeVisible()
    );
    expect(calls).toEqual(["read"]);
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Crear tablero", exact: true }).click()
    );
  }
  yield* assertScenario(page, scenario, calls);
  expect(calls.filter((call, index) => index === 0 || call !== calls[index - 1])).toEqual(
    scenario.calls
  );
  expect(calls.filter((call) => call === "initialize")).toHaveLength(
    scenario.calls.filter((call) => call === "initialize").length
  );
});

for (const scenario of scenarios) {
  test(`Dashboard first use: ${scenario.name}`, ({ page }) =>
    Effect.runPromise(runScenario(page, scenario)));
}
