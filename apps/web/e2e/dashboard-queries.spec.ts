import type { Page } from "@playwright/test";
import { Effect } from "effect";
import { apiOrigin, installUser, response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;
const ok = 200;
const absentStatus = 404;
const view = {
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
    notice: "No pudimos inicializar el tablero.",
    calls: ["read", "initialize"],
  },
  {
    name: "initialization-failed",
    first: 404,
    initialize: 503,
    second: 200,
    visible: false,
    notice: "No pudimos inicializar el tablero.",
    calls: ["read", "initialize"],
  },
  {
    name: "second-read-failed",
    first: 404,
    initialize: 200,
    second: 503,
    visible: false,
    notice: "El tablero se inicializó, pero no pudimos leerlo.",
    calls: ["read", "initialize", "read"],
  },
  {
    name: "second-read-absent",
    first: 404,
    initialize: 200,
    second: 404,
    visible: false,
    notice: "El tablero se inicializó, pero no pudimos leerlo.",
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
  if (status === ok) return response(view);
  return status === absentStatus ? absent : failure("unavailable");
};
const runScenario = Effect.fnUntraced(function* (page: Page, scenario: Scenario) {
  const calls: Array<string> = [];
  let initialized = scenario.first === ok;
  yield* Effect.tryPromise(() => installUser(page));
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/dashboard/catalog`, (route) =>
      route.fulfill({ contentType: "application/json", body: response([]) })
    )
  );
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/dashboard/view`, (route) => {
      calls.push("read");
      const status = initialized ? scenario.second : scenario.first;
      const body = readBody(status);
      return route.fulfill({ status, contentType: "application/json", body });
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
              title: view.title,
              layout: { kind: "leaf", widget: view.layout.widget.widget },
            })
          : failure(scenario.name === "denied" ? "scope_missing" : "unavailable");
      return route.fulfill({ status: scenario.initialize, contentType: "application/json", body });
    })
  );
  yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
  if (scenario.visible) {
    yield* Effect.tryPromise(() => expect(page.getByText("Gastos visibles").first()).toBeVisible());
  } else {
    yield* Effect.tryPromise(() => expect(page.getByRole("alert")).toBeVisible());
    yield* Effect.tryPromise(() => expect(page.getByText("Gastos visibles")).toHaveCount(0));
    if (scenario.notice !== "") {
      yield* Effect.tryPromise(() => expect(page.getByText(scenario.notice)).toBeVisible());
    }
  }
  // Runtime Layer startup may interrupt/restart observation before authority is ready. Only
  // the explicit initializer can change the fixture's state, and failures cannot recursively initialize.
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
