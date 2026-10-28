import type { CDPSession, Page } from "@playwright/test";
import { type Cause, Config, Effect, Schema } from "effect";
import { playwright } from "./playwright-runtime";
import { boundSessionRequests, signInNavigationPerformanceThroughCore } from "./real-core-fixture";

const { test, expect } = playwright;
const dataset = Effect.runSync(Config.String("FIDY_ASSESSMENT").pipe(Config.withDefault("small")));
const actionTimeout = 10_000;
const readinessTimeout = 20_000;
const navigationTimeout = 45_000;
const sampleInterval = 50;
const resourceDeadline = 500;
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const routes = [
  { name: "transactions", path: "/app/transactions", ready: "+ Registrar" },
  { name: "budgets", path: "/app/budgets", ready: "Mes anterior" },
  { name: "recurring", path: "/app/recurring", ready: "Nuevo recurrente" },
  { name: "dashboard", path: "/app/dashboard", ready: "Personalizar" },
  { name: "review", path: "/app/needs-review", ready: "" },
  { name: "account", path: "/settings/account", ready: "" },
  { name: "access", path: "/settings/access", ready: "" },
  { name: "upgrade", path: "/upgrade", ready: "" },
  { name: "privacy", path: "/settings/privacy", ready: "" },
] as const;
type Workspace = (typeof routes)[number];
type Sample = {
  journey: string;
  elapsedMs: number;
  outcome: string;
  requests: Array<{ path: string; status: number; durationMs: number; bytes: number }>;
  loadingObservations: number;
  longTasks: number[];
  resourceCount: number;
  resourceBytes: number;
  domNodes: number;
};
type Measure = (
  journey: string,
  action: () => Promise<unknown>,
  ready: () => Promise<unknown>
) => Effect.Effect<void, Cause.UnknownError>;
type Journey = { page: Page; measure: Measure; samples: Sample[] };
const pause = (milliseconds: number): Promise<void> =>
  Effect.runPromise(Effect.sleep(milliseconds));
const observeRequests = (
  page: Page
): { requests: Sample["requests"]; pending: Set<Promise<void>> } => {
  const requests: Sample["requests"] = [];
  const pending = new Set<Promise<void>>();
  page.on("response", (response) => {
    if (!response.url().startsWith("https://127.0.0.1:4174/")) return;
    const entry = {
      path: new URL(response.url()).pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gu, ":id"),
      status: response.status(),
      durationMs: -1,
      bytes: -1,
    };
    requests.push(entry);
    const work = response
      .finished()
      .then(() => {
        entry.durationMs = response.request().timing().responseEnd;
        return response.request().sizes();
      })
      .then((sizes) => {
        entry.bytes = sizes.responseBodySize;
      })
      .catch(() => undefined);
    pending.add(work);
    work.finally(() => pending.delete(work)).catch(() => undefined);
  });
  return { requests, pending };
};
const waitForReady = Effect.fn(function* (page: Page, ready: () => Promise<unknown>) {
  const progress = { settled: false, observations: 0 };
  const observed = ready().finally(() => {
    progress.settled = true;
  });
  while (!progress.settled) {
    const loading = page
      .locator('[data-slot="skeleton"], [data-slot="spinner"], [aria-label^="Cargando"]')
      .or(page.getByText(/^Cargando/u))
      .filter({ visible: true });
    if ((yield* Effect.tryPromise(() => loading.count())) > 0) progress.observations++;
    yield* Effect.tryPromise(() => Promise.race([observed, pause(sampleInterval)]));
  }
  yield* Effect.tryPromise(() => observed);
  return progress.observations;
});
const paintOpportunity = (): Promise<void> => {
  const completion = Promise.withResolvers<void>();
  requestAnimationFrame(() => requestAnimationFrame(() => completion.resolve()));
  return completion.promise;
};
const browserMetrics = (
  page: Page
): Promise<Pick<Sample, "longTasks" | "resourceCount" | "resourceBytes" | "domNodes">> =>
  page.evaluate(() => {
    const entries = performance
      .getEntriesByType("resource")
      .filter((entry) => entry instanceof PerformanceResourceTiming);
    const tasks = performance
      .getEntriesByName("assessment-longtask")
      .filter((entry) => entry instanceof PerformanceMark);
    return {
      longTasks: tasks.map((entry) => Number(entry.detail)),
      resourceCount: entries.length,
      resourceBytes: entries.reduce((sum, entry) => sum + entry.encodedBodySize, 0),
      domNodes: document.querySelectorAll("*").length,
    };
  });
const measureAction = Effect.fn(function* (
  page: Page,
  action: () => Promise<unknown>,
  ready: () => Promise<unknown>
) {
  yield* Effect.tryPromise(action);
  const loadingObservations = yield* waitForReady(page, ready);
  yield* Effect.tryPromise(() => page.evaluate(paintOpportunity));
  return { outcome: "ready", loadingObservations };
});
const makeMeasure = (page: Page, samples: Sample[], profile: string): Measure => {
  const { requests, pending } = observeRequests(page);
  return Effect.fn(function* (journey, action, ready) {
    requests.length = 0;
    yield* Effect.tryPromise(() =>
      page.evaluate(() => {
        performance.clearMarks("assessment-longtask");
        performance.clearResourceTimings();
      })
    );
    const start = performance.now();
    const result = yield* measureAction(page, action, ready).pipe(
      Effect.match({
        onSuccess: (value) => value,
        onFailure: () => ({ outcome: "unavailable-or-timeout", loadingObservations: -1 }),
      })
    );
    const elapsedMs = performance.now() - start;
    yield* Effect.tryPromise(() => Promise.race([Promise.all(pending), pause(resourceDeadline)]));
    const metrics = yield* Effect.tryPromise(() => browserMetrics(page));
    samples.push({ journey, elapsedMs, ...result, requests: requests.slice(), ...metrics });
    process.stdout.write(
      `ASSESSMENT ${profile} ${journey} ${result.outcome} ${Math.round(elapsedMs)}ms\n`
    );
  });
};
const navigate = (page: Page, path: string): Promise<void> => {
  const link = page.locator(`a[href="${path}"]`).first();
  return link
    .isVisible()
    .then((visible) => {
      if (visible) return;
      const menu = page.getByRole("button", { name: "Menú de navegación", exact: true });
      return menu.isVisible().then((shown) => (shown ? menu.click() : undefined));
    })
    .then(() => link.click());
};
const readyWorkspace = (page: Page, route: Workspace): Promise<void> => {
  const timeout = readinessTimeout;
  if (route.ready !== "") {
    return expect(page.getByRole("button", { name: route.ready, exact: true })).toBeEnabled({
      timeout,
    });
  }
  if (route.name === "review") {
    return expect(page.getByLabel("Valor", { exact: true })).toBeVisible({ timeout });
  }
  if (route.name === "upgrade") {
    return expect(page.getByRole("button", { name: /^mensual\b/iu })).toBeEnabled({ timeout });
  }
  if (route.name === "account") {
    return expect(page.getByLabel("Nuevo correo", { exact: true })).toBeVisible({ timeout });
  }
  if (route.name === "access") {
    return expect(page.getByText("No tienes tokens activos.", { exact: true })).toBeVisible({
      timeout,
    });
  }
  return expect(page.getByLabel("Tu autorización está vigente.", { exact: true })).toBeVisible({
    timeout,
  });
};
const warmReturns = Effect.fn(function* ({ page, measure, samples }: Journey, route: Workspace) {
  if (route.ready === "") return;
  for (const sample of [1, 2, 3]) {
    if (samples.at(-1)?.outcome !== "ready") return;
    if (
      (yield* Effect.tryPromise(() => page.locator('a[href="/app/needs-review"]').count())) === 0
    ) {
      return;
    }
    yield* Effect.tryPromise(() => navigate(page, "/app/needs-review"));
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("heading", { name: "Por revisar", exact: true })).toBeVisible()
    );
    yield* measure(
      `${route.name}:warm-${sample}`,
      () => navigate(page, route.path),
      () => readyWorkspace(page, route)
    );
  }
});
const transactionActions = Effect.fn(function* (
  { page, measure, samples }: Journey,
  route: Workspace
) {
  if (samples.at(-1)?.outcome !== "ready") {
    yield* measure(
      "transactions:reload-recovery",
      () => page.goto(route.path),
      () => readyWorkspace(page, route)
    );
  }
  const rows = page.getByRole("button", { name: /^Ver transacción /u });
  const count = yield* Effect.tryPromise(() => rows.count());
  if (count === 0) return;
  yield* measure(
    "transactions:scroll-next-page",
    () =>
      page.getByLabel("Continuación de transacciones", { exact: true }).scrollIntoViewIfNeeded(),
    () => expect.poll(() => rows.count(), { timeout: readinessTimeout }).toBeGreaterThan(count)
  );
  yield* measure(
    "transactions:open-editor",
    () => rows.first().click(),
    () => expect(page.getByLabel("Monto · COP", { exact: true })).toBeVisible()
  );
  if (
    !(yield* Effect.tryPromise(() => page.getByLabel("Monto · COP", { exact: true }).isVisible()))
  ) {
    return;
  }
  const previousAmount = yield* Effect.tryPromise(() =>
    page.getByLabel("Monto · COP", { exact: true }).inputValue()
  );
  yield* Effect.tryPromise(() =>
    page
      .getByLabel("Monto · COP", { exact: true })
      .fill(previousAmount === "2000" ? "3000" : "2000")
  );
  yield* measure(
    "transactions:save",
    () => page.getByRole("button", { name: "Guardar", exact: true }).click(),
    () =>
      expect(page.getByText("Cambios guardados", { exact: true })).toBeVisible({
        timeout: readinessTimeout,
      })
  );
});
const monthAction = Effect.fn(function* ({ page, measure }: Journey, route: Workspace) {
  const previous = page.getByRole("button", { name: "Mes anterior", exact: true });
  if (!(yield* Effect.tryPromise(() => previous.isVisible()))) return;
  if (!(yield* Effect.tryPromise(() => previous.isEnabled()))) return;
  yield* measure(
    `${route.name}:previous-month`,
    () => previous.click(),
    () => readyWorkspace(page, route)
  );
});
const reviewActions = Effect.fn(function* ({ page, measure }: Journey) {
  const value = page.getByLabel("Valor", { exact: true });
  if (!(yield* Effect.tryPromise(() => value.isVisible()))) return;
  yield* measure(
    "review:original",
    () => Promise.resolve(),
    () =>
      expect(page.locator('[data-review="original-body"] pre')).toBeVisible({
        timeout: readinessTimeout,
      })
  );
  const previousDraft = yield* Effect.tryPromise(() => value.inputValue());
  yield* measure(
    "review:autosave",
    () => value.fill(previousDraft === "25000" ? "26000" : "25000"),
    () =>
      expect(page.getByRole("status")).toContainText("Borrador guardado", {
        timeout: readinessTimeout,
      })
  );
  const search = page.getByRole("textbox", { name: "Buscar pendientes en esta página" });
  if (!(yield* Effect.tryPromise(() => search.isVisible()))) return;
  yield* measure(
    "review:filter",
    () => search.fill("no-match-synthetic"),
    () => expect(page.getByRole("heading", { name: "Sin elementos en esta vista" })).toBeVisible()
  );
  yield* Effect.tryPromise(() => search.fill(""));
  const next = page.getByRole("button", { name: "Siguiente", exact: true });
  if (!(yield* Effect.tryPromise(() => next.isVisible()))) return;
  if (!(yield* Effect.tryPromise(() => next.isEnabled()))) return;
  yield* measure(
    "review:next-page",
    () => next.click(),
    () =>
      expect(page.getByRole("button", { name: "Anterior", exact: true })).toBeEnabled({
        timeout: readinessTimeout,
      })
  );
});
const filterTransactions = Effect.fn(function* ({ page, measure }: Journey) {
  const search = page.getByRole("searchbox", { name: "Buscar transacciones", exact: true });
  if (!(yield* Effect.tryPromise(() => search.isVisible()))) return;
  if (!(yield* Effect.tryPromise(() => search.isEnabled()))) return;
  const rows = page.getByRole("button", { name: /^Ver transacción /u });
  yield* measure(
    "transactions:filter",
    () => search.fill("no-match-synthetic"),
    () => expect(rows).toHaveCount(0)
  );
  yield* Effect.tryPromise(() => search.fill(""));
});
const visitWorkspace = Effect.fn(function* (journey: Journey, route: Workspace, cdp: CDPSession) {
  const { page, measure } = journey;
  yield* Effect.tryPromise(() => cdp.send("Network.clearBrowserCache"));
  yield* measure(
    `${route.name}:cold-document`,
    () => page.goto(route.path, { waitUntil: "domcontentloaded", timeout: navigationTimeout }),
    () => readyWorkspace(page, route)
  );
  yield* warmReturns(journey, route);
  if (route.name === "transactions") {
    yield* filterTransactions(journey);
    yield* transactionActions(journey, route);
  }
  if (route.name === "budgets" || route.name === "recurring") {
    yield* monthAction(journey, route);
  }
  if (route.name === "review") {
    yield* reviewActions(journey);
  }
});
const prepareBrowser = Effect.fn(function* (page: Page, cdp: CDPSession, profile: string) {
  page.setDefaultTimeout(actionTimeout);
  yield* Effect.tryPromise(() =>
    page.addInitScript(() => {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          performance.mark("assessment-longtask", {
            startTime: entry.startTime,
            detail: entry.duration,
          });
        }
      }).observe({ type: "longtask", buffered: true });
    })
  );
  if (profile !== "mobile-slow") return;
  yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
  yield* Effect.tryPromise(() => cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 }));
  yield* Effect.tryPromise(() => cdp.send("Network.enable"));
  yield* Effect.tryPromise(() =>
    cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 150,
      downloadThroughput: 200_000,
      uploadThroughput: 93_750,
    })
  );
});
for (const profile of ["desktop", "mobile-slow"] as const) {
  test(`assesses all workspaces on ${profile}`, ({ page, request, context }) => {
    page.setDefaultTimeout(actionTimeout);
    const samples: Sample[] = [];
    return Effect.runPromise(
      Effect.gen(function* () {
        const cdp = yield* Effect.tryPromise(() => context.newCDPSession(page));
        yield* Effect.tryPromise(() =>
          signInNavigationPerformanceThroughCore({ page, request, identity: "navigationDashboard" })
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeVisible()
        );
        yield* prepareBrowser(page, cdp, profile);
        const journey = { page, samples, measure: makeMeasure(page, samples, profile) };
        for (const route of routes) {
          yield* visitWorkspace(journey, route, cdp);
        }
      }).pipe(
        Effect.ensuring(
          Effect.tryPromise(() =>
            test.info().attach("assessment-samples", {
              body: json({ dataset, profile, browser: context.browser()?.version(), samples }),
              contentType: "application/json",
            })
          ).pipe(Effect.orDie)
        )
      )
    );
  });
}

test("measures the recurring response independently of the browser body limit", ({
  page,
  request,
  context,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInNavigationPerformanceThroughCore({ page, request, identity: "navigationDashboard" })
      );
      yield* Effect.sleep("2 seconds");
      const api = boundSessionRequests(context.request);
      for (const view of ["full", "compact"] as const) {
        const response = yield* Effect.tryPromise(() =>
          api.get(
            `https://127.0.0.1:4174/recurring-plans?month=2026-10${view === "compact" ? "&view=compact" : ""}`
          )
        );
        const bytes = yield* Effect.tryPromise(() => response.body());
        yield* Effect.tryPromise(() =>
          test.info().attach(`recurring-response-size-${view}`, {
            body: json({ dataset, view, status: response.status(), bytes: bytes.length }),
            contentType: "application/json",
          })
        );
      }
    })
  ));
