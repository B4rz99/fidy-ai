import { Clock, Effect } from "effect";
import type { Scope } from "effect";
import { chromium } from "@playwright/test";
import type { Browser, BrowserContext, Page, Route } from "@playwright/test";
import { approvePairing, attempt, requireCheck } from "./production-fixture";
import type { ApprovedScope, VerificationFailure } from "./production-fixture";

const NO_CONTENT = 204;
const REDIRECT = 302;
const OAUTH_START_TIMEOUT_MS = 30_000;
const CALLBACK = /http:\/\/(?:127\.0\.0\.1|localhost):\d+\/callback\?/u;
export const productionBrowser = Effect.acquireRelease(
  attempt("Cannot start verification browser", () => chromium.launch({ headless: true })),
  (browser) =>
    attempt("Cannot close verification browser", () => browser.close()).pipe(Effect.orDie)
);
const browserContext = (
  browser: Browser
): Effect.Effect<BrowserContext, VerificationFailure, Scope.Scope> =>
  Effect.acquireRelease(
    attempt("Cannot create isolated browser", () => browser.newContext()),
    (context) => attempt("Cannot close isolated browser", () => context.close()).pipe(Effect.orDie)
  );
const login = Effect.fn(function* (scope: ApprovedScope, page: Page) {
  yield* attempt("Browser sign-in button unavailable", () =>
    page.getByRole("button", { name: "Iniciar sesión en el navegador" }).click()
  );
  const pairing = page.locator('[aria-label^="Código de vinculación "]');
  yield* attempt("Browser pairing did not start", () => pairing.waitFor());
  const label = yield* attempt("Cannot read synthetic pairing code", () =>
    pairing.getAttribute("aria-label")
  );
  yield* approvePairing(scope, (label ?? "").replace("Código de vinculación ", ""));
});
const logout = (context: BrowserContext): Effect.Effect<void, VerificationFailure> =>
  attempt("Synthetic browser logout failed", () =>
    context.request.post("https://api.fidyapp.com/web/session/logout", {
      headers: { origin: "https://app.fidyapp.com" },
    })
  ).pipe(
    Effect.flatMap((response) =>
      requireCheck(response.status() === NO_CONTENT, "Synthetic browser logout refused")
    )
  );
const authorizationUrl = Effect.fn(function* (root: string, host: string) {
  const path = `${root}/${host}-authorize-url.txt`;
  const started = yield* Clock.currentTimeMillis;
  while (
    !(yield* attempt("Cannot read native authorization state", () => Bun.file(path).exists()))
  ) {
    const now = yield* Clock.currentTimeMillis;
    yield* requireCheck(
      now - started < OAUTH_START_TIMEOUT_MS,
      "Native client did not start OAuth"
    );
    yield* Effect.sleep("100 millis");
  }
  const value = yield* attempt("Cannot read native authorization URL", () => Bun.file(path).text());
  const url = yield* attempt("Native OAuth URL invalid", () => Promise.resolve(new URL(value)));
  yield* requireCheck(
    url.origin === "https://api.fidyapp.com" && url.pathname === "/oauth/authorize",
    "Unexpected native OAuth issuer"
  );
  return url;
});
const startApproval = Effect.fn(function* (context: BrowserContext, page: Page, url: URL) {
  const response = yield* attempt("OAuth authorization start failed", () =>
    context.request.get(url.href, { maxRedirects: 0 })
  );
  yield* requireCheck(response.status() === REDIRECT, "OAuth authorization start refused");
  const target = new URL(response.headers().location ?? "", "https://app.fidyapp.com");
  yield* requireCheck(
    target.origin === "https://app.fidyapp.com",
    "Unexpected OAuth approval destination"
  );
  yield* attempt("OAuth browser sign-in failed", () => page.goto(target.href));
  yield* attempt("Browser sign-in link unavailable", () =>
    page.getByRole("link", { name: "Iniciar sesión", exact: true }).click()
  );
  return target;
});
const captureCallback =
  (path: string) =>
  (route: Route): Promise<void> =>
    Bun.write(path, route.request().url()).then(() =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<p>Disposable callback returned</p>",
      })
    );
const finishApproval = Effect.fn(function* (page: Page, target: URL, callbackPath: string) {
  yield* attempt("OAuth browser approval did not load", () =>
    page.waitForURL(target.href, { timeout: 20_000 })
  );
  yield* attempt("OAuth approval form unavailable", () =>
    page.getByRole("heading", { name: "Conectar con Fidy", exact: true }).waitFor()
  );
  const boxes = page.getByRole("checkbox");
  yield* requireCheck(
    (yield* attempt("Cannot inspect requested permissions", () => boxes.count())) === 3,
    "Expected read, write and dashboard permission choices"
  );
  yield* attempt("Cannot narrow OAuth permission", () => boxes.nth(2).uncheck());
  yield* attempt("Cannot choose seven-day grant", () =>
    page.getByRole("button", { name: "7 días", exact: true }).click()
  );
  yield* attempt("Cannot capture disposable OAuth callback", () =>
    page.route(CALLBACK, captureCallback(callbackPath))
  );
  yield* attempt("OAuth approval failed", () =>
    page.getByRole("button", { name: "Conectar", exact: true }).click()
  );
  yield* attempt("Native OAuth callback missing", () =>
    page.waitForURL(CALLBACK, { timeout: 15_000 })
  );
  yield* requireCheck(
    new URL(page.url()).searchParams.get("iss") === "https://api.fidyapp.com",
    "Native callback issuer mismatch"
  );
});
type Approval = {
  readonly scope: ApprovedScope;
  readonly browser: Browser;
  readonly root: string;
  readonly host: string;
};
const approve = Effect.fn(function* (options: Approval, context: BrowserContext) {
  const url = yield* authorizationUrl(options.root, options.host);
  const page = yield* attempt("Cannot open verification page", () => context.newPage());
  const target = yield* startApproval(context, page, url);
  yield* login(options.scope, page);
  yield* finishApproval(page, target, `${options.root}/${options.host}-callback-url.txt`);
});
export const approveNativeLogin = Effect.fn(function* (options: Approval) {
  yield* Effect.scoped(
    Effect.gen(function* () {
      const context = yield* browserContext(options.browser);
      yield* approve(options, context).pipe(Effect.ensuring(logout(context).pipe(Effect.orDie)));
    })
  );
});
const revoke = Effect.fn(function* (scope: ApprovedScope, context: BrowserContext) {
  const page = yield* attempt("Cannot open revocation page", () => context.newPage());
  yield* attempt("Cannot open first-party sign-in", () =>
    page.goto("https://app.fidyapp.com/auth/pair")
  );
  yield* login(scope, page);
  yield* attempt("Fresh synthetic browser login failed", () =>
    page.waitForURL(/\/app\/transactions$/u, { timeout: 20_000 })
  );
  yield* attempt("Cannot open connected agents", () =>
    page.goto("https://app.fidyapp.com/settings/agents")
  );
  yield* attempt("Cannot revoke synthetic agents", () =>
    page.getByRole("button", { name: "Revocar todos los agentes conectados" }).click()
  );
  yield* attempt("Revocation did not complete", () =>
    page.getByRole("status").filter({ hasText: "Acceso revocado" }).waitFor()
  );
});
export const revokeConnections = Effect.fn(function* (scope: ApprovedScope, browser: Browser) {
  yield* Effect.scoped(
    Effect.gen(function* () {
      const context = yield* browserContext(browser);
      yield* revoke(scope, context).pipe(Effect.ensuring(logout(context).pipe(Effect.orDie)));
    })
  );
});
