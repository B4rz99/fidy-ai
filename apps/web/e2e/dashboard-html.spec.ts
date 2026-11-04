import type { Route } from "@playwright/test";
import { Effect } from "effect";
import { playwright } from "./playwright-runtime";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";
import { signInDashboardPerformanceThroughCore } from "./real-core-fixture";

const { test, expect } = playwright;
const { operator } = browserAcceptanceTopology();
const successStatus = 200;
const noContentStatus = 204;

const refuseDashboard = (route: Route): Promise<void> =>
  route.fulfill({
    status: 503,
    json: { error: { code: "unavailable", message: "Retry." }, next: [] },
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
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Personalizar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("list", { name: "Widgets disponibles para arrastrar" })).toBeVisible()
      );
      expect(requests.filter((path) => path === "/dashboard/catalog")).toHaveLength(1);
    })
  ));

test("Dashboard return fetches one fresh same-origin HTML fragment and a failed return withholds financial content", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => signInDashboardPerformanceThroughCore({ page, request }));
      yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Personalizar", exact: true })).toBeEnabled()
      );
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
