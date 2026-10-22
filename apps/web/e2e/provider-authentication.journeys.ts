import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";
import { playwright } from "./playwright-runtime";
import { advanceAcceptancePoll, installAcceptanceClock } from "./acceptance-clock";
import {
  boundSessionRequests,
  openTransactionsThroughCore,
  reloadTransactionsThroughCore,
  visiblePairingCode,
} from "./real-core-fixture";
import { invokeRecoveryOperator } from "../../cli/test/recovery-operator.test-fixture";
import type { APIRequestContext, APIResponse, BrowserContext, Page, Route } from "@playwright/test";
import { type Cause, Effect, Option, Schema } from "effect";

export type ProviderJourneyConfiguration = Readonly<{
  provider: "google" | "microsoft";
  label: string;
  authorizationPattern: string;
  recoverWithOperator: boolean;
}>;
type ProviderJourney = Readonly<{
  page: Page;
  context: BrowserContext;
  request: APIRequestContext;
}>;
const { expect } = playwright;
const { api, operator } = browserAcceptanceTopology();
/** Keep each journey's source stable while isolating independent tests sharing loopback ingress. */
export const isolateProviderSource = (context: BrowserContext): Promise<void> => {
  const info = playwright.test.info();
  return context.setExtraHTTPHeaders({
    "x-acceptance-source": `${info.testId}-${info.repeatEachIndex}`,
  });
};
const redirectStatus = 302;
const pendingStatus = 202;
const noContentStatus = 204;
const unauthorizedStatus = 401;
const successStatus = 200;
const unavailableStatus = 503;
const advancePastRequestDeadline = 10_001;
const lateResponseAdvance = 1_000;
const deliverUnavailable = (route: Route, available: boolean): Promise<void> =>
  route.fetch().then((response) => {
    expect(response.status()).toBe(successStatus);
    return route.fulfill(
      available
        ? { response }
        : {
            response,
            status: unavailableStatus,
            body: '{"status":"unavailable"}',
          }
    );
  });

type HeldStatus = Readonly<{ ready: () => boolean; release: () => Promise<void> }>;
const holdProviderStatus = (
  page: Page,
  provider: ProviderJourneyConfiguration["provider"]
): Effect.Effect<HeldStatus, Cause.UnknownError> =>
  Effect.gen(function* () {
    let release = Option.none<() => Promise<void>>();
    const hold = (route: Route): Promise<void> => {
      const retainResponse = (response: APIResponse): void => {
        expect(response.status()).toBe(successStatus);
        release = Option.some(route.fulfill.bind(route, { response }));
      };
      return route.fetch().then(retainResponse);
    };
    yield* Effect.tryPromise(() => page.route(`**/web/providers/${provider}/status`, hold));
    return {
      ready: (): boolean => Option.isSome(release),
      release: (): Promise<void> => Option.getOrThrow(release)(),
    };
  });

const retryStalledProvider = ({
  page,
  context,
  configuration,
  outcome,
}: Pick<ProviderJourney, "page" | "context"> &
  Readonly<{
    configuration: ProviderJourneyConfiguration;
    outcome: string;
  }>): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      page.unroute(`**/web/providers/${configuration.provider}/status`)
    );
    yield* Effect.tryPromise(() => context.unroute(configuration.authorizationPattern));
    yield* Effect.tryPromise(() =>
      context.route(configuration.authorizationPattern, (route) =>
        redirectSubject(
          configuration,
          `stalled-status-retry-${configuration.provider}-${outcome}`,
          route
        )
      )
    );
    yield* Effect.tryPromise(() => page.clock.resume());
    yield* Effect.tryPromise(() => page.getByRole("button", { name: "Volver a intentar" }).click());
    yield* Effect.tryPromise(() =>
      expect(page.getByText("Guarda tu código de recuperación")).toBeVisible()
    );
  });

export const unavailablePairingJourney = ({
  configuration,
  page,
  context,
}: ProviderJourney & Readonly<{ configuration: ProviderJourneyConfiguration }>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        context.route(configuration.authorizationPattern, (route) =>
          redirectSubject(configuration, `pairing-retry-${configuration.provider}`, route)
        )
      );
      let starts = 0;
      yield* Effect.tryPromise(() =>
        page.route("**/web/pairings", (route) => {
          starts += 1;
          return deliverUnavailable(route, false);
        })
      );
      yield* Effect.tryPromise(() => page.goto("/login"));
      yield* Effect.tryPromise(() =>
        page.getByLabel("Acepto el tratamiento de datos descrito").check()
      );
      const popup = yield* Effect.tryPromise(() =>
        Promise.all([
          page.waitForEvent("popup"),
          page.getByRole("button", { name: `Continuar con ${configuration.label}` }).click(),
        ]).then(([opened]) => opened)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toHaveText(
          "No se completó el acceso. Puedes iniciar un nuevo intento."
        )
      );
      yield* Effect.tryPromise(() => expect.poll(() => popup.isClosed()).toBe(true));
      expect(starts).toBe(1);
      expect(
        (yield* Effect.tryPromise(() => context.cookies())).some(
          (cookie) => cookie.name === "__Host-fidy_session"
        )
      ).toBe(false);
      yield* Effect.tryPromise(() => page.unroute("**/web/pairings"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Volver a intentar" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Guarda tu código de recuperación")).toBeVisible()
      );
    })
  );

export const disclosureRetryJourney = ({
  configuration,
  page,
  context,
}: ProviderJourney & Readonly<{ configuration: ProviderJourneyConfiguration }>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      let available = false;
      yield* Effect.tryPromise(() =>
        page.route("**/web/providers/disclosure", (route) => deliverUnavailable(route, available))
      );
      yield* Effect.tryPromise(() =>
        context.route(configuration.authorizationPattern, (route) =>
          redirectSubject(configuration, `disclosure-retry-${configuration.provider}`, route)
        )
      );
      yield* Effect.tryPromise(() => page.goto("/login"));
      yield* Effect.tryPromise(() =>
        expect(
          page.getByText("No pudimos cargar el Consentimiento.", { exact: false })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("button", { name: `Continuar con ${configuration.label}` })
        ).toBeDisabled()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Acepto el tratamiento de datos descrito")).toHaveCount(0)
      );
      available = true;
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Volver a intentar" }).click()
      );
      yield* expectSignupNotice(page);
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("button", { name: `Continuar con ${configuration.label}` })
        ).toBeDisabled()
      );
      yield* Effect.tryPromise(() =>
        page.getByLabel("Acepto el tratamiento de datos descrito").check()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: `Continuar con ${configuration.label}` }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Guarda tu código de recuperación")).toBeVisible()
      );
    })
  );

export const stalledProviderJourney = ({
  configuration,
  page,
  context,
  outcome,
}: ProviderJourney &
  Readonly<{
    configuration: ProviderJourneyConfiguration;
    outcome: "popup-close" | "cancel" | "timeout";
  }>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => page.clock.install());
      yield* Effect.tryPromise(() =>
        context.route(configuration.authorizationPattern, pendingProvider)
      );
      const held = yield* holdProviderStatus(page, configuration.provider);
      yield* Effect.tryPromise(() => page.goto("/login"));
      yield* Effect.tryPromise(() =>
        page.getByLabel("Acepto el tratamiento de datos descrito").check()
      );
      const popup = yield* Effect.tryPromise(() =>
        Promise.all([
          page.waitForEvent("popup"),
          page.getByRole("button", { name: `Continuar con ${configuration.label}` }).click(),
        ]).then(([opened]) => opened)
      );
      yield* Effect.tryPromise(() =>
        expect.poll(held.ready, { message: "real status response is held" }).toBe(true)
      );
      yield* Effect.tryPromise(() =>
        expect(popup.getByText("Pending provider decision")).toBeVisible()
      );
      const browserNow = yield* Effect.tryPromise(() =>
        page.evaluate(() => performance.timeOrigin + performance.now())
      );
      yield* Effect.tryPromise(() => page.clock.pauseAt(browserNow + 100));
      if (outcome === "popup-close") yield* Effect.tryPromise(() => popup.close());
      if (outcome === "cancel") {
        yield* Effect.tryPromise(() => page.getByRole("button", { name: "Cancelar" }).click());
      }
      yield* Effect.tryPromise(() => page.clock.runFor(advancePastRequestDeadline));
      const message =
        outcome === "timeout"
          ? "No se completó el acceso. Puedes iniciar un nuevo intento."
          : "Cancelaste el acceso.";
      yield* Effect.tryPromise(() => expect(page.getByText(message)).toBeVisible());
      yield* Effect.tryPromise(held.release);
      yield* Effect.tryPromise(() => page.clock.runFor(lateResponseAdvance));
      yield* Effect.tryPromise(() => expect(page.getByText(message)).toBeVisible());
      expect(
        (yield* Effect.tryPromise(() => context.cookies())).some(
          (cookie) => cookie.name === "__Host-fidy_session"
        )
      ).toBe(false);
      yield* retryStalledProvider({ page, context, configuration, outcome });
    })
  );

const redirectSubject = (
  configuration: ProviderJourneyConfiguration,
  subject: string,
  route: Route
): Promise<void> => {
  const query = new URL(route.request().url()).searchParams;
  const code = btoa(JSON.stringify({ nonce: query.get("nonce"), subject }));
  const callback = new URL(`${api}/providers/${configuration.provider}/callback`);
  callback.searchParams.set("state", query.get("state") ?? "");
  callback.searchParams.set("code", code);
  return route.fulfill({ status: redirectStatus, headers: { location: callback.href } });
};

const retainedSecretCount = (): number => localStorage.length + sessionStorage.length;
const returningSessionPolicies = (
  configuration: ProviderJourneyConfiguration,
  {
    page,
    context,
    request,
  }: Readonly<{
    page: Page;
    context: BrowserContext;
    request: APIRequestContext;
  }>
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      request.post(
        `${operator}/${configuration.provider}/expire?subject=browser-${configuration.provider}-signup`
      )
    );
    yield* Effect.tryPromise(() => page.reload());
    yield* Effect.tryPromise(() =>
      expect(page.getByText("Acceso no autorizado", { exact: true })).toBeVisible()
    );
    yield* Effect.tryPromise(() => page.goto("/login"));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Ya tengo cuenta · Iniciar sesión" }).click()
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: `Continuar con ${configuration.label}` }).click()
    );
    yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/app\/transactions$/u));
    const revocation = yield* Effect.tryPromise(() =>
      request.post(
        `${operator}/${configuration.provider}/revoke?subject=browser-${configuration.provider}-signup`
      )
    );
    expect(revocation.status()).toBe(noContentStatus);
    yield* Effect.tryPromise(() => page.goto("/login"));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Ya tengo cuenta · Iniciar sesión" }).click()
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: `Continuar con ${configuration.label}` }).click()
    );
    yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/app\/transactions$/u));
    const blocked = yield* Effect.tryPromise(() =>
      boundSessionRequests(context.request).get(`${api}/transactions`)
    );
    expect(blocked.status()).toBe(unauthorizedStatus);
    expect(yield* Effect.tryPromise(() => blocked.json())).toMatchObject({
      error: { code: "unauthenticated" },
    });
  });
const signupHistoryJourney = Effect.fn(function* (
  configuration: ProviderJourneyConfiguration,
  page: Page
) {
  yield* Effect.tryPromise(() => page.goBack());
  yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/login$/u));
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Código de recuperación", { exact: true })).toHaveCount(0)
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Acepto el tratamiento de datos descrito")).toBeVisible()
  );
  yield* Effect.tryPromise(() => page.reload());
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Código de recuperación", { exact: true })).toHaveCount(0)
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Acepto el tratamiento de datos descrito")).toBeVisible()
  );
  yield* Effect.tryPromise(() => openTransactionsThroughCore(page));
  yield* Effect.tryPromise(() =>
    expect(page.getByText("No hay transacciones para mostrar")).toBeVisible()
  );
});

const staleRecoverySessionJourney = Effect.fn(function* (
  configuration: ProviderJourneyConfiguration,
  { page, request }: Pick<ProviderJourney, "page" | "request">
) {
  yield* Effect.tryPromise(() =>
    request.post(
      `${operator}/${configuration.provider}/stale?subject=browser-${configuration.provider}-signup`
    )
  );
  yield* Effect.tryPromise(() => page.goto("/settings/account"));
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Crear un código nuevo" }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByText("Inicia sesión de nuevo", { exact: true })).toBeVisible()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("link", { name: "Iniciar sesión" })).toHaveAttribute(
      "href",
      "/login?resume=account"
    )
  );
  yield* Effect.tryPromise(() => openTransactionsThroughCore(page));
  yield* Effect.tryPromise(() =>
    expect(page.getByText("No hay transacciones para mostrar")).toBeVisible()
  );
});
const expectSignupNotice = Effect.fn(function* (page: Page) {
  yield* Effect.tryPromise(() =>
    expect(
      page.getByText("Fidy usa tus datos para proteger tu cuenta y organizar tus finanzas.", {
        exact: false,
      })
    ).toBeVisible()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("link", { name: "Política de privacidad", exact: true })).toHaveAttribute(
      "href",
      "https://app.fidyapp.com/politica"
    )
  );
});

const completeSignupJourneyMilliseconds = 60_000;
const acknowledgeRecovery = Effect.fn(function* (page: Page) {
  const authenticatedDocument = yield* Effect.tryPromise(() =>
    Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().isNavigationRequest() &&
          new URL(response.url()).pathname === "/app/transactions"
      ),
      page.getByRole("button", { name: "Lo guardé" }).click(),
    ]).then(([response]) => response)
  );
  expect(authenticatedDocument.headers()["cross-origin-opener-policy"]).toBe("same-origin");
});
export const signupJourney = ({
  configuration,
  page,
  context,
  request,
}: ProviderJourney & Readonly<{ configuration: ProviderJourneyConfiguration }>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      playwright.test.setTimeout(completeSignupJourneyMilliseconds);
      yield* Effect.tryPromise(() => installAcceptanceClock(page));
      yield* Effect.tryPromise(() =>
        context.route(configuration.authorizationPattern, (route: Route) =>
          redirectSubject(configuration, `browser-${configuration.provider}-signup`, route)
        )
      );
      yield* Effect.tryPromise(() => page.goto("/login"));
      yield* expectSignupNotice(page);
      yield* Effect.tryPromise(() =>
        page.getByLabel("Acepto el tratamiento de datos descrito").check()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: `Continuar con ${configuration.label}` }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Guarda tu código de recuperación")).toBeVisible()
      );
      expect(
        (yield* Effect.tryPromise(() => context.cookies())).some(
          (cookie) => cookie.name === "__Host-fidy_session"
        )
      ).toBe(false);
      const backupRecoveryCode = yield* Effect.tryPromise(() =>
        page.getByLabel("Código de recuperación", { exact: true }).innerText()
      );
      yield* acknowledgeRecovery(page);
      yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/app\/transactions$/u));
      yield* Effect.tryPromise(() => reloadTransactionsThroughCore(page));
      yield* Effect.tryPromise(() =>
        expect(page.getByText("No hay transacciones para mostrar")).toBeVisible()
      );
      expect(yield* Effect.tryPromise(() => page.evaluate(retainedSecretCount))).toBe(0);
      yield* signupHistoryJourney(configuration, page);
      yield* returningProviderLogin({ configuration, page });
      if (configuration.recoverWithOperator) {
        yield* providerRecoveryJourney({ page, context, request, backupRecoveryCode });
      }
      yield* staleRecoverySessionJourney(configuration, { page, request });
      yield* reauthenticatePATJourney(configuration, { page, request });
      yield* returningSessionPolicies(configuration, { page, context, request });
    })
  );

const retryPendingProvider = Effect.fn(function* (page: Page) {
  const popup = yield* Effect.tryPromise(() =>
    Promise.all([
      page.waitForEvent("popup", { timeout: 5_000 }),
      page.getByRole("button", { name: "Volver a intentar" }).click(),
    ]).then(([opened]) => opened)
  );
  yield* Effect.tryPromise(() =>
    expect(popup.getByText("Pending provider decision")).toBeVisible()
  );
  expect(yield* Effect.tryPromise(() => popup.evaluate(() => window.opener === null))).toBe(true);
  for (const _ of [0, 1]) {
    const status = page.waitForResponse(
      (response) => new URL(response.url()).pathname.endsWith("/status"),
      { timeout: 5_000 }
    );
    yield* Effect.tryPromise(() => advanceAcceptancePoll({ page, milliseconds: 1_000 }));
    yield* Effect.tryPromise(() => status);
  }
  yield* Effect.tryPromise(() => expect(page.getByText("Esperando confirmación…")).toBeVisible());
  return popup;
});
const openProviderEntry = Effect.fn(function* (page: Page) {
  const loginResponse = yield* Effect.tryPromise(() => page.goto("/login"));
  expect(loginResponse?.headers()["cross-origin-opener-policy"]).toBe("same-origin-allow-popups");
  const protectedResponse = yield* Effect.tryPromise(() => page.request.get("/app/transactions"));
  expect(protectedResponse.headers()["cross-origin-opener-policy"]).toBe("same-origin");
});
const expectProviderDenial = Effect.fn(function* (
  page: Page,
  configuration: ProviderJourneyConfiguration
) {
  const deniedPopup = yield* Effect.tryPromise(() =>
    Promise.all([
      page.waitForEvent("popup"),
      page.getByRole("button", { name: `Continuar con ${configuration.label}` }).click(),
    ]).then(([opened]) => opened)
  );
  yield* Effect.tryPromise(() => expect(page.getByRole("alert")).toBeVisible());
  yield* Effect.tryPromise(() => expect.poll(() => deniedPopup.isClosed()).toBe(true));
});
export const denialAndCancellationJourney = ({
  configuration,
  page,
  context,
  intent,
}: ProviderJourney &
  Readonly<{
    configuration: ProviderJourneyConfiguration;
    intent: "signup" | "login";
  }>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installAcceptanceClock(page));
      yield* Effect.tryPromise(() =>
        context.route(configuration.authorizationPattern, (route: Route) =>
          denyProvider(configuration, route)
        )
      );
      yield* openProviderEntry(page);
      yield* expectSignupNotice(page);
      if (intent === "signup") {
        yield* Effect.tryPromise(() =>
          page.getByLabel("Acepto el tratamiento de datos descrito").check()
        );
      } else {
        yield* Effect.tryPromise(() =>
          page.getByRole("button", { name: "Ya tengo cuenta · Iniciar sesión" }).click()
        );
      }
      yield* expectProviderDenial(page, configuration);
      expect(
        (yield* Effect.tryPromise(() => context.cookies())).some(
          (cookie) => cookie.name === "__Host-fidy_session"
        )
      ).toBe(false);
      yield* Effect.tryPromise(() => context.unroute(configuration.authorizationPattern));
      yield* Effect.tryPromise(() =>
        context.route(configuration.authorizationPattern, pendingProvider)
      );
      const closedPopup = yield* retryPendingProvider(page);
      yield* Effect.tryPromise(() => closedPopup.close());
      yield* Effect.tryPromise(() => expect(page.getByText("Cancelaste el acceso.")).toBeVisible());
      yield* retryPendingProvider(page);
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Cancelar" }).click());
      yield* Effect.tryPromise(() => expect(page.getByRole("alert")).toBeVisible());
      expect(page.url()).toContain("/login");
      yield* retryPendingProvider(page);
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("heading", {
            name: intent === "login" ? "Inicia sesión" : "Crea tu cuenta",
          })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Cancelar" }).click());
    })
  );
const denyProvider = (configuration: ProviderJourneyConfiguration, route: Route): Promise<void> => {
  const query = new URL(route.request().url()).searchParams;
  const callback = new URL(`${api}/providers/${configuration.provider}/callback`);
  callback.searchParams.set("state", query.get("state") ?? "");
  callback.searchParams.set("error", "access_denied");
  return route.fulfill({ status: redirectStatus, headers: { location: callback.href } });
};
const pendingProvider = (route: Route): Promise<void> =>
  route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<p>Pending provider decision</p>",
  });

const loseCompletion = (route: Route): Promise<void> =>
  route.fetch().then((response) => {
    expect(response.status()).toBe(successStatus);
    return route.abort("failed");
  });
export const lostCompletionJourney = ({
  configuration,
  page,
  context,
}: ProviderJourney & Readonly<{ configuration: ProviderJourneyConfiguration }>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const subject = `lost-${configuration.provider}-${playwright.test.info().repeatEachIndex}`;
      yield* Effect.tryPromise(() =>
        context.route(configuration.authorizationPattern, (route: Route) =>
          redirectSubject(configuration, subject, route)
        )
      );
      yield* Effect.tryPromise(() =>
        page.route(`**/web/providers/${configuration.provider}/complete`, loseCompletion)
      );
      yield* Effect.tryPromise(() => page.goto("/login"));
      yield* Effect.tryPromise(() =>
        page.getByLabel("Acepto el tratamiento de datos descrito").check()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: `Continuar con ${configuration.label}` }).click()
      );
      yield* Effect.tryPromise(() => expect(page.getByRole("alert")).toBeVisible());
      yield* Effect.tryPromise(() =>
        page.unroute(`**/web/providers/${configuration.provider}/complete`)
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Ir a iniciar sesión" }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: `Continuar con ${configuration.label}` }).click()
      );
      yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/app\/transactions$/u));
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Guarda tu código de recuperación")).toHaveCount(0)
      );
    })
  );
const pendingRedemption = (route: Route): Promise<void> =>
  route.fulfill({
    status: pendingStatus,
    contentType: "application/json",
    body: JSON.stringify({
      status: "pending_approval",
      expiresAt: "2030-01-01T00:00:00.000Z",
      pollingIntervalSeconds: 5,
    }),
  });
export const pendingRedemptionJourney = ({
  configuration,
  page,
  context,
}: ProviderJourney & Readonly<{ configuration: ProviderJourneyConfiguration }>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        context.route(configuration.authorizationPattern, (route: Route) =>
          redirectSubject(configuration, `pending-redemption-${configuration.provider}`, route)
        )
      );
      yield* Effect.tryPromise(() => page.route("**/web/pairings/redeem", pendingRedemption));
      yield* Effect.tryPromise(() => page.goto("/login"));
      yield* Effect.tryPromise(() =>
        page.getByLabel("Acepto el tratamiento de datos descrito").check()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: `Continuar con ${configuration.label}` }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Guarda tu código de recuperación")).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Lo guardé" }).click());
      yield* Effect.tryPromise(() => expect(page.getByRole("alert")).toBeVisible());
      expect(
        (yield* Effect.tryPromise(() => context.cookies())).some(
          (cookie) => cookie.name === "__Host-fidy_session"
        )
      ).toBe(false);
    })
  );

const blockNextPopup = (): void => {
  const originalOpen = window.open;
  window.open = (): ReturnType<typeof originalOpen> => {
    window.open = originalOpen;
    return null;
  };
};
export const blockedPopupJourney = ({
  configuration,
  page,
  context,
}: ProviderJourney & Readonly<{ configuration: ProviderJourneyConfiguration }>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      let authenticationMutations = 0;
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (
          request.method() === "POST" &&
          (path === "/web/pairings" || path.startsWith("/web/providers/"))
        ) {
          authenticationMutations += 1;
        }
      });
      yield* Effect.tryPromise(() =>
        context.route(configuration.authorizationPattern, (route: Route) =>
          redirectSubject(configuration, `blocked-popup-${configuration.provider}`, route)
        )
      );
      yield* Effect.tryPromise(() => page.goto("/login"));
      yield* Effect.tryPromise(() => page.evaluate(blockNextPopup));
      yield* Effect.tryPromise(() =>
        page.getByLabel("Acepto el tratamiento de datos descrito").check()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: `Continuar con ${configuration.label}` }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toHaveText(
          "No se completó el acceso. Puedes iniciar un nuevo intento."
        )
      );
      expect(authenticationMutations).toBe(0);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Volver a intentar" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Guarda tu código de recuperación")).toBeVisible()
      );
    })
  );

const createWebUserForAssociation = (
  input: Readonly<{
    page: Page;
    context: BrowserContext;
    configuration: ProviderJourneyConfiguration;
  }>
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => input.page.goto("/login"));
    yield* Effect.tryPromise(() =>
      input.page.getByLabel("Acepto el tratamiento de datos descrito").check()
    );
    yield* Effect.tryPromise(() =>
      input.page.getByRole("button", { name: `Continuar con ${input.configuration.label}` }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(input.page.getByText("Guarda tu código de recuperación")).toBeVisible()
    );
    yield* Effect.tryPromise(() => input.page.getByRole("button", { name: "Lo guardé" }).click());
    yield* Effect.tryPromise(() => expect(input.page).toHaveURL(/\/app\/transactions$/u));
    yield* Effect.tryPromise(() =>
      input.page.getByRole("button", { name: "Cerrar sesión" }).click()
    );
    yield* Effect.tryPromise(() => expect(input.page).toHaveURL(/\/login$/u));
  });
const confirmBrowserAssociation = ({
  page,
  context,
  request,
  caller,
}: ProviderJourney & Readonly<{ caller: string }>): Effect.Effect<
  void,
  Cause.UnknownError | Schema.SchemaError
> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Identificador de asociación")).toBeVisible()
    );
    const code = yield* Effect.tryPromise(() =>
      page.getByLabel("Identificador de asociación").innerText()
    );
    const reviewResponse = yield* Effect.tryPromise(() =>
      request.post(`${operator}/whatsapp/review?caller=${caller}`)
    );
    expect(reviewResponse.status()).toBe(successStatus);
    const review = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ associationCode: Schema.String, reviewMessageId: Schema.String })
    )(yield* Effect.tryPromise(() => reviewResponse.json()));
    expect(review.associationCode).toBe(code);
    expect(
      (yield* Effect.tryPromise(() => context.cookies())).some(
        (cookie) => cookie.name === "__Host-fidy_session"
      )
    ).toBe(false);
    yield* Effect.tryPromise(() => advanceAcceptancePoll({ page, milliseconds: 1_100 }));
    const confirmation = yield* Effect.tryPromise(() =>
      request.post(
        `${operator}/whatsapp/confirm?caller=${caller}&code=${code}&reply=${review.reviewMessageId}`
      )
    );
    expect(confirmation.status()).toBe(successStatus);
  });
export const whatsappAssociationJourney = ({
  configuration,
  page,
  context,
  request,
  existing,
}: ProviderJourney &
  Readonly<{ existing: boolean; configuration: ProviderJourneyConfiguration }>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const suffix = `${configuration.provider}-${existing ? "existing" : "new"}`;
      yield* Effect.tryPromise(() =>
        context.route(configuration.authorizationPattern, (route) =>
          redirectSubject(configuration, `whatsapp-browser-${suffix}`, route)
        )
      );
      if (existing) yield* createWebUserForAssociation({ page, context, configuration });
      const caller = `CO.Browser${configuration.provider}${existing ? "existing" : "new"}`;
      const start = yield* Effect.tryPromise(() =>
        request.post(`${operator}/whatsapp/start?caller=${caller}`)
      );
      const handoff = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ handoffReference: Schema.String })
      )(yield* Effect.tryPromise(() => start.json()));
      yield* Effect.tryPromise(() => page.goto(`/login?handoff=${handoff.handoffReference}`));
      yield* verifyHandoffEntry({
        page,
        configuration,
        handoffReference: handoff.handoffReference,
      });
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: `Continuar con ${configuration.label}` }).click()
      );
      yield* confirmBrowserAssociation({ page, context, request, caller });
      if (existing) {
        yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/app\/transactions$/u));
        yield* Effect.tryPromise(() =>
          expect(page.getByText("Guarda tu código de recuperación")).toHaveCount(0)
        );
      } else {
        yield* Effect.tryPromise(() =>
          expect(page.getByText("Guarda tu código de recuperación")).toBeVisible()
        );
        yield* Effect.tryPromise(() => page.getByRole("button", { name: "Lo guardé" }).click());
        yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/app\/transactions$/u));
      }
      expect(yield* Effect.tryPromise(() => page.evaluate(retainedSecretCount))).toBe(0);
    })
  );

const verifyRecoveredSecretRotation = Effect.fn(function* (page: Page, backupRecoveryCode: string) {
  yield* Effect.tryPromise(() => page.goto("/settings/account"));
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Crear un código nuevo" }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("button", { name: "Copiar código" })).toBeVisible()
  );
  expect(yield* Effect.tryPromise(() => page.locator("code").innerText())).not.toBe(
    backupRecoveryCode
  );
  yield* Effect.tryPromise(() => page.reload());
  yield* Effect.tryPromise(() => expect(page.locator("code")).toHaveCount(0));
  expect(yield* Effect.tryPromise(() => page.evaluate(retainedSecretCount))).toBe(0);
  yield* Effect.tryPromise(() => openTransactionsThroughCore(page));
});

const providerRecoveryJourney = Effect.fn(function* ({
  page,
  context,
  request,
  backupRecoveryCode,
}: ProviderJourney & Readonly<{ backupRecoveryCode: string }>) {
  const identity = yield* Effect.tryPromise(() =>
    boundSessionRequests(context.request).get(`${api}/user`)
  );
  const before: unknown = yield* Effect.tryPromise(() => identity.json());
  yield* Effect.tryPromise(() => page.getByRole("button", { name: "Cerrar sesión" }).click());
  yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/login$/u));
  const pending = page.waitForResponse(
    (response) =>
      response.url().endsWith("/web/pairings/redeem") && response.status() === pendingStatus
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "WhatsApp o correo verificado" }).click()
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Iniciar sesión en el navegador" }).click()
  );
  const pairingCode = yield* Effect.tryPromise(() => visiblePairingCode(page));
  const pairingPollMilliseconds = 5_000;
  yield* Effect.tryPromise(() =>
    advanceAcceptancePoll({ page, milliseconds: pairingPollMilliseconds })
  );
  yield* Effect.tryPromise(() => pending);
  const assertion = yield* Effect.tryPromise(() =>
    request.get(`${operator}/assertion`).then((response) => response.text())
  );
  const decision = invokeRecoveryOperator({
    assertion,
    pairingCode,
    backupRecoveryCode,
    endpoint: `${api}/internal/support-recovery`,
  });
  const approval = yield* decision;
  expect(approval.exitCode).toBe(0);
  expect(approval.output).toContain("Recuperación aprobada");
  expect(approval.output).not.toContain(backupRecoveryCode);
  expect(approval.output).not.toContain(assertion);
  expect((yield* decision).exitCode).toBe(1);
  yield* Effect.tryPromise(() =>
    advanceAcceptancePoll({ page, milliseconds: pairingPollMilliseconds })
  );
  yield* Effect.tryPromise(() =>
    expect(page).toHaveURL(/\/app\/transactions$/u, { timeout: 15000 })
  );
  const recovered = yield* Effect.tryPromise(() =>
    boundSessionRequests(context.request).get(`${api}/user`)
  );
  expect(yield* Effect.tryPromise(() => recovered.json())).toEqual(before);
  yield* verifyRecoveredSecretRotation(page, backupRecoveryCode);
});

const returningProviderLogin = ({
  configuration,
  page,
}: Readonly<{ configuration: ProviderJourneyConfiguration; page: Page }>): Effect.Effect<
  void,
  Cause.UnknownError
> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => page.getByRole("button", { name: "Cerrar sesión" }).click());
    yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/login$/u));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Ya tengo cuenta · Iniciar sesión" }).click()
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: `Continuar con ${configuration.label}` }).click()
    );
    yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/app\/transactions$/u));
  });

const verifyHandoffEntry = ({
  page,
  configuration,
  handoffReference,
}: Readonly<{
  page: Page;
  configuration: ProviderJourneyConfiguration;
  handoffReference: string;
}>): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    expect(
      yield* Effect.tryPromise(() =>
        page.getByLabel("Acepto el tratamiento de datos descrito").count()
      )
    ).toBe(0);
    expect(page.url()).toContain(`handoff=${handoffReference}`);
    yield* Effect.tryPromise(() =>
      expect(
        page.getByRole("button", {
          name:
            configuration.provider === "google"
              ? "Continuar con Microsoft"
              : "Continuar con Google",
          exact: true,
        })
      ).toBeVisible()
    );
  });

const reauthenticatePATJourney = Effect.fn(function* (
  configuration: ProviderJourneyConfiguration,
  { page, request }: Pick<ProviderJourney, "page" | "request">
) {
  yield* Effect.tryPromise(() =>
    request.post(
      `${operator}/${configuration.provider}/stale?subject=browser-${configuration.provider}-signup`
    )
  );
  yield* Effect.tryPromise(() => page.goto("/settings/access"));
  const tokenName = `Identity confirmation ${configuration.provider}`;
  yield* Effect.tryPromise(() => page.getByLabel("Nombre", { exact: true }).fill(tokenName));
  yield* Effect.tryPromise(() => page.getByRole("checkbox", { name: /^Lectura:/u }).check());
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: /^Duración del token:/u }).click()
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("menuitemradio", { name: "7 días", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Crear token", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Confirmar y crear token" }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByText("Confirma tu identidad", { exact: true })).toBeVisible()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByText("Acceso no autorizado", { exact: true })).toHaveCount(0)
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("heading", { name: "Tokens activos", exact: true })).toBeVisible()
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Confirmar mi identidad" }).click()
  );
  yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/login\?resume=pat$/u));

  yield* Effect.tryPromise(() =>
    expect(page.getByRole("heading", { name: "Confirma tu identidad" })).toBeVisible()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Acepto el tratamiento de datos descrito")).toHaveCount(0)
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: `Continuar con ${configuration.label}` }).click()
  );
  yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/settings\/access\?resume=pat$/u));
  yield* completePATReviewJourney({ page, tokenName });
});

const completePATReviewJourney = Effect.fn(function* ({
  page,
  tokenName,
}: Readonly<{ page: Page; tokenName: string }>) {
  const review = page.getByRole("region", { name: "Revisión del token" });
  yield* Effect.tryPromise(() =>
    expect(review.getByText(tokenName, { exact: true })).toBeVisible()
  );
  yield* Effect.tryPromise(() => expect(review.getByText("7 días", { exact: true })).toBeVisible());
  expect(yield* Effect.tryPromise(() => page.evaluate(retainedSecretCount))).toBe(0);
  yield* Effect.tryPromise(() =>
    expect(page.getByText("Token creado", { exact: true })).toHaveCount(0)
  );
  yield* Effect.tryPromise(() =>
    review.getByRole("button", { name: "Confirmar y crear token" }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByText("Token creado", { exact: true })).toBeVisible()
  );
  const row = page
    .getByRole("table", { name: "Tokens activos" })
    .getByRole("row")
    .filter({ hasText: tokenName });
  yield* Effect.tryPromise(() =>
    row.getByRole("button", { name: "Desactivar", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    row.getByRole("button", { name: "Sí, desactivar", exact: true }).click()
  );
  yield* Effect.tryPromise(() => expect(row).toHaveCount(0));
  yield* Effect.tryPromise(() => openTransactionsThroughCore(page));
});
