import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";
import type { CDPSession, Page, Response } from "@playwright/test";
import { Config, Effect, Option, Schema } from "effect";
import { playwright } from "./playwright-runtime";
import { prepareAssessmentFixture } from "./assessment-fixture";
import { signInNavigationPerformanceThroughCore } from "./real-core-fixture";
import {
  type DashboardObservation,
  type DashboardOutcome,
  calibrateDashboardClock,
  installDashboardMeasurement,
  installDashboardNavigationMeasurement,
  summarizeDashboardSamples,
} from "./dashboard-measurement";

const { test, expect } = playwright;
const { api: apiOrigin, app: appOrigin } = browserAcceptanceTopology();
const defaultRepetitions = 20;
const maximumRepetitions = 1000;
const repetitions = Effect.runSync(
  Config.Int("FIDY_DASHBOARD_SAMPLES").pipe(Config.withDefault(defaultRepetitions))
);
if (repetitions < 1 || repetitions > maximumRepetitions) {
  throw new Error("Dashboard samples must be 1–1000");
}
const dataset = Effect.runSync(Config.String("FIDY_ASSESSMENT").pipe(Config.withDefault("small")));
const network = Schema.decodeUnknownSync(Schema.Literals(["normal", "poor"]))(
  Effect.runSync(Config.String("FIDY_ASSESSMENT_NETWORK").pipe(Config.withDefault("normal")))
);
const refusalStatus = 400;
const successfulStatus = 200;
const actionTimeoutMs = 10_000;
const navigationTimeoutMs = 45_000;
const readinessTimeoutMs = 20_000;
const paceMs = 12_000;
const mobileCpuRate = 4;
const poorConnection = {
  offline: false,
  latency: 400,
  downloadThroughput: 51_200,
  uploadThroughput: 25_600,
};
const setupAllowanceMs = 60_000;
test.setTimeout(
  repetitions * 2 * (readinessTimeoutMs + paceMs + navigationTimeoutMs + actionTimeoutMs) +
    setupAllowanceMs
);
const revision = Effect.runSync(
  Config.String("FIDY_ASSESSMENT_REVISION").pipe(Config.withDefault("not-supplied"))
);
const sizes = { small: 500, heavy: 10_000, extreme: 100_000, breaking: 1_000_000 };
const fixture = Schema.decodeUnknownSync(
  Schema.Literals(["small", "heavy", "extreme", "breaking"])
)(dataset);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const paint = Schema.Struct({
  durationMs: Schema.Finite,
  observerWorkMs: Schema.Finite,
  confirmationOverheadMs: Schema.Finite,
});
type Profile = "desktop" | "mobile";
type Journey = "direct" | "return";
type RequestObservation = {
  kind: "view" | "document" | "catalog" | "other";
  status: number;
  phases: string;
  responseBytes: number;
  requestDurationMs: number;
  reportedRecoveryBatches: number;
};
type Sample = DashboardObservation &
  Readonly<{
    journey: Journey;
    requests: RequestObservation[];
    browserTiming:
      | Readonly<{ status: "unavailable" }>
      | Readonly<{ status: "available"; value: typeof paint.Type }>;
  }>;
const measuredPaint = (page: Page): Promise<typeof paint.Type> =>
  page
    .evaluate((): unknown => {
      const entry = performance.getEntriesByName("dashboard-fresh-paint").at(-1);
      return entry instanceof PerformanceMark ? entry.detail : undefined;
    })
    .then(Schema.decodeUnknownSync(paint));
const decodeRecoveryBatches = Schema.decodeUnknownOption(
  Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
);
const requestKind = (response: Response): RequestObservation["kind"] => {
  const path = new URL(response.url()).pathname;
  if (path === "/dashboard/view") return "view";
  if (path === "/app/dashboard" && response.request().isNavigationRequest()) return "document";
  if (path === "/dashboard/catalog") return "catalog";
  return "other";
};
const financialStatus = (response: Response): number =>
  Number(response.headers()["fidy-dashboard-status"] ?? response.status());
const observeRequests = (page: Page): RequestObservation[] => {
  const requests: RequestObservation[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== apiOrigin && url.origin !== appOrigin) return;
    const kind = requestKind(response);
    const entry = {
      kind,
      status: financialStatus(response),
      phases: response.headers()["server-timing"] ?? "",
      reportedRecoveryBatches: Option.getOrElse(
        decodeRecoveryBatches(response.headers()["fidy-recovery-batches"]),
        () => -1
      ),
      responseBytes: -1,
      requestDurationMs: -1,
    };
    requests.push(entry);
    response
      .finished()
      .then(() => response.request().sizes())
      .then((sizes) => {
        entry.responseBytes = sizes.responseBodySize;
        entry.requestDurationMs = response.request().timing().responseEnd;
      })
      .catch(() => undefined);
  });
  return requests;
};
const prepareProfile = Effect.fnUntraced(function* (page: Page, cdp: CDPSession, profile: Profile) {
  page.setDefaultTimeout(actionTimeoutMs);
  page.setDefaultNavigationTimeout(navigationTimeoutMs);
  yield* Effect.tryPromise(() =>
    cdp.send("Emulation.setCPUThrottlingRate", { rate: profile === "desktop" ? 1 : mobileCpuRate })
  );
  yield* Effect.tryPromise(() =>
    page.setViewportSize(
      profile === "desktop" ? { width: 1280, height: 720 } : { width: 390, height: 844 }
    )
  );
  if (network === "poor") {
    yield* Effect.tryPromise(() => cdp.send("Network.enable"));
    yield* Effect.tryPromise(() => cdp.send("Network.emulateNetworkConditions", poorConnection));
  }
  yield* Effect.tryPromise(() => page.addInitScript(installDashboardMeasurement));
  yield* Effect.tryPromise(() => page.addInitScript(installDashboardNavigationMeasurement));
});
const navigateLink = Effect.fnUntraced(function* (page: Page, name: string) {
  const link = page.getByRole("link", { name, exact: true });
  if (!(yield* Effect.tryPromise(() => link.isVisible()))) {
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Menú de navegación", exact: true }).click()
    );
  }
  yield* Effect.tryPromise(() => link.click());
});
const navigateDashboard = Effect.fnUntraced(function* (
  page: Page,
  cdp: CDPSession,
  journey: Journey
) {
  if (journey === "direct") {
    yield* Effect.tryPromise(() => page.goto("about:blank"));
    yield* Effect.tryPromise(() => cdp.send("Network.clearBrowserCache"));
    yield* Effect.tryPromise(() => page.goto("/app/dashboard", { waitUntil: "domcontentloaded" }));
  } else {
    yield* navigateLink(page, "Transacciones");
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeEnabled()
    );
    yield* navigateLink(page, "Tablero");
  }
  yield* Effect.tryPromise(() =>
    page.waitForFunction(
      () => performance.getEntriesByName("dashboard-fresh-paint").length > 0,
      undefined,
      { timeout: readinessTimeoutMs }
    )
  );
  return yield* Effect.tryPromise(() => measuredPaint(page));
});
const failedOutcome = (requests: ReadonlyArray<RequestObservation>): DashboardOutcome => {
  if (requests.some((entry) => entry.status >= refusalStatus)) return "refused";
  if (requests.some((entry) => entry.kind === "view" || entry.kind === "document")) {
    return "timeout";
  }
  return "no-fresh-read";
};
const dashboardMeasurementDiagnostics = (): unknown => ({
  marks: performance
    .getEntriesByType("mark")
    .map((entry) => ({ name: entry.name, at: entry.startTime })),
  reads: performance
    .getEntriesByType("resource")
    .filter((entry) => new URL(entry.name).pathname === "/dashboard/view")
    .map((entry): unknown => entry.toJSON()),
  pending: document.querySelector('[data-dashboard-read-state="pending"]') !== null,
  ready: document.querySelector('[data-dashboard-read-state="ready"]') !== null,
});
const runCohort = Effect.fnUntraced(function* (page: Page, cdp: CDPSession, samples: Sample[]) {
  const requests = observeRequests(page);
  for (let index = 0; index < repetitions; index++) {
    for (const journey of ["direct", "return"] as const) {
      requests.length = 0;
      process.stdout.write(`DASHBOARD_SAMPLE_START ${journey} ${index}\n`);
      const outcome = yield* navigateDashboard(page, cdp, journey).pipe(Effect.result);
      if (
        outcome._tag === "Success" &&
        requests.some(
          (entry) =>
            (entry.kind === "view" || entry.kind === "document") &&
            entry.status === successfulStatus
        )
      ) {
        samples.push({
          journey,
          outcome: "ready",
          durationMs: outcome.success.durationMs,
          browserTiming: { status: "available", value: outcome.success },
          requests: requests.slice(),
        });
      } else {
        const diagnostics = yield* Effect.tryPromise(() =>
          page.evaluate(dashboardMeasurementDiagnostics)
        );
        process.stdout.write(`DASHBOARD_MEASUREMENT_FAILURE ${encode(diagnostics)}\n`);
        samples.push({
          journey,
          outcome: failedOutcome(requests),
          durationMs: readinessTimeoutMs,
          browserTiming: { status: "unavailable" },
          requests: requests.slice(),
        });
      }
      process.stdout.write(`DASHBOARD_SAMPLE_END ${journey} ${index} ${samples.at(-1)?.outcome}\n`);
      yield* Effect.sleep(paceMs);
    }
  }
});
const attachCohort = Effect.fnUntraced(function* (
  page: Page,
  samples: Sample[],
  context: Readonly<{ profile: Profile; browser: string }>
) {
  const { profile, browser } = context;
  const clock = yield* Effect.tryPromise(() => page.evaluate(calibrateDashboardClock));
  yield* Effect.tryPromise(() =>
    test.info().attach("dashboard-baseline", {
      body: encode({
        dataset,
        revision,
        transactions: sizes[fixture],
        profile,
        network,
        browser,
        clock,
        users: 1,
        pacedIntervalMs: paceMs,
        cpuRate: profile === "desktop" ? 1 : mobileCpuRate,
        readiness:
          "completed private 200 document or fresh 200 view read, pending-to-ready commit on return; first eligible frame timestamp with following-frame confirmation",
        databaseRoundTrips:
          "unavailable in browser transport; native Dashboard integration separately measures them",
        recoveryChecks:
          "unavailable in browser transport; native Dashboard integration separately measures them",
        samples,
        direct: summarizeDashboardSamples(samples.filter((sample) => sample.journey === "direct")),
        return: summarizeDashboardSamples(samples.filter((sample) => sample.journey === "return")),
      }),
      contentType: "application/json",
    })
  );
});

test.beforeAll(prepareAssessmentFixture);
for (const profile of ["desktop", "mobile"] as const) {
  test(`measures fresh Dashboard direct entry and return on ${profile}`, ({
    page,
    request,
    context,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        process.stdout.write("DASHBOARD_AUTH_START\n");
        yield* Effect.tryPromise(() =>
          signInNavigationPerformanceThroughCore({ page, request, identity: "navigationDashboard" })
        );
        process.stdout.write("DASHBOARD_AUTHENTICATED\n");
        const cdp = yield* Effect.tryPromise(() => context.newCDPSession(page));
        yield* prepareProfile(page, cdp, profile);
        yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
        yield* Effect.tryPromise(() =>
          expect(
            page
              .getByRole("button", { name: "Crear tablero", exact: true })
              .or(page.getByRole("button", { name: "Personalizar", exact: true }))
          ).toBeVisible()
        );
        if (
          yield* Effect.tryPromise(() =>
            page.getByRole("button", { name: "Crear tablero", exact: true }).isVisible()
          )
        ) {
          yield* Effect.tryPromise(() =>
            page.getByRole("button", { name: "Crear tablero", exact: true }).click()
          );
        }
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("button", { name: "Personalizar", exact: true })).toBeEnabled()
        );
        yield* Effect.sleep(paceMs);
        const samples: Sample[] = [];
        yield* runCohort(page, cdp, samples).pipe(
          Effect.ensuring(
            attachCohort(page, samples, {
              profile,
              browser: context.browser()?.version() ?? "unknown",
            }).pipe(Effect.orDie)
          )
        );
        expect(samples.length).toBe(repetitions * 2);
      })
    ));
}
