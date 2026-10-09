import { playwright } from "./playwright-runtime";
import { visiblePairingCode } from "./real-core-fixture";
import { invokeRecoveryOperator } from "../../cli/test/recovery-operator.test-fixture";
import type { APIRequestContext, APIResponse, BrowserContext, Page, Route } from "@playwright/test";
import { type Cause, Clock, Effect, Option, Schema } from "effect";

export type ProviderJourneyConfiguration = Readonly<{
  provider: "google" | "microsoft";
  label: string;
  authorizationPattern: string;
  selectFromPublicSite: boolean;
  recoverWithOperator: boolean;
}>;
type ProviderJourney = Readonly<{
  page: Page;
  context: BrowserContext;
  request: APIRequestContext;
}>;
const { expect } = playwright;
const redirectStatus = 302;
const pendingStatus = 202;
const noContentStatus = 204;
const forbiddenStatus = 403;
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
      // Exercise real Ingress/Core/D1, then replace only the response delivered to the browser.
      let starts = 0;
      yield* Effect.tryPromise(() =>
        page.route("**/web/pairings", (route) => {
          starts += 1;
          return deliverUnavailable(route, false);
        })
      );
      yield* Effect.tryPromise(() => page.goto(`/auth/${configuration.provider}`));
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
      yield* Effect.tryPromise(() => page.goto(`/auth/${configuration.provider}`));
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
      yield* Effect.tryPromise(() => page.goto(`/auth/${configuration.provider}`));
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
      const browserNow = yield* Clock.currentTimeMillis;
      yield* Effect.tryPromise(() => page.clock.pauseAt(browserNow + 100));
      if (outcome === "popup-close") yield* Effect.tryPromise(() => popup.close());
      if (outcome === "cancel") {
        yield* Effect.tryPromise(() => page.getByRole("button", { name: "Cancelar" }).click());
      }
      // The web-auth transport deadline is ten seconds, even while a status body is withheld.
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

// Provider UI is the only substituted edge; completion and Browser Login run through real Core/D1.
const redirectSubject = (
  configuration: ProviderJourneyConfiguration,
  subject: string,
  route: Route
): Promise<void> => {
  const query = new URL(route.request().url()).searchParams;
  const code = btoa(JSON.stringify({ nonce: query.get("nonce"), subject }));
  const callback = new URL(`https://127.0.0.1:4174/providers/${configuration.provider}/callback`);
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
        `http://127.0.0.1:4175/${configuration.provider}/expire?subject=browser-${configuration.provider}-signup`
      )
    );
    yield* Effect.tryPromise(() => page.reload());
    yield* Effect.tryPromise(() =>
      expect(page.getByText("Sesión vencida", { exact: true })).toBeVisible()
    );
    yield* Effect.tryPromise(() => page.goto(`/auth/${configuration.provider}`));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Ya tengo cuenta · Iniciar sesión" }).click()
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: `Continuar con ${configuration.label}` }).click()
    );
    yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/app\/transactions$/u));
    const revocation = yield* Effect.tryPromise(() =>
      request.post(
        `http://127.0.0.1:4175/${configuration.provider}/revoke?subject=browser-${configuration.provider}-signup`
      )
    );
    expect(revocation.status()).toBe(noContentStatus);
    yield* Effect.tryPromise(() => page.goto(`/auth/${configuration.provider}`));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Ya tengo cuenta · Iniciar sesión" }).click()
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: `Continuar con ${configuration.label}` }).click()
    );
    yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/app\/transactions$/u));
    const blocked = yield* Effect.tryPromise(() =>
      context.request.get("https://127.0.0.1:4174/transactions")
    );
    expect(blocked.status()).toBe(forbiddenStatus);
  });
const signupHistoryJourney = Effect.fn(function* (
  configuration: ProviderJourneyConfiguration,
  page: Page
) {
  yield* Effect.tryPromise(() => page.goBack());
  yield* Effect.tryPromise(() =>
    expect(page).toHaveURL(new RegExp(`/auth/${configuration.provider}$`, "u"))
  );
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
  yield* Effect.tryPromise(() => page.goto("/app/transactions"));
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
      `http://127.0.0.1:4175/${configuration.provider}/stale?subject=browser-${configuration.provider}-signup`
    )
  );
  yield* Effect.tryPromise(() => page.goto("/settings/recovery"));
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Crear un código nuevo" }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByText("Inicia sesión de nuevo", { exact: true })).toBeVisible()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("link", { name: "Iniciar sesión" })).toHaveAttribute(
      "href",
      "/auth/google"
    )
  );
  yield* Effect.tryPromise(() => page.goto("/app/transactions"));
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
      yield* Effect.tryPromise(() =>
        context.route(configuration.authorizationPattern, (route: Route) =>
          redirectSubject(configuration, `browser-${configuration.provider}-signup`, route)
        )
      );
      yield* Effect.tryPromise(() => page.goto("/"));
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Crear mi cuenta" }).first().click()
      );
      if (configuration.selectFromPublicSite) {
        yield* Effect.tryPromise(() =>
          page.getByRole("link", { name: configuration.label, exact: true }).click()
        );
      }
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
      yield* Effect.tryPromise(() => page.reload());
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
    yield* Effect.tryPromise(() =>
      page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/status"), {
        timeout: 5_000,
      })
    );
  }
  yield* Effect.tryPromise(() => expect(page.getByText("Esperando confirmación…")).toBeVisible());
  return popup;
});
const openProviderEntry = Effect.fn(function* (
  configuration: ProviderJourneyConfiguration,
  page: Page
) {
  const loginResponse = yield* Effect.tryPromise(() =>
    page.goto(`/auth/${configuration.provider}`)
  );
  expect(loginResponse?.headers()["cross-origin-opener-policy"]).toBe("same-origin-allow-popups");
  const protectedResponse = yield* Effect.tryPromise(() => page.request.get("/app/transactions"));
  expect(protectedResponse.headers()["cross-origin-opener-policy"]).toBe("same-origin");
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
      yield* Effect.tryPromise(() =>
        context.route(configuration.authorizationPattern, (route: Route) =>
          denyProvider(configuration, route)
        )
      );
      yield* openProviderEntry(configuration, page);
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
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: `Continuar con ${configuration.label}` }).click()
      );
      yield* Effect.tryPromise(() => expect(page.getByRole("alert")).toBeVisible());
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
      expect(page.url()).toContain(`/auth/${configuration.provider}`);
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
  const callback = new URL(`https://127.0.0.1:4174/providers/${configuration.provider}/callback`);
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
      yield* Effect.tryPromise(() => page.goto(`/auth/${configuration.provider}`));
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
      yield* Effect.tryPromise(() => page.goto(`/auth/${configuration.provider}`));
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
      yield* Effect.tryPromise(() => page.goto(`/auth/${configuration.provider}`));
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
    yield* Effect.tryPromise(() => input.page.goto(`/auth/${input.configuration.provider}`));
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
    yield* Effect.tryPromise(() => expect(input.page).toHaveURL(/\/auth\/pair$/u));
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
      request.post(`http://127.0.0.1:4175/whatsapp/review?caller=${caller}`)
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
    yield* Effect.sleep("1100 millis");
    const confirmation = yield* Effect.tryPromise(() =>
      request.post(
        `http://127.0.0.1:4175/whatsapp/confirm?caller=${caller}&code=${code}&reply=${review.reviewMessageId}`
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
        request.post(`http://127.0.0.1:4175/whatsapp/start?caller=${caller}`)
      );
      const handoff = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ handoffReference: Schema.String })
      )(yield* Effect.tryPromise(() => start.json()));
      yield* Effect.tryPromise(() =>
        page.goto(`/auth/${configuration.provider}?handoff=${handoff.handoffReference}`)
      );
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

/** Recovery uses the pre-issued proof without calling either provider or requiring a mailbox. */
const providerRecoveryJourney = Effect.fn(function* ({
  page,
  context,
  request,
  backupRecoveryCode,
}: ProviderJourney & Readonly<{ backupRecoveryCode: string }>) {
  const identity = yield* Effect.tryPromise(() =>
    context.request.get("https://127.0.0.1:4174/user")
  );
  const before: unknown = yield* Effect.tryPromise(() => identity.json());
  yield* Effect.tryPromise(() => page.getByRole("button", { name: "Cerrar sesión" }).click());
  const pending = page.waitForResponse(
    (response) =>
      response.url().endsWith("/web/pairings/redeem") && response.status() === pendingStatus
  );
  yield* Effect.tryPromise(() => page.goto("/auth/pair"));
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Iniciar sesión en el navegador" }).click()
  );
  const pairingCode = yield* Effect.tryPromise(() => visiblePairingCode(page));
  yield* Effect.tryPromise(() => pending);
  const assertion = yield* Effect.tryPromise(() =>
    request.get("http://127.0.0.1:4175/assertion").then((response) => response.text())
  );
  const decision = invokeRecoveryOperator({ assertion, pairingCode, backupRecoveryCode });
  const approval = yield* decision;
  expect(approval.exitCode).toBe(0);
  expect(approval.output).toContain("Recuperación aprobada");
  expect(approval.output).not.toContain(backupRecoveryCode);
  expect(approval.output).not.toContain(assertion);
  expect((yield* decision).exitCode).toBe(1);
  yield* Effect.tryPromise(() =>
    expect(page).toHaveURL(/\/app\/transactions$/u, { timeout: 15000 })
  );
  const recovered = yield* Effect.tryPromise(() =>
    context.request.get("https://127.0.0.1:4174/user")
  );
  expect(yield* Effect.tryPromise(() => recovered.json())).toEqual(before);
  yield* Effect.tryPromise(() => page.goto("/settings/recovery"));
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
  yield* Effect.tryPromise(() => page.goto("/app/transactions"));
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
    yield* Effect.tryPromise(() => page.goto(`/auth/${configuration.provider}`));
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
    expect(
      yield* Effect.tryPromise(() =>
        page
          .getByRole("link", {
            name: configuration.provider === "google" ? "Microsoft" : "Google",
            exact: true,
          })
          .getAttribute("href")
      )
    ).toContain(`handoff=${handoffReference}`);
  });
