import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";
import type { CDPSession, Page, Response } from "@playwright/test";
import { Config, Effect, Option, Schema } from "effect";
import { playwright } from "./playwright-runtime";
import { prepareAssessmentFixture, readPreparedAssessment } from "./assessment-fixture";
import { DashboardAssessmentConfiguration } from "../../server/cloudflare/browser-acceptance/contract";
import { dashboardAssessmentProvenance } from "./dashboard-assessment-provenance";
import {
  type DashboardActor,
  type DashboardAssessmentUser,
  type DashboardIngestionObservation,
  dashboardPacedIntervalMilliseconds,
  prepareDashboardUsers,
  runDashboardIngestion,
} from "./dashboard-assessment-workload";
import {
  type DashboardObservation,
  type DashboardOutcome,
  calibrateDashboardClock,
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
const paceMs = dashboardPacedIntervalMilliseconds;
const mobileCpuRate = 4;
const setupAllowanceMs = 60_000;
test.setTimeout(
  repetitions * 2 * (readinessTimeoutMs + paceMs + navigationTimeoutMs + actionTimeoutMs) +
    setupAllowanceMs
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
  path: string;
  retryAfter: string;
  hostClock: string;
  nativeClock: string;
  kind: "view" | "document" | "catalog" | "other";
  status: number;
  phases: string;
  responseBytes: number;
  requestDurationMs: number;
  reportedRecoveryBatches: number;
  nativeCalls: Readonly<
    Record<
      | "dashboardRpc"
      | "entryRpc"
      | "genericRpc"
      | "r2Get"
      | "r2Head"
      | "r2Put"
      | "r2Delete"
      | "r2List",
      number
    >
  >;
  representation: "financial-html" | "financial-json" | "shell" | "other";
};
type Sample = DashboardObservation &
  Readonly<{
    journey: Journey;
    user: number;
    tab: number;
    attempt: number;
    scheduledAtMs: number;
    offeredAtMs: number;
    elapsedHostMs: number;
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
const responseRepresentation = (
  response: Response,
  kind: RequestObservation["kind"]
): RequestObservation["representation"] => {
  const type = response.headers()["content-type"] ?? "";
  if (kind === "view" && type.startsWith("application/json")) return "financial-json";
  if (kind === "view" && type.startsWith("text/html")) return "financial-html";
  if (kind === "document") {
    return response.headers()["fidy-dashboard-status"] === undefined ? "shell" : "financial-html";
  }
  return "other";
};
const nativeCalls = (response: Response): RequestObservation["nativeCalls"] => {
  const read = (name: string): number =>
    Option.getOrElse(
      decodeRecoveryBatches(response.headers()[`fidy-assessment-${name}`]),
      () => -1
    );
  return {
    dashboardRpc: read("native-rpc"),
    entryRpc: read("entry-rpc"),
    genericRpc: read("generic-rpc"),
    r2Get: read("r2-get"),
    r2Head: read("r2-head"),
    r2Put: read("r2-put"),
    r2Delete: read("r2-delete"),
    r2List: read("r2-list"),
  };
};
const observeRequests = (page: Page): RequestObservation[] => {
  const requests: RequestObservation[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== apiOrigin && url.origin !== appOrigin) return;
    const kind = requestKind(response);
    const entry = {
      kind,
      path: url.pathname,
      retryAfter: response.headers()["retry-after"] ?? "",
      hostClock: response.headers()["fidy-assessment-host-clock"] ?? "",
      nativeClock: response.headers()["fidy-assessment-native-clock"] ?? "",
      representation: responseRepresentation(response, kind),
      status: financialStatus(response),
      nativeCalls: nativeCalls(response),
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
  if (
    requests.some(
      (entry) =>
        (entry.kind === "view" || entry.kind === "document") && entry.status >= refusalStatus
    )
  ) {
    return "refused";
  }
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
const runCohort = Effect.fn(function* (
  actor: DashboardActor,
  samples: Sample[],
  startedAtMs: number
) {
  const { page, cdp } = actor;
  let scheduledAtMs = startedAtMs + actor.offsetMilliseconds;
  yield* Effect.sleep(Math.max(0, scheduledAtMs - performance.now()));
  const requests = observeRequests(page);
  for (let index = 0; index < repetitions; index++) {
    for (const journey of ["direct", "return"] as const) {
      requests.length = 0;
      const offeredAtMs = performance.now();
      const outcome = yield* navigateDashboard(page, cdp, journey).pipe(Effect.result);
      const elapsedHostMs = performance.now() - offeredAtMs;
      const offered = {
        attempt: index,
        user: actor.user,
        tab: actor.tab,
        scheduledAtMs,
        offeredAtMs,
        elapsedHostMs,
      };
      if (
        outcome._tag === "Success" &&
        requests.some(
          (entry) =>
            (entry.kind === "view" || entry.kind === "document") &&
            entry.status === successfulStatus
        )
      ) {
        samples.push({
          ...offered,
          journey,
          outcome: "ready",
          durationMs: outcome.success.durationMs,
          browserTiming: { status: "available", value: outcome.success },
          requests: requests.slice(),
        });
      } else {
        const diagnostics = yield* Effect.tryPromise(() =>
          page.evaluate(dashboardMeasurementDiagnostics)
        ).pipe(Effect.orElseSucceed(() => ({ status: "unavailable" })));
        process.stdout.write(`DASHBOARD_MEASUREMENT_FAILURE ${encode(diagnostics)}\n`);
        samples.push({
          ...offered,
          journey,
          outcome: failedOutcome(requests),
          durationMs: elapsedHostMs,
          browserTiming: { status: "unavailable" },
          requests: requests.slice(),
        });
      }
      scheduledAtMs += paceMs;
      yield* Effect.sleep(Math.max(0, scheduledAtMs - performance.now()));
    }
  }
});
type CohortState = {
  users: ReadonlyArray<DashboardAssessmentUser>;
  samples: Sample[];
  ingestion: DashboardIngestionObservation[];
  setup: "failed" | "ready";
};
type CohortAttachment = Readonly<{
  state: CohortState;
  prepared: Awaited<ReturnType<typeof readPreparedAssessment>>;
  profile: Profile;
  browser: string;
  provenance: Effect.Success<ReturnType<typeof dashboardAssessmentProvenance>>;
}>;
type ActorClock = Readonly<{
  user: number;
  tab: number;
  clock: ReturnType<typeof calibrateDashboardClock>;
}>;
const observedNativeSample = (sample: Sample): boolean => {
  const financial = sample.requests.filter(
    (request) => request.kind === "view" || request.kind === "document"
  );
  const call = financial[0];
  return (
    financial.length === 1 &&
    call?.nativeCalls.dashboardRpc === 1 &&
    call.nativeCalls.genericRpc === 0 &&
    call.nativeCalls.r2Get === 1 &&
    call.nativeCalls.entryRpc === (sample.journey === "direct" ? 1 : 0)
  );
};
const observedNativeCohort = (
  input: Readonly<{ state: CohortState; backend: string }>
): object => ({
  databaseRoundTrips:
    input.backend === "audited-native-guarded"
      ? "actual provider dashboardRpc and genericRpc calls recorded per response; no inferred counts"
      : "unavailable in browser transport; complete native public request measurements required separately",
  recoveryChecks:
    input.backend === "audited-native-guarded"
      ? "actual invocation-local native and Core R2 operations per response; unavailable remains -1"
      : "unavailable in browser transport; native public request measurements required separately",
  fixtureTransport:
    input.backend === "audited-native-guarded"
      ? "full-app elapsed includes loopback private document operator HTTP; Store work uses actual provider RPC"
      : "legacy D1 path",
  nativeCountersObserved:
    input.backend === "audited-native-guarded" && input.state.samples.every(observedNativeSample),
});
const cohortBody = (
  input: CohortAttachment,
  configuration: typeof DashboardAssessmentConfiguration.Encoded,
  clocks: ReadonlyArray<ActorClock>
): string => {
  const { state, profile } = input;
  return encode({
    ...input.provenance,
    dataset,
    transactions: sizes[fixture],
    profile,
    network,
    browser: input.browser,
    clockByActor: clocks,
    configuration,
    backendRequested: configuration.backend,
    epoch: configuration.epoch,
    users: configuration.users,
    tabs: configuration.activity === "quiet" ? 1 : 2,
    ingestion: configuration.activity !== "quiet",
    history: configuration.history,
    layout: configuration.layout,
    setup: state.setup,
    preparedUsers: state.users.length,
    activitySatisfied:
      configuration.activity === "quiet" ||
      state.users.every((user) =>
        state.ingestion.some((sample) => sample.user === user.user && sample.outcome === "created")
      ),
    ingestionSamples: state.ingestion,
    pacedIntervalMs: paceMs,
    cpuRate: profile === "desktop" ? 1 : mobileCpuRate,
    readiness:
      "fresh successful document or fragment; browser-local first eligible frame, with next-frame confirmation",
    ...observedNativeCohort({ state, backend: configuration.backend }),
    samplesPerActor: repetitions,
    scheduleSatisfied:
      state.samples.every((sample) => sample.offeredAtMs - sample.scheduledAtMs < paceMs) &&
      state.ingestion.every((sample) => sample.offeredAtMs - sample.scheduledAtMs < paceMs),
    samples: state.samples,
    direct: summarizeDashboardSamples(
      state.samples.filter((sample) => sample.journey === "direct")
    ),
    return: summarizeDashboardSamples(
      state.samples.filter((sample) => sample.journey === "return")
    ),
  });
};
const attachCohort = Effect.fn(function* (input: CohortAttachment) {
  const { state, prepared, profile } = input;
  const configuration = yield* Schema.encodeEffect(DashboardAssessmentConfiguration)(
    prepared.configuration
  );
  const actors = state.users.flatMap((user) => user.actors);
  const clocks = yield* Effect.forEach(actors, (actor) =>
    Effect.tryPromise(() => actor.page.evaluate(calibrateDashboardClock)).pipe(
      Effect.map((clock) => ({ user: actor.user, tab: actor.tab, clock })),
      Effect.orElseSucceed(() => ({
        user: actor.user,
        tab: actor.tab,
        clock: { positiveTickMs: 0, clockReadOverheadMs: 0 },
      }))
    )
  );
  const body = cohortBody(input, configuration, clocks);
  yield* Effect.tryPromise(() =>
    test.info().attach("dashboard-baseline", { body, contentType: "application/json" })
  );
  const name = `${dataset}-${profile}-${network}-${configuration.users}users-${configuration.history}-${configuration.layout}-${configuration.activity}`;
  yield* Effect.tryPromise(() =>
    Bun.write(
      new URL(
        `../reports/performance/dashboard-cohort-${configuration.backend}-${name}.json`,
        import.meta.url
      ),
      body
    )
  );
});
const measureUsers = Effect.fn(function* (
  users: ReadonlyArray<DashboardAssessmentUser>,
  state: CohortState,
  configuration: typeof DashboardAssessmentConfiguration.Type
) {
  yield* Effect.sleep(paceMs);
  const startedAtMs = performance.now();
  const reads = Effect.forEach(
    users.flatMap((user) => user.actors),
    (actor) => runCohort(actor, state.samples, startedAtMs),
    { concurrency: "unbounded", discard: true }
  );
  const writes =
    configuration.activity === "quiet"
      ? Effect.void
      : Effect.forEach(
          users,
          (user) =>
            runDashboardIngestion(user, {
              epoch: configuration.epoch,
              offers: repetitions * 2,
              startedAtMs,
              userCount: configuration.users,
              samples: state.ingestion,
            }),
          { concurrency: "unbounded", discard: true }
        );
  yield* Effect.all([reads, writes], { concurrency: "unbounded", discard: true });
});

test.beforeAll(prepareAssessmentFixture);
for (const profile of ["desktop", "mobile"] as const) {
  test(`measures fresh Dashboard direct entry and return on ${profile}`, ({ browser, request }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const prepared = yield* Effect.tryPromise(() => readPreparedAssessment({ request }));
        const configuration = yield* Schema.encodeEffect(DashboardAssessmentConfiguration)(
          prepared.configuration
        );
        const provenance = yield* dashboardAssessmentProvenance({
          configuration,
          layoutDigest: prepared.layoutDigest,
        });
        const state: CohortState = { users: [], samples: [], ingestion: [], setup: "failed" };
        yield* Effect.gen(function* () {
          state.users = yield* prepareDashboardUsers({
            browser,
            request,
            configuration: prepared.configuration,
            profile,
            network,
          });
          state.setup = "ready";
          yield* measureUsers(state.users, state, prepared.configuration);
        }).pipe(
          Effect.ensuring(
            attachCohort({ state, prepared, profile, browser: browser.version(), provenance }).pipe(
              Effect.orDie
            )
          )
        );
        expect(state.samples.length).toBe(
          repetitions *
            2 *
            prepared.configuration.users *
            (prepared.configuration.activity === "quiet" ? 1 : 2)
        );
      }).pipe(Effect.scoped)
    ));
}
