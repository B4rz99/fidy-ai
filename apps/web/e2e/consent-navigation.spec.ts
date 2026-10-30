import type { APIRequestContext, Page, Route, TestInfo } from "@playwright/test";
import { Effect } from "effect";
import { observeConsentRecovery } from "./consent-recovery-diagnostics";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";
import { playwright } from "./playwright-runtime";
import { openUpgradeThroughCore, signInNavigationThroughCore } from "./real-core-fixture";

const { test, expect } = playwright;
const { api } = browserAcceptanceTopology();
const successStatus = 200;

const readConsentOnUnload = (url: string): void =>
  addEventListener(
    "beforeunload",
    () => {
      window.fetch(url, { credentials: "include", keepalive: true }).catch(() => undefined);
    },
    { once: true }
  );

const holdOutgoingRead = (
  page: Page,
  release: Promise<void>
): Promise<Readonly<{ outgoing: Promise<void>; aborted: Promise<void> }>> => {
  const outgoing = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  let first = true;
  return page
    .route(`${api}/web/consent`, (route) => {
      if (!first || route.request().method() !== "GET") return route.continue();
      first = false;
      outgoing.resolve();
      return release.then(() => route.abort("aborted")).then(() => aborted.resolve());
    })
    .then(() => page.evaluate(readConsentOnUnload, `${api}/web/consent`))
    .then(() => ({ outgoing: outgoing.promise, aborted: aborted.promise }));
};

test("Upgrade observes its own Consent response after an outgoing page read is aborted", ({
  page,
  request,
}) => {
  const abortOutgoing = Promise.withResolvers<void>();
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInNavigationThroughCore({ page, request, identity: "navigationConsent" })
      );
      const held = yield* Effect.tryPromise(() => holdOutgoingRead(page, abortOutgoing.promise));
      const current = page.waitForResponse(
        (response) =>
          response.url() === `${api}/web/consent` &&
          response.request().method() === "GET" &&
          response.status() === successStatus
      );
      const upgraded = openUpgradeThroughCore(page).then(
        () => undefined,
        (cause: unknown) => cause
      );
      yield* Effect.tryPromise(() => held.outgoing);
      yield* Effect.tryPromise(() => current);
      abortOutgoing.resolve();
      yield* Effect.tryPromise(() => held.aborted);
      expect(yield* Effect.tryPromise(() => upgraded)).toBeUndefined();
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: /^mensual\b/iu })).toBeVisible()
      );
    }).pipe(Effect.ensuring(Effect.sync(() => abortOutgoing.resolve())))
  );
});

const installConsentPressure = (
  page: Page,
  counts: { reads: number; pairings: number }
): Promise<void> => {
  page.on("request", (incoming) => {
    if (incoming.url() === `${api}/web/pairings` && incoming.method() === "POST") counts.pairings++;
  });
  return page
    .route(`${api}/web/consent`, (route) => {
      counts.reads++;
      return counts.reads === 1
        ? route.fulfill({
            status: 429,
            contentType: "application/json",
            headers: { "retry-after": "1", "access-control-expose-headers": "retry-after" },
            body: JSON.stringify({
              _tag: "ResourceLimited",
              error: {
                code: "rate_limited",
                message: "Try again later.",
                retryAfterSeconds: 1,
              },
              next: [],
            }),
          })
        : route.continue();
    })
    .then(() => undefined);
};

test("Transactions retries an explicitly refused Consent read without replacing its session", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInNavigationThroughCore({ page, request, identity: "navigationConsentRetry" })
      );
      yield* Effect.tryPromise(() => page.goto("/settings/account"));
      const counts = { reads: 0, pairings: 0 };
      yield* Effect.tryPromise(() => installConsentPressure(page, counts));
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Transacciones", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeVisible()
      );
      expect(counts.reads).toBe(2);
      expect(counts.pairings).toBe(0);
    })
  ));

const openReview = Effect.fnUntraced(function* (page: Page) {
  yield* Effect.tryPromise((signal) =>
    page.getByRole("link", { name: /^Por revisar/u }).click({ signal })
  );
  yield* Effect.tryPromise((signal) =>
    expect(page.getByRole("heading", { name: "Por revisar", exact: true })).toBeVisible({ signal })
  );
  yield* Effect.tryPromise((signal) =>
    expect(page.getByRole("button", { name: "Abrir agente Fidy" })).toBeVisible({ signal })
  );
});

const signInForRecovery = Effect.fnUntraced(function* (page: Page, request: APIRequestContext) {
  yield* Effect.tryPromise(() =>
    signInNavigationThroughCore({ page, request, identity: "navigationConsentRecovery" })
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeEnabled()
  );
});

const recheckConsent = Effect.fnUntraced(function* (
  page: Page,
  request: APIRequestContext,
  information: TestInfo
) {
  yield* signInForRecovery(page, request);
  yield* openReview(page);
  const diagnostic = yield* observeConsentRecovery({ page, information });
  const pending = Promise.withResolvers<Route>();
  const holdConsent = (route: Route): void => pending.resolve(route);
  const productRequests: string[] = [];
  page.on("request", (incoming) => {
    const path = new URL(incoming.url()).pathname;
    if (path === "/transactions" || path.startsWith("/web/hosted-turns")) {
      productRequests.push(incoming.method());
    }
  });
  yield* Effect.tryPromise(() => page.route(`${api}/web/consent`, holdConsent));
  yield* Effect.tryPromise((signal) =>
    page.getByRole("link", { name: "Transacciones", exact: true }).click({ signal })
  );
  const consent = yield* Effect.tryPromise(() => pending.promise);
  yield* Effect.tryPromise((signal) =>
    expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toHaveCount(0, {
      signal,
    })
  );
  yield* Effect.tryPromise((signal) =>
    expect(page.getByRole("button", { name: "Abrir agente Fidy" })).toHaveCount(0, { signal })
  );
  const unavailableStatus = 503;
  yield* Effect.tryPromise(() => consent.fulfill({ status: unavailableStatus }));
  yield* Effect.tryPromise((signal) =>
    expect(page.getByText("No pudimos verificar tu acceso a las transacciones.")).toBeVisible({
      signal,
    })
  );
  expect(productRequests).toEqual([]);
  yield* Effect.tryPromise(() => page.unroute(`${api}/web/consent`));
  diagnostic.retry();
  yield* Effect.tryPromise((signal) =>
    page.getByRole("button", { name: "Reintentar", exact: true }).click({ signal })
  );
  yield* Effect.tryPromise((signal) =>
    expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeVisible({
      signal,
    })
  );
  yield* Effect.tryPromise((signal) =>
    expect(page.getByRole("button", { name: "Abrir agente Fidy" })).toBeVisible({ signal })
  );
  yield* openReview(page);
});

test("Transactions rechecks Consent before restoring editing and chat after leaving Review", ({
  page,
  request,
}, information) =>
  Effect.runPromise(recheckConsent(page, request, information).pipe(Effect.scoped)));
