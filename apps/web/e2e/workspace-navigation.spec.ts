import type { Page, Route } from "@playwright/test";
import { type Cause, Clock, Effect, type Scope } from "effect";
import { apiOrigin } from "./http-fixtures";
import {
  navigateThroughConsent,
  signInNavigationPerformanceThroughCore,
  signInNavigationThroughCore,
} from "./real-core-fixture";
import { playwright } from "./playwright-runtime";

const { test, expect } = playwright;
const targetMilliseconds = 6.94;
// Preserve the established regression gates; the one-frame stretch target is reported separately.
const switchRegressionMilliseconds = 10;
const budgetRegressionMilliseconds = 16;
const measurementSamples = 5;
const expiredDisplayMilliseconds = 6_000;
const freshConsentTimeoutMilliseconds = 500;
const successfulResponse = 200;
const constrainConnection = (
  connection: Readonly<{ saveData: boolean; effectiveType: string }>
): void => {
  Object.defineProperty(navigator, "connection", { configurable: true, value: connection });
};
const workspaces = [
  {
    name: "Transacciones",
    ready: "+ Registrar",
    path: "/transactions**",
    identity: "navigationTransactions",
  },
  {
    name: "Presupuestos",
    ready: "Mes anterior",
    path: "/budget-status**",
    identity: "navigationBudget",
  },
  {
    name: "Recurrentes",
    ready: "Nuevo recurrente",
    path: "/recurring-plans**",
    identity: "navigationRecurring",
  },
  {
    name: "Tablero",
    ready: "Personalizar",
    path: "/dashboard/view",
    identity: "navigationDashboard",
  },
] as const;

for (const connection of [
  { saveData: false, effectiveType: "4g" },
  { saveData: true, effectiveType: "4g" },
  { saveData: false, effectiveType: "3g" },
]) {
  test(`reads Budget only on navigation with ${connection.saveData ? "data saving" : connection.effectiveType}`, ({
    page,
    request,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() => page.addInitScript(constrainConnection, connection));
        const budgetReads: string[] = [];
        page.on("request", (entry) => {
          if (entry.method() === "GET" && new URL(entry.url()).pathname === "/budget-status") {
            budgetReads.push(entry.method());
          }
        });
        yield* Effect.tryPromise(() =>
          signInNavigationPerformanceThroughCore({ page, request, identity: "navigationBudget" })
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeVisible()
        );
        yield* Effect.tryPromise(() => page.waitForLoadState("networkidle"));
        yield* Effect.sleep("1500 millis");
        expect(budgetReads).toHaveLength(0);
        yield* Effect.tryPromise(() =>
          page.getByRole("link", { name: "Presupuestos", exact: true }).hover()
        );
        yield* Effect.sleep("1500 millis");
        expect(budgetReads).toHaveLength(0);
        const response = page.waitForResponse(
          (reply) =>
            new URL(reply.url()).pathname === "/budget-status" &&
            reply.status() === successfulResponse
        );
        yield* Effect.tryPromise(() => openWorkspace(page, "Presupuestos"));
        yield* Effect.tryPromise(() => response);
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("button", { name: "Mes anterior", exact: true })).toBeVisible()
        );
        expect(budgetReads).toHaveLength(1);
      })
    ));
}

for (const destination of [
  {
    name: "Presupuestos",
    ready: "Mes anterior",
    path: "/budget-status",
    identity: "navigationReviewProfile",
  },
  {
    name: "Recurrentes",
    ready: "Nuevo recurrente",
    path: "/recurring-plans",
    identity: "navigationReviewRecurring",
  },
] as const) {
  test(`reads the first ${destination.name} on visiting from Review while its startup profile refresh is held`, ({
    page,
    request,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          page.addInitScript(constrainConnection, { saveData: true, effectiveType: "4g" })
        );
        yield* Effect.tryPromise(() =>
          signInNavigationPerformanceThroughCore({
            page,
            request,
            identity: destination.identity,
          })
        );
        const profileReads: string[] = [];
        page.on("request", (entry) => {
          if (new URL(entry.url()).pathname === "/user") profileReads.push(entry.method());
        });
        yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("heading", { name: "Todo al día", exact: true })).toBeVisible()
        );
        // Include the registry's one-second timeout buckets when retiring the 400 ms hint.
        yield* Effect.sleep("2100 millis");
        expect(profileReads).toHaveLength(0);
        const current = yield* Clock.currentTimeMillis;
        yield* Effect.tryPromise(() =>
          page.clock.setFixedTime(current + expiredDisplayMilliseconds)
        );
        yield* holdWorkspaceData(page, `${apiOrigin}/user`);
        const prepared = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === destination.path &&
            response.status() === successfulResponse
        );
        yield* Effect.tryPromise(() =>
          page.getByRole("link", { name: destination.name, exact: true }).hover()
        );
        yield* Effect.tryPromise(() => openWorkspace(page, destination.name));
        yield* Effect.tryPromise(() => prepared);
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("button", { name: destination.ready, exact: true })).toBeVisible({
            timeout: 100,
          })
        );
      }).pipe(Effect.scoped)
    ));
}

test("reveals cached Budgets while its expired profile refresh is pending", ({ page, request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInNavigationPerformanceThroughCore({ page, request, identity: "navigationBudget" })
      );
      yield* Effect.tryPromise(() => openWorkspace(page, "Presupuestos"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Mes anterior", exact: true })).toBeEnabled()
      );
      yield* Effect.tryPromise(() => openWorkspace(page, "Por revisar"));
      yield* holdWorkspaceData(page, `${apiOrigin}/user`);
      const current = yield* Clock.currentTimeMillis;
      yield* Effect.tryPromise(() => page.clock.setFixedTime(current + expiredDisplayMilliseconds));
      yield* Effect.tryPromise(() => openWorkspace(page, "Presupuestos"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Mes anterior", exact: true })).toBeVisible({
          timeout: 100,
        })
      );
    }).pipe(Effect.scoped)
  ));

test("retains Access listings on return while freshly checking both lists", ({ page, request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInNavigationPerformanceThroughCore({ page, request, identity: "navigationBudget" })
      );
      yield* Effect.tryPromise(() => page.getByText("Ajustes", { exact: true }).click());
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Accesos", exact: true }).click()
      );
      const tokens = page.getByText("No tienes tokens activos.", { exact: true });
      const agents = page.getByText("No hay conexiones en esta página.", { exact: true });
      yield* Effect.tryPromise(() => expect(tokens).toBeVisible());
      yield* Effect.tryPromise(() => expect(agents).toBeVisible());
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Cuenta", exact: true }).click()
      );
      yield* holdWorkspaceData(page, `${apiOrigin}/pats`);
      yield* holdWorkspaceData(page, `${apiOrigin}/web/oauth/connections**`);
      const rereads = Promise.all([
        page.waitForRequest(`${apiOrigin}/pats`),
        page.waitForRequest(`${apiOrigin}/web/oauth/connections**`),
      ]);
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Accesos", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(tokens).toBeVisible({ timeout: 100 }));
      yield* Effect.tryPromise(() => expect(agents).toBeVisible({ timeout: 100 }));
      yield* Effect.tryPromise(() => rereads);
    }).pipe(Effect.scoped)
  ));

test("reads and initializes a first Dashboard only on the actual visit", ({ page, request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const initializations: string[] = [];
      const reads: string[] = [];
      page.on("request", (entry) => {
        if (new URL(entry.url()).pathname === "/dashboard/view") reads.push(entry.method());
        if (
          entry.method() === "POST" &&
          new URL(entry.url()).pathname === "/dashboard/initialize"
        ) {
          initializations.push(entry.method());
        }
      });
      yield* Effect.tryPromise(() =>
        signInNavigationPerformanceThroughCore({
          page,
          request,
          identity: "navigationFirstDashboard",
        })
      );
      yield* Effect.tryPromise(() => page.waitForLoadState("networkidle"));
      yield* Effect.sleep("1500 millis");
      expect(initializations).toEqual([]);
      expect(reads).toEqual([]);
      yield* Effect.tryPromise(() => openWorkspace(page, "Tablero"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Personalizar", exact: true })).toBeEnabled()
      );
      expect(initializations).toHaveLength(1);
      expect(reads).toHaveLength(2);
    })
  ));

test("keeps closed mobile navigation artwork out of startup and loads it when opened", ({
  page,
  request,
  context,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
      yield* Effect.tryPromise(() =>
        signInNavigationPerformanceThroughCore({
          page,
          request,
          identity: "navigationTransactions",
        })
      );
      const cdp = yield* Effect.tryPromise(() => context.newCDPSession(page));
      yield* Effect.tryPromise(() => cdp.send("Network.setCacheDisabled", { cacheDisabled: true }));
      const artwork: string[] = [];
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (/\/(?:mascot|habitat-ceiba)(?:-[^/]+)?\.webp$/u.test(path)) artwork.push(path);
      });
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeEnabled()
      );
      expect(artwork).toEqual([]);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Menú de navegación", exact: true }).click()
      );
      const artworkCount = (): number => new Set(artwork).size;
      yield* Effect.tryPromise(() => expect.poll(artworkCount).toBe(2));
    })
  ));

for (const workspace of workspaces) {
  test(`returns to ${workspace.name} from cached data while refreshing`, ({ page, request }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          signInNavigationPerformanceThroughCore({ page, request, identity: workspace.identity })
        );
        const development = yield* Effect.tryPromise(() =>
          page.locator('script[src="/@vite/client"]').count()
        );
        yield* Effect.tryPromise(() => openWorkspace(page, workspace.name));
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("button", { name: workspace.ready, exact: true })).toBeVisible()
        );
        yield* Effect.tryPromise(() => openWorkspace(page, "Por revisar"));
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("heading", { name: "Por revisar", exact: true })).toBeVisible()
        );
        yield* holdWorkspaceData(page, `${apiOrigin}${workspace.path}`);
        const samples: number[] = [];
        const count = workspace.name === "Transacciones" ? 1 : measurementSamples;
        for (let sample = 0; sample < count; sample++) {
          if (sample > 0) yield* Effect.tryPromise(() => openWorkspace(page, "Por revisar"));
          // Expire only display freshness; rendering, timers and native authority keep real time.
          if (workspace.name === "Recurrentes" && sample === 0) {
            const current = yield* Clock.currentTimeMillis;
            yield* Effect.tryPromise(() =>
              page.clock.setFixedTime(current + expiredDisplayMilliseconds)
            );
          }
          yield* Effect.tryPromise(() => page.evaluate(observeSwitch, workspace.ready));
          yield* Effect.tryPromise(() => revisitWorkspace(page, workspace.name));
          yield* Effect.tryPromise(() =>
            expect(page.getByRole("button", { name: workspace.ready, exact: true })).toBeVisible({
              timeout: workspace.name === "Transacciones" ? freshConsentTimeoutMilliseconds : 100,
            })
          );
          yield* Effect.tryPromise(() =>
            expect(page.locator("body")).toHaveAttribute(
              "data-workspace-switch-milliseconds",
              /[0-9]/u
            )
          );
          const milliseconds = yield* Effect.tryPromise(() =>
            page.locator("body").getAttribute("data-workspace-switch-milliseconds")
          );
          expect(milliseconds).not.toBeNull();
          samples.push(Number(milliseconds));
          if (workspace.name === "Recurrentes") {
            yield* Effect.tryPromise(() =>
              expect(
                page.getByRole("button", { name: workspace.ready, exact: true })
              ).toBeDisabled()
            );
          }
        }
        yield* Effect.tryPromise(() => recordSamples(workspace.name, samples, development));
      }).pipe(Effect.scoped)
    ));
}

for (const workspace of workspaces.filter((workspace) => workspace.name !== "Transacciones")) {
  test(`returns to ${workspace.name} on a poor connection without waiting for refreshed data`, ({
    page,
    request,
    context,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          signInNavigationPerformanceThroughCore({ page, request, identity: workspace.identity })
        );
        yield* Effect.tryPromise(() => openWorkspace(page, workspace.name));
        const ready = page.getByRole("button", { name: workspace.ready, exact: true });
        yield* Effect.tryPromise(() => expect(ready).toBeEnabled());
        yield* Effect.tryPromise(() => openWorkspace(page, "Por revisar"));
        const cdp = yield* Effect.tryPromise(() => context.newCDPSession(page));
        yield* Effect.tryPromise(() => cdp.send("Network.enable"));
        yield* Effect.tryPromise(() =>
          cdp.send("Network.emulateNetworkConditions", {
            offline: false,
            latency: 400,
            downloadThroughput: 51_200,
            uploadThroughput: 25_600,
          })
        );
        yield* holdWorkspaceData(page, `${apiOrigin}${workspace.path}`);
        const current = yield* Clock.currentTimeMillis;
        yield* Effect.tryPromise(() =>
          page.clock.setFixedTime(current + expiredDisplayMilliseconds)
        );
        yield* Effect.tryPromise(() => openWorkspace(page, workspace.name));
        yield* Effect.tryPromise(() => expect(ready).toBeVisible({ timeout: 100 }));
        yield* Effect.tryPromise(() =>
          expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
        );
      }).pipe(Effect.scoped)
    ));
}

const recordSamples = (
  name: string,
  samples: ReadonlyArray<number>,
  development: number
): Promise<void> => {
  const median = samples.toSorted((left, right) => left - right)[Math.floor(samples.length / 2)];
  if (median === undefined) throw new Error("A navigation benchmark needs at least one sample");
  return test
    .info()
    .attach("workspace-switch-duration", {
      body: `${name}: median ${median} ms; samples ${samples.join(", ")} ms; stretch target ${targetMilliseconds} ms (${median <= targetMilliseconds ? "met" : "not met"})`,
      contentType: "text/plain",
    })
    .then(() => {
      if (development === 0 && name !== "Transacciones") {
        expect(median).toBeLessThanOrEqual(
          name === "Presupuestos" ? budgetRegressionMilliseconds : switchRegressionMilliseconds
        );
      }
    });
};

const openWorkspace = (page: Page, name: string): Promise<void> =>
  page.getByRole("link", { name: new RegExp(`^${name}(?: \\d+ pendientes)?$`, "u") }).click();

const revisitWorkspace = (page: Page, name: string): Promise<void> =>
  name === "Transacciones"
    ? navigateThroughConsent({ page, navigate: () => openWorkspace(page, name) })
    : openWorkspace(page, name);

const observeSwitch = (ready: string): void => {
  delete document.body.dataset.workspaceSwitchMilliseconds;
  document.addEventListener(
    "click",
    () => {
      const start = performance.now();
      const observer = new MutationObserver(() => {
        const found = Array.from(document.querySelectorAll("button")).some(
          (button) =>
            (button.getAttribute("aria-label") ?? button.textContent.trim()) === ready &&
            button.getClientRects().length > 0
        );
        if (!found) return;
        document.body.dataset.workspaceSwitchMilliseconds = String(performance.now() - start);
        observer.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    },
    { capture: true, once: true }
  );
};
const holdWorkspaceData = (
  page: Page,
  path: string
): Effect.Effect<void, Cause.UnknownError, Scope.Scope> =>
  Effect.gen(function* () {
    const release = Promise.withResolvers<void>();
    const pending: Array<Promise<void>> = [];
    const hold = (route: Route): Promise<void> => {
      const work = release.promise.then(() => route.continue());
      pending.push(work);
      return work;
    };
    const cleanup = (): Promise<void> => {
      release.resolve();
      return Promise.all(pending).then(() => page.unroute(path, hold));
    };
    yield* Effect.addFinalizer(() => Effect.tryPromise(cleanup).pipe(Effect.orDie));
    yield* Effect.tryPromise(() => page.route(path, hold));
  });

test("dismisses a recurring editor when leaving its retained workspace", ({ page, request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInNavigationThroughCore({
          page,
          deferFreshEntry: true,
          request,
          identity: "navigationRecurring",
        })
      );
      yield* Effect.tryPromise(() => page.goto("/app/needs-review"));
      yield* Effect.tryPromise(() => openWorkspace(page, "Recurrentes"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Nuevo recurrente", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByLabel("Nombre", { exact: true }).fill("Borrador conservado")
      );
      yield* Effect.tryPromise(() => page.goBack());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Por revisar", exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("dialog", { includeHidden: true })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() => page.goForward());
      yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toHaveCount(0));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Nuevo recurrente", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Nombre", { exact: true })).toHaveValue("")
      );
      yield* Effect.tryPromise(() => page.goBack());
      yield* Effect.tryPromise(() =>
        page
          .getByRole("navigation", { name: "Aplicación" })
          .getByText("Ajustes", { exact: true })
          .click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Privacidad", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Nombre", { exact: true })).toHaveCount(0)
      );
    })
  ));

test("refreshes the retained recurring default month after midnight", ({ page, request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInNavigationThroughCore({
          page,
          deferFreshEntry: true,
          request,
          identity: "navigationClock",
        })
      );
      yield* Effect.tryPromise(() => page.clock.setFixedTime("2026-11-01T04:59:00Z"));
      yield* Effect.tryPromise(() => page.goto("/app/recurring"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: /octubre de 2026/iu })).toBeVisible()
      );
      yield* Effect.tryPromise(() => openWorkspace(page, "Por revisar"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Por revisar", exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.clock.setFixedTime("2026-11-01T05:01:00Z"));
      yield* Effect.tryPromise(() => page.goBack());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: /noviembre de 2026/iu })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Mes anterior", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: /octubre de 2026/iu })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Mes siguiente", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: /noviembre de 2026/iu })).toBeVisible()
      );
    })
  ));

test("opens recurring editors without reading hidden transaction pickers", ({ page, request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInNavigationPerformanceThroughCore({ page, request, identity: "navigationPicker" })
      );
      yield* Effect.tryPromise(() => openWorkspace(page, "Recurrentes"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Nuevo recurrente", exact: true })).toBeEnabled()
      );
      const reads: string[] = [];
      page.on("request", (entry) => {
        if (entry.method() === "GET" && new URL(entry.url()).pathname === "/transactions") {
          reads.push(entry.url());
        }
      });
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Nuevo recurrente", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.locator('[data-recurring-slot="plan-form"]')).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.evaluate(twoAnimationFrames));
      expect(reads).toHaveLength(0);
      const disclosure = page.getByText("Crear desde una transacción", { exact: true });
      yield* Effect.tryPromise(() => disclosure.click());
      yield* Effect.tryPromise(() => waitForTransactionRead(reads));
      const picker = page.locator('[data-recurring-slot="create-source"]');
      yield* Effect.tryPromise(() =>
        expect(picker.getByRole("region", { name: "Resultados de transacciones" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Cargando transacciones…", { exact: true })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() => disclosure.click());
      yield* Effect.tryPromise(() => disclosure.click());
      expect(reads).toHaveLength(1);
    })
  ));

const twoAnimationFrames = (): Promise<void> => {
  const result = Promise.withResolvers<void>();
  requestAnimationFrame(() => requestAnimationFrame(() => result.resolve()));
  return result.promise;
};

const waitForTransactionRead = (reads: ReadonlyArray<string>): Promise<void> =>
  expect.poll(() => reads.length).toBe(1);
