import type {
  APIRequestContext,
  Browser,
  BrowserContext,
  CDPSession,
  Page,
} from "@playwright/test";
import { type Cause, DateTime, Effect, Schema, type Scope } from "effect";
import {
  type DashboardAssessmentConfiguration,
  dashboardAssessmentIdentities,
} from "../../server/cloudflare/browser-acceptance/contract";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";
import { browserSessionHeaders, signInNavigationPerformanceThroughCore } from "./real-core-fixture";
import {
  installDashboardMeasurement,
  installDashboardNavigationMeasurement,
} from "./dashboard-measurement";
import { playwright } from "./playwright-runtime";

const { expect } = playwright;
const appOrigin = browserAcceptanceTopology().app;
export const dashboardPacedIntervalMilliseconds = 12000;
const mobileCpuRate = 4;
const actionTimeoutMilliseconds = 10000;
const navigationTimeoutMilliseconds = 45000;
const createdStatus = 201;
const refusedStatus = 429;
const UserIdentityResponse = Schema.Struct({ data: Schema.Struct({ id: Schema.String }) });
const requestDeadlineMilliseconds = 20000;
const poorConnection = {
  offline: false,
  latency: 400,
  downloadThroughput: 51200,
  uploadThroughput: 25600,
};
export type DashboardActor = Readonly<{
  page: Page;
  cdp: CDPSession;
  user: number;
  tab: number;
  offsetMilliseconds: number;
}>;
export type DashboardAssessmentUser = Readonly<{
  actors: ReadonlyArray<DashboardActor>;
  request: APIRequestContext;
  headers: Readonly<Record<string, string>>;
  user: number;
}>;
type Setup = Readonly<{
  browser: Browser;
  request: APIRequestContext;
  configuration: typeof DashboardAssessmentConfiguration.Type;
  profile: "desktop" | "mobile";
  network: "normal" | "poor";
}>;
const prepareProfile = Effect.fn(function* (actor: DashboardActor, input: Setup) {
  const { page, cdp } = actor;
  page.setDefaultTimeout(actionTimeoutMilliseconds);
  page.setDefaultNavigationTimeout(navigationTimeoutMilliseconds);
  yield* Effect.tryPromise(() =>
    cdp.send("Emulation.setCPUThrottlingRate", {
      rate: input.profile === "desktop" ? 1 : mobileCpuRate,
    })
  );
  yield* Effect.tryPromise(() =>
    page.setViewportSize(
      input.profile === "desktop" ? { width: 1280, height: 720 } : { width: 390, height: 844 }
    )
  );
  if (input.network === "poor") {
    yield* Effect.tryPromise(() => cdp.send("Network.enable"));
    yield* Effect.tryPromise(() => cdp.send("Network.emulateNetworkConditions", poorConnection));
  }
  yield* Effect.tryPromise(() => page.addInitScript(installDashboardMeasurement));
  yield* Effect.tryPromise(() => page.addInitScript(installDashboardNavigationMeasurement));
  yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("button", { name: "Personalizar", exact: true })).toBeEnabled()
  );
});
const prepareActor = Effect.fn(function* (
  input: Setup,
  member: Readonly<{
    context: BrowserContext;
    page: Page;
    user: number;
    tab: number;
    count: number;
  }>
) {
  const cdp = yield* Effect.tryPromise(() => member.context.newCDPSession(member.page));
  const actor = {
    page: member.page,
    cdp,
    user: member.user,
    tab: member.tab,
    offsetMilliseconds:
      (member.user * dashboardPacedIntervalMilliseconds) / input.configuration.users +
      (member.tab * dashboardPacedIntervalMilliseconds) / member.count,
  };
  yield* prepareProfile(actor, input);
  return actor;
});
const prepareUser = Effect.fn(function* (input: Setup, user: number) {
  const identity = dashboardAssessmentIdentities[user];
  if (identity === undefined) throw new Error("Assessment User has no fixed identity");
  const context = yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      input.browser.newContext({
        baseURL: appOrigin,
        ignoreHTTPSErrors: true,
        extraHTTPHeaders: { "x-acceptance-source": `203.0.113.${user + 1}` },
      })
    ),
    (context) => Effect.tryPromise(() => context.close()).pipe(Effect.orDie)
  );
  const first = yield* Effect.tryPromise(() => context.newPage());
  yield* Effect.tryPromise(() =>
    signInNavigationPerformanceThroughCore({
      page: first,
      request: input.request,
      identity: identity.key,
    })
  );
  const pages = [first];
  if (input.configuration.activity === "ingestion-two-tabs") {
    pages.push(yield* Effect.tryPromise(() => context.newPage()));
  }
  const actors = yield* Effect.forEach(pages, (page, tab) =>
    prepareActor(input, { context, page, user, tab, count: pages.length })
  );
  const headers = yield* Effect.tryPromise(() => browserSessionHeaders(context.request));
  const observed = yield* Effect.tryPromise(() =>
    context.request.get(`${appOrigin}/user`, { headers }).then((response) => response.json())
  );
  const current = yield* Schema.decodeUnknownEffect(UserIdentityResponse)(observed);
  expect(current.data.id).toBe(identity.userId);
  return { actors, request: context.request, headers, user };
});

/** The caller owns a Scope through all samples; each User has an independent browser cookie jar. */
export const prepareDashboardUsers = (
  input: Setup
): Effect.Effect<
  ReadonlyArray<DashboardAssessmentUser>,
  Cause.UnknownError | Schema.SchemaError,
  Scope.Scope
> =>
  Effect.forEach(
    Array.from({ length: input.configuration.users }, (_, index) => index),
    (user) => prepareUser(input, user)
  );

export type DashboardIngestionObservation = Readonly<{
  user: number;
  offeredAtMs: number;
  scheduledAtMs: number;
  durationMs: number;
  outcome: "created" | "refused" | "timeout" | "failed";
}>;
const ingestionRequest = Effect.fn(function* (
  user: DashboardAssessmentUser,
  input: Readonly<{ epoch: DateTime.Utc; ordinal: number; scheduledAtMs: number }>
) {
  const started = performance.now();
  const reply = yield* Effect.tryPromise(() =>
    user.request.post(`${appOrigin}/transactions`, {
      headers: user.headers,
      data: {
        money: { amount: "0.01", currency: "COP" },
        direction: "outflow",
        categoryId: "10000000-0000-4000-8000-000000000001",
        counterparty: `Ingestión de evaluación ${input.ordinal}`,
        occurredAt: DateTime.formatIso(
          DateTime.makeUnsafe(DateTime.toEpochMillis(input.epoch) + input.ordinal)
        ),
      },
      timeout: 0,
    })
  ).pipe(Effect.timeout(requestDeadlineMilliseconds), Effect.result);
  let outcome: DashboardIngestionObservation["outcome"] = "failed";
  if (reply._tag === "Success") {
    const status = reply.success.status();
    if (status === createdStatus) outcome = "created";
    else if (status === refusedStatus) outcome = "refused";
    yield* Effect.tryPromise(() => reply.success.dispose()).pipe(Effect.ignore);
  } else if (reply.failure._tag === "TimeoutError") outcome = "timeout";
  return {
    user: user.user,
    offeredAtMs: started,
    scheduledAtMs: input.scheduledAtMs,
    durationMs: performance.now() - started,
    outcome,
  };
});

/** Distinct manual captures run alongside navigation; an uncertain capture is never resubmitted. */
export const runDashboardIngestion = Effect.fn(function* (
  user: DashboardAssessmentUser,
  input: Readonly<{
    epoch: DateTime.Utc;
    offers: number;
    startedAtMs: number;
    userCount: number;
    samples: DashboardIngestionObservation[];
  }>
) {
  let scheduledAtMs =
    input.startedAtMs + (user.user * dashboardPacedIntervalMilliseconds) / input.userCount;
  for (let ordinal = 0; ordinal < input.offers; ordinal++) {
    yield* Effect.sleep(Math.max(0, scheduledAtMs - performance.now()));
    input.samples.push(
      yield* ingestionRequest(user, { epoch: input.epoch, ordinal, scheduledAtMs })
    );
    scheduledAtMs += dashboardPacedIntervalMilliseconds;
  }
});
