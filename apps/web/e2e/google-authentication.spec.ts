import { playwright } from "./playwright-runtime";
import type { APIRequestContext, BrowserContext, Page, Route } from "@playwright/test";
import { type Cause, Effect } from "effect";

const { expect, test } = playwright;
const noContentStatus = 204;
const forbiddenStatus = 403;
const successStatus = 200;

// Provider UI is the only substituted edge; completion and Browser Login run through real Core/D1.
const redirectGoogleSubject = (subject: string, route: Route): Promise<void> => {
  const query = new URL(route.request().url()).searchParams;
  const code = btoa(JSON.stringify({ nonce: query.get("nonce"), subject }));
  const callback = new URL("https://127.0.0.1:4174/providers/google/callback");
  callback.searchParams.set("state", query.get("state") ?? "");
  callback.searchParams.set("code", code);
  return route.fulfill({ status: 302, headers: { location: callback.href } });
};
const googleRedirect = (route: Route): Promise<void> =>
  redirectGoogleSubject("browser-google-signup", route);
const retainedSecretCount = (): number => localStorage.length + sessionStorage.length;
const returningSessionPolicies = ({
  page,
  context,
  request,
}: Readonly<{
  page: Page;
  context: BrowserContext;
  request: APIRequestContext;
}>): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      request.post("http://127.0.0.1:4175/google/expire?subject=browser-google-signup")
    );
    yield* Effect.tryPromise(() => page.reload());
    yield* Effect.tryPromise(() =>
      expect(page.getByText("Sesión vencida", { exact: true })).toBeVisible()
    );
    yield* Effect.tryPromise(() => page.goto("/auth/google"));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Ya tengo cuenta · Iniciar sesión" }).click()
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Continuar con Google" }).click()
    );
    yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/app\/transactions$/u));
    const revocation = yield* Effect.tryPromise(() =>
      request.post("http://127.0.0.1:4175/google/revoke?subject=browser-google-signup")
    );
    expect(revocation.status()).toBe(noContentStatus);
    yield* Effect.tryPromise(() => page.goto("/auth/google"));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Ya tengo cuenta · Iniciar sesión" }).click()
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Continuar con Google" }).click()
    );
    yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/app\/transactions$/u));
    const blocked = yield* Effect.tryPromise(() =>
      context.request.get("https://127.0.0.1:4174/transactions")
    );
    expect(blocked.status()).toBe(forbiddenStatus);
  });
test("creates a User from the public site with Google, saves recovery, and persists the session", ({
  page,
  context,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        context.route("https://accounts.google.com/o/oauth2/v2/auth**", googleRedirect)
      );
      yield* Effect.tryPromise(() => page.goto("/"));
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Empezar con Fidy" }).first().click()
      );
      yield* Effect.tryPromise(() =>
        page.getByLabel("Acepto el tratamiento de datos descrito").check()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Continuar con Google" }).click()
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
      yield* Effect.tryPromise(() => page.goto("/auth/google"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Ya tengo cuenta · Iniciar sesión" }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Continuar con Google" }).click()
      );
      yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/app\/transactions$/u));
      yield* returningSessionPolicies({ page, context, request });
    })
  ));

test("denial and cancellation never claim successful signup or enter the authenticated app", ({
  page,
  context,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        context.route("https://accounts.google.com/o/oauth2/v2/auth**", denyGoogle)
      );
      yield* Effect.tryPromise(() => page.goto("/auth/google"));
      yield* Effect.tryPromise(() =>
        page.getByLabel("Acepto el tratamiento de datos descrito").check()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Continuar con Google" }).click()
      );
      yield* Effect.tryPromise(() => expect(page.getByRole("alert")).toBeVisible());
      expect(
        (yield* Effect.tryPromise(() => context.cookies())).some(
          (cookie) => cookie.name === "__Host-fidy_session"
        )
      ).toBe(false);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Ir a iniciar sesión" }).click()
      );
      yield* Effect.tryPromise(() =>
        context.unroute("https://accounts.google.com/o/oauth2/v2/auth**")
      );
      yield* Effect.tryPromise(() =>
        context.route("https://accounts.google.com/o/oauth2/v2/auth**", pendingGoogle)
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Continuar con Google" }).click()
      );
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Cancelar" }).click());
      yield* Effect.tryPromise(() => expect(page.getByRole("alert")).toBeVisible());
      expect(page.url()).toContain("/auth/google");
    })
  ));
const denyGoogle = (route: Route): Promise<void> => {
  const query = new URL(route.request().url()).searchParams;
  const callback = new URL("https://127.0.0.1:4174/providers/google/callback");
  callback.searchParams.set("state", query.get("state") ?? "");
  callback.searchParams.set("error", "access_denied");
  return route.fulfill({ status: 302, headers: { location: callback.href } });
};
const pendingGoogle = (route: Route): Promise<void> =>
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
test("a lost committed signup response directs sign-in and never rediscloses recovery", ({
  page,
  context,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        context.route("https://accounts.google.com/o/oauth2/v2/auth**", lostSignupGoogle)
      );
      yield* Effect.tryPromise(() =>
        page.route("**/web/providers/google/complete", loseCompletion)
      );
      yield* Effect.tryPromise(() => page.goto("/auth/google"));
      yield* Effect.tryPromise(() =>
        page.getByLabel("Acepto el tratamiento de datos descrito").check()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Continuar con Google" }).click()
      );
      yield* Effect.tryPromise(() => expect(page.getByRole("alert")).toBeVisible());
      yield* Effect.tryPromise(() => page.unroute("**/web/providers/google/complete"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Ir a iniciar sesión" }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Continuar con Google" }).click()
      );
      yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/app\/transactions$/u));
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Guarda tu código de recuperación")).toHaveCount(0)
      );
    })
  ));
const lostSignupGoogle = (route: Route): Promise<void> =>
  redirectGoogleSubject("lost-google-signup", route);
const pendingRedemptionGoogle = (route: Route): Promise<void> =>
  redirectGoogleSubject("pending-redemption-google", route);
const pendingRedemption = (route: Route): Promise<void> =>
  route.fulfill({
    status: 202,
    contentType: "application/json",
    body: JSON.stringify({
      status: "pending_approval",
      expiresAt: "2030-01-01T00:00:00.000Z",
      pollingIntervalSeconds: 5,
    }),
  });
test("pending Browser Login redemption refuses access truthfully instead of remaining stuck", ({
  page,
  context,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        context.route("https://accounts.google.com/o/oauth2/v2/auth**", pendingRedemptionGoogle)
      );
      yield* Effect.tryPromise(() => page.route("**/web/pairings/redeem", pendingRedemption));
      yield* Effect.tryPromise(() => page.goto("/auth/google"));
      yield* Effect.tryPromise(() =>
        page.getByLabel("Acepto el tratamiento de datos descrito").check()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Continuar con Google" }).click()
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
  ));
