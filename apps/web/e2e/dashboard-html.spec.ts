import type { APIRequestContext, Page, Route } from "@playwright/test";
import { Effect } from "effect";
import { playwright } from "./playwright-runtime";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";
import {
  createDashboardIfAbsent,
  openDashboardThroughCore,
  signInDashboardPerformanceThroughCore,
} from "./real-core-fixture";

const { test, expect } = playwright;
const { operator } = browserAcceptanceTopology();
const successStatus = 200;
const noContentStatus = 204;
const resourceLimitedStatus = 429;

const refuseDashboard = (route: Route): Promise<void> =>
  route.fulfill({
    status: 503,
    json: { error: { code: "unavailable", message: "Retry." }, next: [] },
  });
const captureReadScreenshots = Effect.fnUntraced(function* (page: Page) {
  yield* Effect.tryPromise(() =>
    page.screenshot({ path: "../../reports/design/dashboard-html-desktop.png", fullPage: true })
  );
  yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
  yield* Effect.tryPromise(() =>
    page.screenshot({ path: "../../reports/design/dashboard-html-mobile.png", fullPage: true })
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Activar tema oscuro", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    page.screenshot({ path: "../../reports/design/dashboard-html-mobile-dark.png", fullPage: true })
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Activar tema claro", exact: true }).click()
  );
  yield* Effect.tryPromise(() => page.setViewportSize({ width: 1280, height: 720 }));
});

test("Dashboard absence requires creation and direct entry paints one escaped HTML read without catalog", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const reset = yield* Effect.tryPromise(() =>
        request.post(`${operator}/dashboard/reset?dashboard=true`)
      );
      expect(reset.status()).toBe(noContentStatus);
      yield* Effect.tryPromise(() => signInDashboardPerformanceThroughCore({ page, request }));
      const requests: string[] = [];
      page.on("request", (event) => {
        const path = new URL(event.url()).pathname;
        if (path.startsWith("/dashboard")) requests.push(path);
      });
      const first = yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
      expect(first?.headers()["cache-control"]).toBe("no-store");
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Crear tablero", exact: true })).toBeVisible()
      );
      expect(requests).not.toContain("/dashboard/initialize");
      expect(requests).not.toContain("/dashboard/catalog");
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Crear tablero", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Personalizar", exact: true })).toBeEnabled()
      );
      expect(requests.filter((path) => path === "/dashboard/initialize")).toHaveLength(1);
      yield* Effect.sleep("12 seconds");
      requests.length = 0;
      const document = yield* Effect.tryPromise(() => page.reload());
      expect(document?.status()).toBe(successStatus);
      const html = yield* Effect.tryPromise(() => document?.text() ?? Promise.resolve(""));
      expect(html).toContain('id="dashboard-initial"');
      expect(html).toContain('data-dashboard-read-state="ready"');
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Personalizar", exact: true })).toBeEnabled()
      );
      expect(requests).not.toContain("/dashboard/view");
      expect(requests).not.toContain("/dashboard/catalog");
      yield* captureReadScreenshots(page);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Personalizar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("list", { name: "Widgets disponibles para arrastrar" })).toBeVisible()
      );
      expect(requests.filter((path) => path === "/dashboard/catalog")).toHaveLength(1);
      yield* Effect.tryPromise(() =>
        page.screenshot({
          path: "../../reports/design/dashboard-customize-desktop.png",
          fullPage: true,
        })
      );
    })
  ));

const openCreatedDashboard = Effect.fnUntraced(function* (page: Page, request: APIRequestContext) {
  expect(
    (yield* Effect.tryPromise(() =>
      request.post(`${operator}/dashboard/reset?dashboard=true`)
    )).status()
  ).toBe(noContentStatus);
  yield* Effect.tryPromise(() => signInDashboardPerformanceThroughCore({ page, request }));
  yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Crear tablero", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("button", { name: "Personalizar", exact: true })).toBeEnabled()
  );
});

test("Dashboard return fetches one fresh same-origin HTML fragment and a failed return withholds financial content", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* openCreatedDashboard(page, request);
      yield* Effect.sleep("12 seconds");
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Transacciones", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeEnabled()
      );
      const fresh = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/dashboard/view"
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Tablero", exact: true }).click()
      );
      const response = yield* Effect.tryPromise(() => fresh);
      expect(new URL(response.url()).origin).toBe(new URL(page.url()).origin);
      expect(response.headers()["content-type"]).toContain("text/html");
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Personalizar", exact: true })).toBeEnabled()
      );
      yield* Effect.tryPromise(() => page.route("**/dashboard/view", refuseDashboard));
      yield* Effect.sleep("12 seconds");
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Transacciones", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeEnabled()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Tablero", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("button", { name: "Reintentar carga del tablero", exact: true })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("heading", { name: "Transacciones recientes", exact: true })
        ).toHaveCount(0)
      );
      yield* Effect.tryPromise(() => page.unroute("**/dashboard/view"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Reintentar carga del tablero", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Personalizar", exact: true })).toBeEnabled()
      );
    })
  ));

const holdFirstDashboard =
  (held: Route[]) =>
  (route: Route): Promise<void> | void => {
    if (held.length === 0) {
      held.push(route);
      return;
    }
    return route.fulfill({
      contentType: "text/html",
      body: '<main data-dashboard-read-state="ready"><h1>Visita vigente</h1></main>',
    });
  };
const routeCount = (routes: Route[]) => (): number => routes.length;

test("a superseded Dashboard transfer cannot replace a later mounted visit", ({ page, request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* openCreatedDashboard(page, request);
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Transacciones", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeEnabled()
      );
      const held: Route[] = [];
      yield* Effect.tryPromise(() => page.route("**/dashboard/view", holdFirstDashboard(held)));
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Tablero", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.locator('[data-dashboard-read-state="pending"]')).toBeVisible()
      );
      yield* Effect.tryPromise(() => expect.poll(routeCount(held)).toBe(1));
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Transacciones", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeEnabled()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Tablero", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Visita vigente", exact: true })).toBeVisible()
      );
      for (const route of held) {
        yield* Effect.tryPromise(() =>
          route.fulfill({
            contentType: "text/html",
            body: '<main data-dashboard-read-state="ready"><h1>Visita obsoleta</h1></main>',
          })
        );
      }
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Visita vigente", exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Visita obsoleta", exact: true })).toHaveCount(0)
      );
    })
  ));

const refuseFirstRead =
  (state: { reads: number }): ((route: Route) => Promise<void>) =>
  (route) => {
    state.reads++;
    return state.reads === 1 ? refuseDashboard(route) : route.continue();
  };
const refuseFirstInitialization =
  (state: { attempts: number; committed: number }): ((route: Route) => Promise<void>) =>
  (route) => {
    state.attempts++;
    if (state.attempts === 1) {
      return route.fulfill({
        status: resourceLimitedStatus,
        headers: { "retry-after": "1" },
        json: {
          _tag: "ResourceLimited",
          error: { code: "rate_limited", message: "Try again later.", retryAfterSeconds: 1 },
          next: [],
        },
      });
    }
    return route.fetch({ maxRetries: 0 }).then((response) => {
      if (response.status() === successStatus) state.committed++;
      else expect(response.status()).toBe(resourceLimitedStatus);
      return route.fulfill({ response });
    });
  };
const unavailableInitialization =
  (state: { attempts: number }): ((route: Route) => Promise<void>) =>
  (route) => {
    state.attempts++;
    return refuseDashboard(route);
  };

test("recovers a refused post-creation Dashboard read without repeating initialization", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(
        (yield* Effect.tryPromise(() =>
          request.post(`${operator}/dashboard/reset?dashboard=true`)
        )).status()
      ).toBe(noContentStatus);
      yield* Effect.tryPromise(() => signInDashboardPerformanceThroughCore({ page, request }));
      yield* Effect.tryPromise(() => openDashboardThroughCore(page));
      let initializations = 0;
      const state = { reads: 0 };
      page.on("response", (response) => {
        if (
          new URL(response.url()).pathname === "/dashboard/initialize" &&
          response.status() === successStatus
        ) {
          initializations++;
        }
      });
      yield* Effect.tryPromise(() => page.route("**/dashboard/view", refuseFirstRead(state)));
      yield* Effect.tryPromise(() => createDashboardIfAbsent(page));
      expect(initializations).toBe(1);
      expect(state.reads).toBeGreaterThanOrEqual(2);
    })
  ));

test("handles a decoded non-admission during creation without duplicating committed work", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(
        (yield* Effect.tryPromise(() =>
          request.post(`${operator}/dashboard/reset?dashboard=true`)
        )).status()
      ).toBe(noContentStatus);
      yield* Effect.tryPromise(() => signInDashboardPerformanceThroughCore({ page, request }));
      yield* Effect.tryPromise(() => openDashboardThroughCore(page));
      const state = { attempts: 0, committed: 0 };
      yield* Effect.tryPromise(() =>
        page.route("**/dashboard/initialize", refuseFirstInitialization(state))
      );
      yield* Effect.tryPromise(() => createDashboardIfAbsent(page));
      expect(state.attempts).toBeGreaterThanOrEqual(2);
      expect(state.committed).toBe(1);
    })
  ));

test("does not replay an unavailable Dashboard creation while recovering setup", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(
        (yield* Effect.tryPromise(() =>
          request.post(`${operator}/dashboard/reset?dashboard=true`)
        )).status()
      ).toBe(noContentStatus);
      yield* Effect.tryPromise(() => signInDashboardPerformanceThroughCore({ page, request }));
      yield* Effect.tryPromise(() => openDashboardThroughCore(page));
      const state = { attempts: 0 };
      yield* Effect.tryPromise(() =>
        page.route("**/dashboard/initialize", unavailableInitialization(state))
      );
      yield* Effect.tryPromise(() => expect(createDashboardIfAbsent(page)).rejects.toThrow());
      expect(state.attempts).toBe(1);
    })
  ));
