import type { APIRequestContext, Page, Route } from "@playwright/test";
import { ConnectInstitutionResult, ConnectionAttemptReference } from "@fidy/server/client";
import { type Cause, Clock, Effect, Schema } from "effect";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";
import { playwright } from "./playwright-runtime";
import {
  boundSessionRequests,
  probeCanonicalRequest,
  signInFirstCardThroughCore,
} from "./real-core-fixture";

const { test, expect } = playwright;
const { api, app, operator } = browserAcceptanceTopology();
const okStatus = 200;
const noContentStatus = 204;
const notFoundStatus = 404;
const unauthenticatedStatus = 401;
const forbiddenStatus = 403;
const protocolJourneyBudget = 60000;
const browserClockLagMilliseconds = 600000;
const bankOrigin = "https://auth1-api-open-finance-sandbox.ambientesbc.com";
test.setTimeout(protocolJourneyBudget);

type BrowserFailure = Cause.UnknownError | Schema.SchemaError;
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

test("hands off through Core only after browser proof, refuses replay and keeps the Connection pending", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => signInFirstCardThroughCore({ page, request }));
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
      yield* Effect.tryPromise(() => signInFirstCardThroughCore({ page, request }));
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
      yield* Effect.tryPromise(() => signInFirstCardThroughCore({ page, request }));
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
      yield* Effect.tryPromise(() => signInFirstCardThroughCore({ page, request }));
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
