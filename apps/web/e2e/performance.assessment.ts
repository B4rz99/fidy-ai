import { prepareAssessmentFixture } from "./assessment-fixture";
import type { CDPSession, Page, Response } from "@playwright/test";
import { type Cause, Clock, Config, Effect, Option, Schema } from "effect";
import { playwright } from "./playwright-runtime";
import { boundSessionRequests, signInNavigationPerformanceThroughCore } from "./real-core-fixture";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";

const { test, expect } = playwright;
const dataset = Effect.runSync(Config.String("FIDY_ASSESSMENT").pipe(Config.withDefault("small")));
const networkProfile = Schema.decodeUnknownSync(Schema.Literals(["normal", "poor"]))(
  Effect.runSync(Config.String("FIDY_ASSESSMENT_NETWORK").pipe(Config.withDefault("normal")))
);
const poorConnection = {
  offline: false,
  latency: 400,
  downloadThroughput: 125_000,
  uploadThroughput: 125_000,
};
const { api: apiOrigin } = browserAcceptanceTopology();
test.beforeAll(prepareAssessmentFixture);
const actionTimeout = 10_000;
const readinessTimeout = 20_000;
const navigationTimeout = 45_000;
const sampleInterval = 50;
const coldRepeats = Effect.runSync(
  Config.Int("FIDY_ASSESSMENT_COLD_REPEATS").pipe(Config.withDefault(1))
);
const coldWorkspace = Effect.runSync(
  Config.String("FIDY_ASSESSMENT_COLD_WORKSPACE").pipe(Config.withDefault(""))
);
const coldWorkspaces = coldWorkspace === "" ? [] : coldWorkspace.split(",");
const maximumColdRepeats = 5;
if (coldRepeats < 1 || coldRepeats > maximumColdRepeats) {
  throw new Error("Cold repeats must be between one and five");
}
const coldInteractions = Effect.runSync(
  Config.Boolean("FIDY_ASSESSMENT_COLD_INTERACTIONS").pipe(Config.withDefault(false))
);
const inAppHeadersOnly = Effect.runSync(
  Config.Boolean("FIDY_ASSESSMENT_HEADERS_ONLY").pipe(Config.withDefault(false))
);
const resourceDeadline = 500;
const previewCompression = Effect.runSync(
  Config.String("PREVIEW_COMPRESSION").pipe(Config.withDefault("identity"))
);
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
if (coldWorkspaces.some((name) => !routes.some((route) => route.name === name))) {
  throw new Error("Unknown cold workspace");
}
const timingNames = [
  "bootstrap",
  "bootstrap-entry",
  "bootstrap-source",
  "bootstrap-disclosure",
  "bootstrap-metadata",
  "bootstrap-history",
  "bootstrap-authority",
  "bootstrap-encoding",
  "bootstrap-admission",
  "bootstrap-other",
  "canonical-total",
  "canonical-admission",
  "canonical-owner",
  "canonical-standing",
  "canonical-other",
  "canonical-storage",
  "canonical-present",
  "canonical-sql",
  "dashboard-hop",
  "dashboard-queue",
  "dashboard-execute",
  "dashboard-source",
  "dashboard-projection",
  "dashboard-audit",
  "dashboard-recovery-r2",
  "dashboard-recovery-d1",
  "dashboard-recovery-sql",
  "recovery-r2",
  "recovery-d1",
  "recovery-sql",
] as const;
type TimingName = (typeof timingNames)[number];
const decodeTimingName = Schema.decodeUnknownOption(Schema.Literals(timingNames));
const decodeDuration = Schema.decodeUnknownOption(
  Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 600_000 }))
);
const decodeBatchCount = Schema.decodeUnknownOption(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))
);
const maximumTimingHeaderLength = 8192;
const maximumObservedRequests = 200;
const serverTimings = (
  header: Option.Option<string>
): Array<{ name: TimingName; durationMs: number }> => {
  if (Option.isNone(header) || header.value.length > maximumTimingHeaderLength) return [];
  return header.value
    .split(",")
    .slice(0, timingNames.length)
    .flatMap((field) => {
      const match = /^\s*([a-z0-9-]+);dur=([0-9]+(?:\.[0-9]+)?)\s*$/u.exec(field);
      if (match === null) return [];
      const name = decodeTimingName(match[1]);
      const duration = decodeDuration(Number(match[2]));
      return Option.isSome(name) && Option.isSome(duration)
        ? [{ name: name.value, durationMs: duration.value }]
        : [];
    });
};
const recoveryBatchCount = (header: Option.Option<string>): Option.Option<number> =>
  Option.flatMap(header, (value) =>
    /^[0-9]{1,4}$/u.test(value) ? decodeBatchCount(Number(value)) : Option.none()
  );
type Sample = {
  journey: string;
  elapsedMs: number;
  outcome: string;
  requests: Array<{
    path: string;
    status: number;
    durationMs: number;
    startOffsetMs: number;
    endOffsetMs: number;
    bytes: number;
    serverTimings: Array<{ name: TimingName; durationMs: number }>;
    recoveryBatches: Array<{ scope: "core" | "dashboard"; count: number }>;
  }>;
  loadingObservations: number;
  longTasks: number[];
  resourceCount: number;
  resourceBytes: number;
  transferredBytes: number;
  resources: Array<{
    path: string;
    initiator: string;
    start: number;
    responseStart: number;
    end: number;
    encodedBytes: number;
    decodedBytes: number;
    transferredBytes: number;
  }>;
  nativeControlReadyMs: number;
  nativeContentDomMs: number;
  nativeContentReadyMs: number;
  nativeInteractionStartMs: number;
  nativeInteractionReadyMs: number;
  navigationStartOffsetMs: number;
  navigation: {
    responseStart: number;
    responseEnd: number;
    domInteractive: number;
    domContentLoaded: number;
  };
  domNodes: number;
};
type Measure = (
  journey: string,
  action: () => Promise<unknown>,
  ready: () => Promise<unknown>
) => Effect.Effect<void, Cause.UnknownError | Cause.TimeoutError>;
type Journey = { page: Page; measure: Measure; samples: Sample[] };
const pause = (milliseconds: number): Promise<void> =>
  Effect.runPromise(Effect.sleep(milliseconds));
const observeResponseHeaders = (
  response: Response,
  entry: Sample["requests"][number]
): Promise<void> =>
  Promise.all([
    response.headerValue("server-timing"),
    response.headerValue("fidy-recovery-batches"),
    response.headerValue("fidy-dashboard-recovery-batches"),
  ]).then(([timings, recovery, dashboardRecovery]) => {
    entry.serverTimings = serverTimings(Option.fromNullishOr(timings));
    entry.recoveryBatches = [
      ...Option.toArray(
        Option.map(recoveryBatchCount(Option.fromNullishOr(recovery)), (count) => ({
          scope: "core" as const,
          count,
        }))
      ),
      ...Option.toArray(
        Option.map(recoveryBatchCount(Option.fromNullishOr(dashboardRecovery)), (count) => ({
          scope: "dashboard" as const,
          count,
        }))
      ),
    ];
  });
const completeRequestObservation = (
  response: Response,
  entry: Sample["requests"][number],
  requestOrigin: number
): Promise<void> => {
  const timing = response.request().timing();
  entry.durationMs = timing.responseEnd;
  entry.startOffsetMs = timing.startTime - requestOrigin;
  entry.endOffsetMs = entry.startOffsetMs + timing.responseEnd;
  return response
    .request()
    .sizes()
    .then((sizes) => {
      entry.bytes = sizes.responseBodySize;
    });
};
const observeRequests = (
  page: Page
): {
  requests: Sample["requests"];
  pending: Set<Promise<void>>;
  start: (epochMilliseconds: number) => void;
} => {
  const requests: Sample["requests"] = [];
  const pending = new Set<Promise<void>>();
  let startedAt = 0;
  page.on("response", (response) => {
    if (!response.url().startsWith(`${apiOrigin}/`)) return;
    if (requests.length >= maximumObservedRequests) return;
    const requestOrigin = startedAt;
    const entry: Sample["requests"][number] = {
      path: new URL(response.url()).pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gu, ":id"),
      status: response.status(),
      durationMs: -1,
      startOffsetMs: response.request().timing().startTime - requestOrigin,
      endOffsetMs: -1,
      bytes: -1,
      serverTimings: [],
      recoveryBatches: [],
    };
    requests.push(entry);
    const work = Promise.all([
      observeResponseHeaders(response, entry),
      response.finished().then(() => completeRequestObservation(response, entry, requestOrigin)),
    ])
      .then(() => undefined)
      .catch(() => undefined);
    pending.add(work);
    work.finally(() => pending.delete(work)).catch(() => undefined);
  });
  return {
    requests,
    pending,
    start: (epochMilliseconds) => {
      startedAt = epochMilliseconds;
      requests.length = 0;
    },
  };
};
const hasVisibleLoading = (elements: Element[]): boolean =>
  elements.some((element) => element.closest(".sr-only") === null);
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
    const visuallyLoading = yield* Effect.tryPromise(() => loading.evaluateAll(hasVisibleLoading));
    if (visuallyLoading) progress.observations++;
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
const browserResourceMetrics = (
  page: Page
): Promise<Pick<Sample, "resourceCount" | "resourceBytes" | "transferredBytes" | "resources">> =>
  page.evaluate(() => {
    const entries = performance
      .getEntriesByType("resource")
      .filter((entry) => entry instanceof PerformanceResourceTiming);
    return {
      resourceCount: entries.length,
      resourceBytes: entries.reduce((sum, entry) => sum + entry.encodedBodySize, 0),
      transferredBytes: entries.reduce((sum, entry) => sum + entry.transferSize, 0),
      resources: entries.map((entry) => ({
        path: new URL(entry.name).pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gu, ":id"),
        initiator: entry.initiatorType,
        start: entry.startTime,
        responseStart: entry.responseStart,
        end: entry.responseEnd,
        encodedBytes: entry.encodedBodySize,
        decodedBytes: entry.decodedBodySize,
        transferredBytes: entry.transferSize,
      })),
    };
  });
const browserMetrics = (
  page: Page,
  actionEpoch: number
): Promise<
  Pick<
    Sample,
    | "longTasks"
    | "resourceCount"
    | "resourceBytes"
    | "transferredBytes"
    | "resources"
    | "nativeControlReadyMs"
    | "nativeContentDomMs"
    | "nativeContentReadyMs"
    | "nativeInteractionStartMs"
    | "nativeInteractionReadyMs"
    | "navigationStartOffsetMs"
    | "navigation"
    | "domNodes"
  >
> =>
  Promise.all([
    page.evaluate((actionEpoch) => {
      const mark = (name: string): number => performance.getEntriesByName(name)[0]?.startTime ?? -1;
      const tasks = performance
        .getEntriesByName("assessment-longtask")
        .filter((entry) => entry instanceof PerformanceMark);
      const navigation = performance
        .getEntriesByType("navigation")
        .find((entry) => entry instanceof PerformanceNavigationTiming);
      const timing = navigation ?? {
        responseStart: -1,
        responseEnd: -1,
        domInteractive: -1,
        domContentLoadedEventEnd: -1,
      };
      return {
        navigationStartOffsetMs: performance.timeOrigin - actionEpoch,
        nativeControlReadyMs: mark("assessment-control-ready"),
        nativeContentDomMs: mark("assessment-content-dom"),
        nativeContentReadyMs: mark("assessment-content-ready"),
        nativeInteractionStartMs: mark("assessment-interaction-start"),
        nativeInteractionReadyMs: mark("assessment-interaction-ready"),
        navigation: {
          responseStart: timing.responseStart,
          responseEnd: timing.responseEnd,
          domInteractive: timing.domInteractive,
          domContentLoaded: timing.domContentLoadedEventEnd,
        },
        longTasks: tasks.map((entry) => Number(entry.detail)),
        domNodes: document.querySelectorAll("*").length,
      };
    }, actionEpoch),
    browserResourceMetrics(page),
  ]).then(([document, resources]) => ({ ...document, ...resources }));
const measureAction = Effect.fn(function* ({
  page,
  action,
  ready,
  waitForPaint,
}: Readonly<{
  page: Page;
  action: () => Promise<unknown>;
  ready: () => Promise<unknown>;
  waitForPaint: boolean;
}>) {
  yield* Effect.tryPromise(action);
  const loadingObservations = yield* waitForReady(page, ready);
  if (waitForPaint) yield* Effect.tryPromise(() => page.evaluate(paintOpportunity));
  return { outcome: "ready", loadingObservations };
});
const immediateColdJourneys = new Set([
  "transactions:isolated-cold-document",
  "transactions:cold-open-capture",
]);
const makeMeasure = (page: Page, samples: Sample[], profile: string): Measure => {
  const { requests, pending, start: startRequests } = observeRequests(page);
  return Effect.fn(function* (journey, action, ready) {
    yield* Effect.tryPromise(() =>
      page.evaluate(() => {
        performance.clearMarks("assessment-longtask");
        performance.clearResourceTimings();
      })
    ).pipe(Effect.timeout("5 seconds"));
    const actionEpoch = yield* Clock.currentTimeMillis;
    startRequests(actionEpoch);
    const start = performance.now();
    const result = yield* measureAction({
      page,
      action,
      ready,
      waitForPaint: !journey.includes(":fresh-in-app-"),
    }).pipe(
      Effect.timeout(journey.includes(":fresh-in-app-") ? "30 seconds" : "70 seconds"),
      Effect.match({
        onSuccess: (value) => value,
        onFailure: () => ({ outcome: "unavailable-or-timeout", loadingObservations: -1 }),
      })
    );
    const elapsedMs = performance.now() - start;
    if (!coldInteractions || !immediateColdJourneys.has(journey)) {
      yield* Effect.tryPromise(() => Promise.race([Promise.all(pending), pause(resourceDeadline)]));
    }
    const metrics = yield* Effect.tryPromise(() => browserMetrics(page, actionEpoch)).pipe(
      Effect.timeout("5 seconds")
    );
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
    return Promise.all([
      expect(page.getByLabel("Valor", { exact: true })).toBeVisible({ timeout }),
      expect(page.locator('[data-review="original-body"] pre')).toBeVisible({ timeout }),
    ]).then(() => undefined);
  }
  if (route.name === "upgrade") {
    return expect(page.getByRole("button", { name: /^mensual\b/iu })).toBeEnabled({ timeout });
  }
  if (route.name === "account") {
    return expect(page.getByLabel("Nuevo correo", { exact: true })).toBeVisible({ timeout });
  }
  if (route.name === "access") {
    return Promise.all([
      expect(page.getByText("No tienes tokens activos.", { exact: true })).toBeVisible({ timeout }),
      expect(page.getByText("No hay conexiones en esta página.", { exact: true })).toBeVisible({
        timeout,
      }),
    ]).then(() => undefined);
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
const freshReadPaths = new Map([
  ["dashboard", "/dashboard/view"],
  ["transactions", "/transactions"],
  ["budgets", "/budget-status"],
  ["recurring", "/recurring-plans"],
  ["review", "/ingestion/review-workspace"],
]);
const freshReadButtons = new Map([["review", "Actualizar"]]);
const successfulReadStatus = 200;
const waitForResourceCompletion = (page: Page, url: string): Promise<void> =>
  page
    .waitForFunction(
      (selected) =>
        performance
          .getEntriesByType("resource")
          .some(
            (entry) =>
              entry instanceof PerformanceResourceTiming &&
              entry.name === selected &&
              entry.responseEnd > 0
          ),
      url,
      { timeout: readinessTimeout, polling: sampleInterval }
    )
    .then((handle) => handle.dispose());
const measureFreshRead = Effect.fn(function* (journey: Journey, route: Workspace) {
  const { page, measure } = journey;
  const path = freshReadPaths.get(route.name);
  if (path === undefined) throw new Error("Unsupported fresh-read workspace");
  const observed = page
    .waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.origin === apiOrigin &&
          url.pathname === path &&
          response.request().method() === "GET" &&
          url.searchParams.get("limit") !== "0"
        );
      },
      { timeout: readinessTimeout }
    )
    .then((response) => {
      process.stdout.write(`ASSESSMENT_READ ${route.name} response\n`);
      expect(response.status()).toBe(successfulReadStatus);
      if (inAppHeadersOnly) return;
      return waitForResourceCompletion(page, response.url())
        .then(() => {
          process.stdout.write(`ASSESSMENT_READ ${route.name} resource\n`);
        })
        .then(() => readyWorkspace(page, route))
        .then(() => {
          process.stdout.write(`ASSESSMENT_READ ${route.name} controls\n`);
        });
    });
  const completed = Promise.race([
    observed,
    pause(readinessTimeout).then(() => {
      throw new Error("Fresh read completion timed out.");
    }),
  ]);
  completed.catch(() => undefined);
  const button = page.getByRole("button", {
    name: freshReadButtons.get(route.name) ?? "Mes anterior",
    exact: true,
  });
  yield* measure(
    `${route.name}:fresh-in-app-${inAppHeadersOnly ? "headers" : "read"}`,
    () => {
      process.stdout.write(`ASSESSMENT_READ ${route.name} trigger\n`);
      if (route.name === "dashboard") {
        return page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
      }
      return button.click({ timeout: actionTimeout });
    },
    () => completed
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
const installWorkspaceReadiness = (): void => {
  const button = new Map([
    ["/app/transactions", /^\+ Registrar$/u],
    ["/app/budgets", /^Mes anterior$/u],
    ["/app/recurring", /^Nuevo recurrente$/u],
    ["/app/dashboard", /^Personalizar$/u],
    ["/upgrade", /^mensual\b/iu],
  ]).get(location.pathname);
  const label = new Map([
    ["/app/needs-review", "Valor"],
    ["/settings/account", "Nuevo correo"],
    ["/settings/privacy", "Tu autorización está vigente."],
  ]).get(location.pathname);
  const visible = (element: Element): boolean => element.getClientRects().length > 0;
  const ready = (): boolean => {
    if (location.pathname === "/app/needs-review") {
      const original = document.querySelector('[data-review="original-body"] pre');
      if (original === null || !visible(original)) return false;
    }
    if (button !== undefined) {
      return Array.from(document.querySelectorAll("button")).some(
        (control) =>
          button.test(control.getAttribute("aria-label") ?? control.textContent.trim()) &&
          !control.matches(":disabled,[aria-disabled='true']") &&
          visible(control)
      );
    }
    if (label !== undefined) {
      const direct = Array.from(document.querySelectorAll("[aria-label]")).find(
        (element) => element.getAttribute("aria-label") === label && visible(element)
      );
      return (
        direct !== undefined ||
        Array.from(document.querySelectorAll("label")).some(
          (element) =>
            element.textContent.trim() === label &&
            element.control !== null &&
            visible(element.control)
        )
      );
    }
    return (
      location.pathname === "/settings/access" &&
      Array.from(document.querySelectorAll('[data-slot="empty-title"]')).some(
        (element) => element.textContent.trim() === "No tienes tokens activos." && visible(element)
      )
    );
  };
  const observer = new MutationObserver(() => {
    if (!ready()) return;
    observer.disconnect();
    requestAnimationFrame(() => performance.mark("assessment-control-ready"));
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true });
};
const installContentReadiness = (): void => {
  const observationDeadlineMs = 60_000;
  const selector = new Map([
    ["/app/transactions", '[aria-label="Tabla de transacciones"] tbody tr'],
    ["/app/budgets", '[aria-label^="Resumen "]'],
    ["/app/recurring", '[aria-label="Resumen mensual"]'],
    ["/app/dashboard", '[aria-label="Resumen COP"] dd'],
    ["/app/needs-review", '[data-review="original-body"] pre'],
    ["/settings/account", 'input[type="email"]'],
    ["/settings/privacy", '[aria-label="Tu autorización está vigente."]'],
    ["/settings/access", '[data-slot="empty-title"]'],
  ]).get(location.pathname);
  const visible = (element: Element): boolean => element.getClientRects().length > 0;
  const hasVisible = (query: string): boolean =>
    Array.from(document.querySelectorAll(query)).some(visible);
  const contentReady = (): boolean =>
    selector !== undefined
      ? hasVisible(selector)
      : location.pathname === "/upgrade" &&
        Array.from(document.querySelectorAll("button")).some(
          (element) => /^mensual\b/iu.test(element.textContent.trim()) && visible(element)
        );
  const observer = new MutationObserver(() => {
    if (!contentReady()) return;
    observer.disconnect();
    performance.mark("assessment-content-dom");
    requestAnimationFrame(() =>
      requestAnimationFrame(() => performance.mark("assessment-content-ready"))
    );
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true });
  const observeCapture = (): void => {
    if (hasVisible('form[aria-label="Registrar transacción"]')) {
      performance.mark("assessment-interaction-ready");
    } else if (performance.now() < observationDeadlineMs) requestAnimationFrame(observeCapture);
  };
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const control = event.target.closest("button");
    if (
      location.pathname === "/app/transactions" &&
      control?.textContent.trim() === "+ Registrar" &&
      performance.getEntriesByName("assessment-interaction-start").length === 0
    ) {
      performance.mark("assessment-interaction-start");
      requestAnimationFrame(observeCapture);
    }
  });
  setTimeout(() => observer.disconnect(), observationDeadlineMs);
};
const installBrowserObservers = (): void => {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      performance.mark("assessment-longtask", {
        startTime: entry.startTime,
        detail: entry.duration,
      });
    }
  }).observe({ type: "longtask", buffered: true });
};
const prepareBrowser = Effect.fn(function* (page: Page, cdp: CDPSession) {
  page.setDefaultTimeout(actionTimeout);
  yield* Effect.tryPromise(() => page.addInitScript(installBrowserObservers));
  yield* Effect.tryPromise(() => page.addInitScript(installWorkspaceReadiness));
  yield* Effect.tryPromise(() => page.addInitScript(installContentReadiness));
  yield* Effect.tryPromise(() => cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }));
  if (networkProfile === "poor") {
    yield* Effect.tryPromise(() => cdp.send("Network.enable"));
    yield* Effect.tryPromise(() => cdp.send("Network.emulateNetworkConditions", poorConnection));
  }
  yield* Effect.tryPromise(() => page.setViewportSize({ width: 1280, height: 720 }));
});
const measureColdInteractions = Effect.fn(function* (
  { page, measure, samples }: Journey,
  route: Workspace
) {
  if (!coldInteractions || route.name !== "transactions" || samples.at(-1)?.outcome !== "ready") {
    return;
  }
  const form = page.getByRole("form", { name: "Registrar transacción", exact: true });
  yield* measure(
    "transactions:cold-open-capture",
    () => page.getByRole("button", { name: "+ Registrar", exact: true }).click(),
    () => expect(form).toBeVisible()
  );
  if (samples.at(-1)?.outcome === "ready") {
    yield* measure(
      "transactions:cold-open-calendar",
      () => form.getByRole("button", { name: /^Fecha:/u }).click(),
      () =>
        expect(page.getByRole("dialog", { name: "Seleccionar fecha", exact: true })).toBeVisible()
    );
  }
});
for (const profile of ["desktop"] as const) {
  test(`measures the first date picker on ${profile}`, ({ page, request, context }) => {
    const samples: Sample[] = [];
    return Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          signInNavigationPerformanceThroughCore({ page, request, identity: "navigationDashboard" })
        );
        yield* Effect.tryPromise(() => readyWorkspace(page, routes[0]));
        const cdp = yield* Effect.tryPromise(() => context.newCDPSession(page));
        yield* prepareBrowser(page, cdp);
        yield* makeMeasure(page, samples, profile)(
          "transactions:first-date-picker",
          () => page.getByRole("button", { name: "Fecha", exact: true }).click(),
          () => expect(page.getByRole("grid")).toBeVisible()
        );
        yield* Effect.tryPromise(() =>
          test.info().attach("assessment-samples", {
            body: json({
              dataset,
              networkProfile,
              previewCompression,
              profile,
              browser: context.browser()?.version(),
              samples,
            }),
            contentType: "application/json",
          })
        );
      })
    );
  });
}
for (const profile of ["desktop"] as const) {
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
        yield* prepareBrowser(page, cdp);
        const journey = { page, samples, measure: makeMeasure(page, samples, profile) };
        for (const route of routes) {
          yield* visitWorkspace(journey, route, cdp);
        }
      }).pipe(
        Effect.ensuring(
          Effect.tryPromise(() =>
            test.info().attach("assessment-samples", {
              body: json({
                dataset,
                networkProfile,
                previewCompression,
                nativeReadiness: "all-workspaces",
                coldInteractions,
                profile,
                browser: context.browser()?.version(),
                samples,
              }),
              contentType: "application/json",
            })
          ).pipe(Effect.orDie)
        )
      )
    );
  });
}

for (const profile of ["desktop"] as const) {
  test(`assesses isolated cold documents on ${profile}`, ({ page, request, context }) => {
    const samples: Sample[] = [];
    return Effect.runPromise(
      Effect.gen(function* () {
        const cdp = yield* Effect.tryPromise(() => context.newCDPSession(page));
        yield* Effect.tryPromise(() =>
          signInNavigationPerformanceThroughCore({
            page,
            request,
            identity: "navigationDashboard",
          })
        );
        yield* prepareBrowser(page, cdp);
        const measure = makeMeasure(page, samples, profile);
        const coldRoutes = routes.filter(
          (route) => coldWorkspaces.length === 0 || coldWorkspaces.includes(route.name)
        );
        if (coldRoutes.length === 0) throw new Error("Unknown cold workspace");
        for (const route of Array.from({ length: coldRepeats }, () => coldRoutes).flat()) {
          // Stop the previous document and let the unchanged ten-request allowance refill.
          // This setup is excluded from latency; the rapid navigation suite measures contention.
          yield* Effect.tryPromise(() => page.goto("about:blank"));
          yield* Effect.sleep("12 seconds");
          yield* Effect.tryPromise(() => cdp.send("Network.clearBrowserCache"));
          yield* measure(
            `${route.name}:isolated-cold-document`,
            () =>
              page.goto(route.path, { waitUntil: "domcontentloaded", timeout: navigationTimeout }),
            () => readyWorkspace(page, route)
          );
          yield* measureColdInteractions({ page, measure, samples }, route);
        }
      }).pipe(
        Effect.ensuring(
          Effect.tryPromise(() =>
            test.info().attach("assessment-samples", {
              body: json({
                dataset,
                networkProfile,
                networkEmulation: networkProfile === "poor" ? poorConnection : "unthrottled",
                previewCompression,
                nativeReadiness: "all-workspaces",
                coldInteractions,
                profile,
                browser: context.browser()?.version(),
                samples,
              }),
              contentType: "application/json",
            })
          ).pipe(Effect.orDie)
        )
      )
    );
  });
}

const prepareFreshWorkspace = Effect.fn(function* (page: Page, cdp: CDPSession, route: Workspace) {
  process.stdout.write(`ASSESSMENT_SETUP ${route.name} network\n`);
  yield* Effect.tryPromise(() => cdp.send("Network.enable")).pipe(Effect.timeout("10 seconds"));
  yield* Effect.tryPromise(() =>
    cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })
  ).pipe(Effect.timeout("10 seconds"));
  process.stdout.write(`ASSESSMENT_SETUP ${route.name} document\n`);
  yield* Effect.tryPromise(() => page.goto(route.path, { timeout: navigationTimeout }));
  process.stdout.write(`ASSESSMENT_SETUP ${route.name} readiness\n`);
  yield* Effect.tryPromise(() => readyWorkspace(page, route));
  process.stdout.write(`ASSESSMENT_SETUP ${route.name} idle\n`);
  yield* Effect.tryPromise(() =>
    page.waitForLoadState("networkidle", { timeout: readinessTimeout })
  );
});

for (const route of routes.filter(
  (route) =>
    freshReadPaths.has(route.name) &&
    (coldWorkspaces.length === 0 || coldWorkspaces.includes(route.name))
)) {
  test(`assesses read-only in-app queries with destination code loaded: ${route.name}`, ({
    page,
    request,
    context,
  }) => {
    const samples: Sample[] = [];
    return Effect.runPromise(
      Effect.gen(function* () {
        const cdp = yield* Effect.tryPromise(() => context.newCDPSession(page));
        yield* Effect.tryPromise(() =>
          signInNavigationPerformanceThroughCore({
            page,
            request,
            identity: "navigationDashboard",
          })
        );
        yield* prepareBrowser(page, cdp);
        const journey = { page, measure: makeMeasure(page, samples, "desktop"), samples };
        yield* prepareFreshWorkspace(page, cdp, route);
        for (const _ of Array.from({ length: coldRepeats })) {
          yield* Effect.sleep("12 seconds");
          if (networkProfile === "poor") {
            yield* Effect.tryPromise(() =>
              cdp.send("Network.emulateNetworkConditions", poorConnection)
            );
          }
          yield* measureFreshRead(journey, route);
          if (samples.at(-1)?.outcome !== "ready") break;
        }
      }).pipe(
        Effect.ensuring(
          Effect.tryPromise(() =>
            test.info().attach("assessment-samples", {
              body: json({
                dataset,
                networkProfile,
                networkEmulation: networkProfile === "poor" ? poorConnection : "unthrottled",
                previewCompression,
                nativeReadiness: inAppHeadersOnly
                  ? "response-headers"
                  : "browser-resource-completion-and-controls",
                setupNetwork: "unthrottled",
                profile: "desktop",
                browser: context.browser()?.version(),
                samples,
              }),
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
            `${apiOrigin}/recurring-plans?month=2026-10${view === "compact" ? "&view=compact" : ""}`
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

test("measures navigation count payload without review rows", ({ page, request, context }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInNavigationPerformanceThroughCore({ page, request, identity: "navigationDashboard" })
      );
      yield* Effect.sleep("2 seconds");
      const api = boundSessionRequests(context.request);
      const fullPage = 50;
      const successStatus = 200;
      const measurements: Array<{
        limit: number;
        bytes: number;
        pendingCount: number;
        items: number;
      }> = [];
      const body = Schema.Struct({
        data: Schema.Struct({ pendingCount: Schema.Int, items: Schema.Array(Schema.Unknown) }),
      });
      for (const limit of [fullPage, 0]) {
        const response = yield* Effect.tryPromise(() =>
          api.get(`${apiOrigin}/ingestion/review-workspace?status=pending&limit=${limit}`)
        );
        expect(response.status()).toBe(successStatus);
        const bytes = yield* Effect.tryPromise(() => response.body());
        const decoded = yield* Schema.decodeUnknownEffect(body)(
          yield* Effect.tryPromise(() => response.json())
        );
        expect(decoded.data.items).toHaveLength(Math.min(limit, decoded.data.pendingCount));
        measurements.push({
          limit,
          bytes: bytes.length,
          pendingCount: decoded.data.pendingCount,
          items: decoded.data.items.length,
        });
      }
      expect(measurements[0]?.pendingCount).toBe(measurements[1]?.pendingCount);
      yield* Effect.tryPromise(() =>
        test.info().attach("review-count-response-size", {
          body: json({ dataset, measurements }),
          contentType: "application/json",
        })
      );
    })
  ));
