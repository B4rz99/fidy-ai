import { playwright } from "./playwright-runtime";
import type { APIRequestContext, BrowserContext, Page, Route } from "@playwright/test";
import { type Cause, Effect } from "effect";

export type ProviderJourneyConfiguration = Readonly<{
  provider: "google" | "microsoft";
  label: string;
  authorizationPattern: string;
  selectFromPublicSite: boolean;
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
        page.getByRole("link", { name: "Empezar con Fidy" }).first().click()
      );
      if (configuration.selectFromPublicSite) {
        yield* Effect.tryPromise(() =>
          page.getByRole("link", { name: configuration.label, exact: true }).click()
        );
      }
      yield* Effect.tryPromise(() =>
        expect(
          page.getByText("Google o Microsoft autentican tu cuenta", { exact: false })
        ).toBeVisible()
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
      expect(
        (yield* Effect.tryPromise(() => context.cookies())).some(
          (cookie) => cookie.name === "__Host-fidy_session"
        )
      ).toBe(false);
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Lo guardé" }).click());
      yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/app\/transactions$/u));
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Aún no hay transacciones este mes")).toBeVisible()
      );
      expect(yield* Effect.tryPromise(() => page.evaluate(retainedSecretCount))).toBe(0);
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Cerrar sesión" }).click());
      yield* Effect.tryPromise(() => page.goto(`/auth/${configuration.provider}`));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Ya tengo cuenta · Iniciar sesión" }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: `Continuar con ${configuration.label}` }).click()
      );
      yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/app\/transactions$/u));
      yield* returningSessionPolicies(configuration, { page, context, request });
    })
  );

export const denialAndCancellationJourney = ({
  configuration,
  page,
  context,
}: ProviderJourney & Readonly<{ configuration: ProviderJourneyConfiguration }>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        context.route(configuration.authorizationPattern, (route: Route) =>
          denyProvider(configuration, route)
        )
      );
      yield* Effect.tryPromise(() => page.goto(`/auth/${configuration.provider}`));
      yield* Effect.tryPromise(() =>
        page.getByLabel("Acepto el tratamiento de datos descrito").check()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: `Continuar con ${configuration.label}` }).click()
      );
      yield* Effect.tryPromise(() => expect(page.getByRole("alert")).toBeVisible());
      expect(
        (yield* Effect.tryPromise(() => context.cookies())).some(
          (cookie) => cookie.name === "__Host-fidy_session"
        )
      ).toBe(false);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Volver a intentar" }).click()
      );
      yield* Effect.tryPromise(() => context.unroute(configuration.authorizationPattern));
      yield* Effect.tryPromise(() =>
        context.route(configuration.authorizationPattern, pendingProvider)
      );
      yield* Effect.tryPromise(() =>
        page.getByLabel("Acepto el tratamiento de datos descrito").check()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: `Continuar con ${configuration.label}` }).click()
      );
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Cancelar" }).click());
      yield* Effect.tryPromise(() => expect(page.getByRole("alert")).toBeVisible());
      expect(page.url()).toContain(`/auth/${configuration.provider}`);
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
      yield* Effect.tryPromise(() =>
        context.route(configuration.authorizationPattern, (route: Route) =>
          redirectSubject(configuration, `lost-${configuration.provider}-signup`, route)
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
