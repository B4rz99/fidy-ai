import type { APIRequestContext, Page, Route } from "@playwright/test";
import { ConnectInstitutionResult, ConnectionAttemptReference } from "@fidy/server/client";
import { type Cause, Clock, Effect, Schema } from "effect";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";
import { playwright } from "./playwright-runtime";
import {
  boundSessionRequests,
  probeCanonicalRequest,
  signInDashboardThroughCore,
  signInFirstCardThroughCore,
} from "./real-core-fixture";

const { test, expect } = playwright;
const { api, app, operator } = browserAcceptanceTopology();
const okStatus = 200;
const noContentStatus = 204;
const notFoundStatus = 404;
const unauthenticatedStatus = 401;
const forbiddenStatus = 403;
const unavailableStatus = 503;
const protocolJourneyBudget = 60000;
const browserClockLagMilliseconds = 600000;
const bankOrigin = "https://auth1-api-open-finance-sandbox.ambientesbc.com";
test.setTimeout(protocolJourneyBudget);

type BrowserFailure = Cause.UnknownError | Schema.SchemaError;
const signInForConnection = (
  input: Readonly<{
    page: Page;
    request: APIRequestContext;
  }>
): Promise<void> => signInFirstCardThroughCore({ ...input, deferFreshEntry: true });
type Continuation = Readonly<{
  session: ReturnType<typeof boundSessionRequests>;
  attempt: typeof ConnectionAttemptReference.Type;
  id: string;
  path: string;
}>;
const selectScenario = (
  request: APIRequestContext,
  mode: "ready" | "destination" | "signing" | "transport" | "activation-malformed"
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise(() =>
      request.post(`${operator}/connections/scenario?mode=${mode}`)
    );
    expect(response.status()).toBe(noContentStatus);
  });
const startConnection = (
  input: Readonly<{ page: Page; request: APIRequestContext }>
): Effect.Effect<Continuation, BrowserFailure | Cause.TimeoutError> =>
  Effect.gen(function* () {
    const session = boundSessionRequests(input.page.request);
    const started = yield* probeCanonicalRequest({
      request: input.request,
      send: () => session.post(`${api}/connections`, { data: { institutionId: "bancolombia" } }),
    });
    expect(started.status()).toBe(okStatus);
    const body = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ data: Schema.toCodecJson(ConnectInstitutionResult) })
    )(yield* Effect.tryPromise(() => started.json()));
    if (body.data.type !== "continue_in_browser") {
      throw new Error("Expected browser continuation");
    }
    const continuation = new URL(body.data.continuation.url);
    const attempt = yield* Schema.decodeUnknownEffect(ConnectionAttemptReference)(
      continuation.searchParams.get("attempt")
    );
    return {
      session,
      attempt,
      id: body.data.connection.id,
      path: continuation.pathname + continuation.search,
    };
  });
const begin = (page: Page, path: string): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const review = page.waitForResponse(
      (response) =>
        response.url().includes("/web/connections/review") && response.status() === okStatus
    );
    yield* Effect.tryPromise(() => page.goto(path));
    expect((yield* Effect.tryPromise(() => review)).status()).toBe(okStatus);
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Continuar", exact: true }).click()
    );
  });

const bankHandoff = (route: Route): Promise<void> => {
  expect(route.request().headers().referer).toBeUndefined();
  return route.fulfill({
    status: okStatus,
    contentType: "text/html",
    body: "<!doctype html><title>Banco de prueba</title><h1>Autorización pendiente</h1>",
  });
};

const returnFromBank = (
  page: Page,
  request: APIRequestContext
): Effect.Effect<void, BrowserFailure> =>
  Effect.gen(function* () {
    const handoff = page.getByRole("link", { name: "Continuar en Bancolombia", exact: true });
    yield* Effect.tryPromise(() => expect(handoff).toBeVisible());
    yield* Effect.tryPromise(() => page.route(`${bankOrigin}/auth?**`, bankHandoff));
    yield* Effect.tryPromise(() => handoff.click());
    yield* Effect.tryPromise(() =>
      expect(page).toHaveURL(/^https:\/\/auth1-api-open-finance-sandbox\.ambientesbc\.com\/auth\?/u)
    );
    const bank = yield* Effect.tryPromise(() =>
      request.post(`${operator}/connections/bank-return`)
    );
    const response = yield* Schema.decodeUnknownEffect(Schema.Struct({ state: Schema.String }))(
      yield* Effect.tryPromise(() => bank.json())
    );
    yield* Effect.tryPromise(() =>
      page.goto(
        `${api}/connections/bancolombia/sandbox/callback?code=synthetic-browser-code&state=${response.state}`
      )
    );
  });

const staleReview =
  (body: string): ((route: Route) => Promise<void>) =>
  (route) =>
    route.fulfill({ status: okStatus, contentType: "application/json", body });

const continuationRecovery = (
  readyBody: string
): Readonly<{
  review: (route: Route) => Promise<void>;
  select: (mode: "ready" | "failed" | "live") => void;
}> => {
  let mode: "ready" | "failed" | "live" = "ready";
  return {
    select: (selected) => {
      mode = selected;
    },
    review: (route) => {
      if (mode === "live") return route.continue();
      return route.fulfill({
        status: mode === "ready" ? okStatus : unavailableStatus,
        contentType: "application/json",
        body: mode === "ready" ? readyBody : '{"error":{"code":"continuation_unavailable"}}',
      });
    },
  };
};
const doubleBegin = (button: HTMLElement): void => {
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
};
const loseBeginReply = (route: Route): Promise<void> =>
  route.fetch().then(() => route.abort("failed"));

const holdBeginReply = (): Readonly<{
  route: (route: Route) => Promise<void>;
  prepared: Promise<void>;
  release: () => void;
  delivered: Promise<void>;
}> => {
  const prepared = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  return {
    prepared: prepared.promise,
    delivered: delivered.promise,
    release: () => release.resolve(),
    route: (route) =>
      route.fetch().then((response) => {
        prepared.resolve();
        return release.promise
          .then(() => route.fulfill({ response }))
          .then(() => delivered.resolve());
      }),
  };
};

const observeReplacedSession = (): void => {
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
};
const disableAuthenticationBroadcast = (): void => {
  Object.defineProperty(window, "BroadcastChannel", { value: undefined });
};
const replaceContinuationLocation = (path: string): void => {
  const state: unknown = window.history.state;
  window.history.pushState(state, "", path);
  window.dispatchEvent(new PopStateEvent("popstate", { state }));
};

test("ignores a late Begin reply after the mounted continuation locator changes", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => signInForConnection({ page, request }));
      yield* selectScenario(request, "ready");
      const original = yield* startConnection({ page, request });
      const held = holdBeginReply();
      yield* Effect.tryPromise(() => page.route(`${api}/web/connections/begin`, held.route));
      yield* begin(page, original.path);
      yield* Effect.tryPromise(() => held.prepared);
      const replacement = yield* startConnection({ page, request });
      expect(replacement.attempt).not.toBe(original.attempt);
      yield* Effect.tryPromise(() => page.evaluate(replaceContinuationLocation, replacement.path));
      const action = page.getByRole("button", { name: "Continuar", exact: true });
      yield* Effect.tryPromise(() => expect(action).toBeEnabled());
      held.release();
      yield* Effect.tryPromise(() => held.delivered);
      yield* Effect.tryPromise(() => expect(action).toBeEnabled());
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("link", { name: "Continuar en Bancolombia", exact: true })
        ).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(page).toHaveURL(new URL(replacement.path, app).toString())
      );
    })
  ));

test("retires a pending bank preparation when another browser session replaces its owner", ({
  page,
  context,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => page.addInitScript(disableAuthenticationBroadcast));
      yield* Effect.tryPromise(() => signInForConnection({ page, request }));
      yield* selectScenario(request, "ready");
      const continuation = yield* startConnection({ page, request });
      const held = holdBeginReply();
      yield* Effect.tryPromise(() => page.route(`${api}/web/connections/begin`, held.route));
      yield* begin(page, continuation.path);
      yield* Effect.tryPromise(() => held.prepared);
      const other = yield* Effect.tryPromise(() => context.newPage());
      yield* Effect.tryPromise(() => signInDashboardThroughCore({ page: other, request }));
      yield* Effect.tryPromise(() => page.evaluate(observeReplacedSession));
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Solicitud no disponible", { exact: true })).toBeVisible()
      );
      held.release();
      yield* Effect.tryPromise(() => held.delivered);
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("link", { name: "Continuar en Bancolombia", exact: true })
        ).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Continuar", exact: true })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(other.getByRole("button", { name: "+ Registrar", exact: true })).toBeVisible()
      );
    })
  ));

test("keeps a lost Begin unresolved through old Ready and failed reads, recovering only authoritative handoff", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => signInForConnection({ page, request }));
      yield* selectScenario(request, "ready");
      const continuation = yield* startConnection({ page, request });
      const ready = yield* Effect.tryPromise(() =>
        continuation.session.get(`${api}/web/connections/review?attempt=${continuation.attempt}`)
      );
      const recovery = continuationRecovery(yield* Effect.tryPromise(() => ready.text()));
      yield* Effect.tryPromise(() =>
        page.route(`${api}/web/connections/review?**`, recovery.review)
      );
      yield* Effect.tryPromise(() => page.route(`${api}/web/connections/begin`, loseBeginReply));
      let submissions = 0;
      page.on("request", (outgoing) => {
        if (outgoing.url() === `${api}/web/connections/begin`) submissions += 1;
      });
      yield* Effect.tryPromise(() => page.goto(continuation.path));
      const action = page.getByRole("button", { name: "Continuar", exact: true });
      yield* Effect.tryPromise(() => action.evaluate(doubleBegin));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toContainText("No pudimos confirmar el resultado")
      );
      const refresh = page.getByRole("button", { name: "Consultar estado", exact: true });
      yield* Effect.tryPromise(() => refresh.click());
      yield* Effect.tryPromise(() => expect(action).toBeDisabled());
      recovery.select("failed");
      yield* Effect.tryPromise(() => refresh.click());
      yield* Effect.tryPromise(() =>
        expect(page.getByText(/La información mostrada puede estar desactualizada/u)).toBeVisible()
      );
      yield* Effect.tryPromise(() => expect(action).toBeDisabled());
      recovery.select("live");
      yield* Effect.tryPromise(() => refresh.click());
      const handoff = page.getByRole("link", { name: "Continuar en Bancolombia", exact: true });
      yield* Effect.tryPromise(() => expect(handoff).toBeVisible());
      recovery.select("failed");
      yield* Effect.tryPromise(() => refresh.click());
      yield* Effect.tryPromise(() => expect(handoff).toHaveCount(0));
      yield* Effect.tryPromise(() =>
        expect(page.getByText(/La información mostrada puede estar desactualizada/u)).toBeVisible()
      );
      recovery.select("live");
      yield* Effect.tryPromise(() => refresh.click());
      yield* Effect.tryPromise(() => expect(handoff).toBeVisible());
      expect(submissions).toBe(1);
    })
  ));

test("never reopens Begin when a completed submission is followed by an older Ready review", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => signInForConnection({ page, request }));
      yield* selectScenario(request, "ready");
      const continuation = yield* startConnection({ page, request });
      const ready = yield* Effect.tryPromise(() =>
        continuation.session.get(`${api}/web/connections/review?attempt=${continuation.attempt}`)
      );
      const readyBody = yield* Effect.tryPromise(() => ready.text());
      let submissions = 0;
      yield* Effect.tryPromise(() =>
        page.route(`${api}/web/connections/review?**`, staleReview(readyBody))
      );
      page.on("request", (outgoing) => {
        if (outgoing.url() === `${api}/web/connections/begin`) submissions += 1;
      });
      yield* begin(page, continuation.path);
      const action = page.getByRole("button", { name: "Continuar", exact: true });
      yield* Effect.tryPromise(() => expect(action).toBeDisabled());
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Consultar estado", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(action).toBeDisabled());
      expect(submissions).toBe(1);
    })
  ));

for (const stage of ["begin", "handoff", "auxiliary handoff"] as const) {
  test(`refuses expired ${stage} actions even before the deadline timer fires`, ({
    page,
    request,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() => signInForConnection({ page, request }));
        yield* selectScenario(request, "ready");
        const browserNow = (yield* Clock.currentTimeMillis) - browserClockLagMilliseconds;
        yield* Effect.tryPromise(() => page.clock.setSystemTime(browserNow));
        const continuation = yield* startConnection({ page, request });
        if (stage !== "begin") yield* begin(page, continuation.path);
        else yield* Effect.tryPromise(() => page.goto(continuation.path));
        const action =
          stage === "begin"
            ? page.getByRole("button", { name: "Continuar", exact: true })
            : page.getByRole("link", { name: "Continuar en Bancolombia", exact: true });
        yield* Effect.tryPromise(() => expect(action).toBeVisible());
        const deadline = yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(
          yield* Effect.tryPromise(() => page.locator("time").getAttribute("datetime"))
        );
        let effects = 0;
        page.on("request", (outgoing) => {
          if (
            outgoing.url() === `${api}/web/connections/begin` ||
            outgoing.url().startsWith(bankOrigin)
          ) {
            effects += 1;
          }
        });
        yield* Effect.tryPromise(() => page.clock.setSystemTime(deadline.epochMilliseconds + 1));
        yield* Effect.tryPromise(() =>
          action.click({ button: stage === "auxiliary handoff" ? "middle" : "left" })
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("alert")).toContainText("La solicitud venció")
        );
        yield* Effect.tryPromise(() =>
          expect(page).toHaveURL(new URL(continuation.path, app).toString())
        );
        if (stage !== "begin") yield* Effect.tryPromise(() => expect(action).toHaveCount(0));
        else yield* Effect.tryPromise(() => expect(action).toBeDisabled());
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("button", { name: "Consultar estado", exact: true })).toBeDisabled()
        );
        expect(effects).toBe(0);
      })
    ));
}

test("hands off through Core only after browser proof, refuses replay and keeps the Connection pending", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => signInForConnection({ page, request }));
      yield* selectScenario(request, "ready");
      const continuation = yield* startConnection({ page, request });
      const anonymous = yield* Effect.tryPromise(() =>
        request.post(`${api}/web/connections/begin`, {
          headers: { origin: app },
          data: { attempt: continuation.attempt },
        })
      );
      expect(anonymous.status()).toBe(unauthenticatedStatus);
      const hostile = yield* Effect.tryPromise(() =>
        continuation.session.post(`${api}/web/connections/begin`, {
          headers: { origin: "https://foreign.example" },
          data: { attempt: continuation.attempt },
        })
      );
      expect(hostile.status()).toBe(forbiddenStatus);
      const csrf = yield* Effect.tryPromise(() =>
        continuation.session.post(`${api}/web/connections/begin`, {
          headers: { "Fidy-Session-Binding": "invalid" },
          data: { attempt: continuation.attempt },
        })
      );
      expect(csrf.status()).toBe(unauthenticatedStatus);
      yield* begin(page, continuation.path);
      const handoff = page.getByRole("link", { name: "Continuar en Bancolombia", exact: true });
      yield* Effect.tryPromise(() => expect(handoff).toBeVisible());
      yield* Effect.tryPromise(() => page.route(`${bankOrigin}/auth?**`, bankHandoff));
      yield* Effect.tryPromise(() => handoff.click());
      yield* Effect.tryPromise(() =>
        expect(page).toHaveURL(
          /^https:\/\/auth1-api-open-finance-sandbox\.ambientesbc\.com\/auth\?/u
        )
      );
      const replay = yield* probeCanonicalRequest({
        request,
        send: () =>
          continuation.session.post(`${api}/web/connections/begin`, {
            data: { attempt: continuation.attempt },
          }),
      });
      expect(replay.status()).toBe(notFoundStatus);
      const inspected = yield* probeCanonicalRequest({
        request,
        send: () => continuation.session.get(`${api}/connections/${continuation.id}`),
      });
      expect(
        yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.Struct({ state: Schema.Literal("Connecting") }) })
        )(yield* Effect.tryPromise(() => inspected.json()))
      ).toEqual({ data: { state: "Connecting" } });
    })
  ));

test("expires the bank handoff before the original attempt and permits leaving without approval", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => signInForConnection({ page, request }));
      const browserNow = (yield* Clock.currentTimeMillis) - browserClockLagMilliseconds;
      yield* Effect.tryPromise(() => page.clock.setSystemTime(browserNow));
      yield* selectScenario(request, "ready");
      const continuation = yield* startConnection({ page, request });
      yield* begin(page, continuation.path);
      const handoff = page.getByRole("link", { name: "Continuar en Bancolombia", exact: true });
      yield* Effect.tryPromise(() => expect(handoff).toBeVisible());
      const deadline = yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(
        yield* Effect.tryPromise(() => page.locator("time").getAttribute("datetime"))
      );
      yield* Effect.tryPromise(() =>
        page.clock.fastForward(deadline.epochMilliseconds - browserNow + 1)
      );
      yield* Effect.tryPromise(() => expect(handoff).toHaveCount(0));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toContainText("La solicitud venció")
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Cancelar y volver a Fidy", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/app\/transactions$/u));
    })
  ));

test("shows safe failure for destination, signing and transport refusals without another submission", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => signInForConnection({ page, request }));
      for (const mode of ["destination", "signing", "transport"] as const) {
        yield* selectScenario(request, mode);
        const continuation = yield* startConnection({ page, request });
        yield* begin(page, continuation.path);
        yield* Effect.tryPromise(() =>
          expect(page.getByText(/No pudimos completar esta solicitud/u)).toBeVisible()
        );
        yield* Effect.tryPromise(() =>
          expect(
            page.getByRole("link", { name: "Continuar en Bancolombia", exact: true })
          ).toHaveCount(0)
        );
        const replay = yield* probeCanonicalRequest({
          request,
          send: () =>
            continuation.session.post(`${api}/web/connections/begin`, {
              data: { attempt: continuation.attempt },
            }),
        });
        expect(replay.status()).toBe(notFoundStatus);
      }
    })
  ));

test("returns from the bank through public Core to truthful failed and Active results without exposing protocol credentials", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => signInForConnection({ page, request }));
      yield* selectScenario(request, "activation-malformed");
      const failed = yield* startConnection({ page, request });
      yield* begin(page, failed.path);
      yield* returnFromBank(page, request);
      yield* Effect.tryPromise(() => expect(page).toHaveURL(`${app}/connections/result`));
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("heading", { name: "No pudimos completar la conexión" })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("navigation", { name: "Aplicación" })).toBeVisible()
      );
      yield* selectScenario(request, "ready");
      const started = yield* startConnection({ page, request });
      expect(started.id).toBe(failed.id);
      yield* begin(page, started.path);
      yield* returnFromBank(page, request);
      yield* Effect.tryPromise(() => expect(page).toHaveURL(`${app}/connections/result`));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Bancolombia está conectado" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Cuentas autorizadas: 2.")).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByText("Las transacciones y los saldos aún no se han importado.", {
            exact: false,
          })
        ).toBeVisible()
      );
      const visible = yield* Effect.tryPromise(() => page.locator("body").innerText());
      expect(visible).not.toContain("synthetic-browser-code");
      expect(visible).not.toContain("synthetic-access");
      expect(visible).not.toContain("synthetic-refresh");
      expect(visible).not.toContain("synthetic-account-a");
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Consultar estado" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Bancolombia está conectado" })).toBeVisible()
      );
    })
  ));
