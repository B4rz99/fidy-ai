import type { Page } from "@playwright/test";
import { Effect } from "effect";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";
import { playwright } from "./playwright-runtime";
import {
  openTransactionsThroughCore,
  openUpgradeThroughCore,
  signInNavigationThroughCore,
} from "./real-core-fixture";

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
        expect(page.getByRole("button", { name: "Elegir mensual" })).toBeVisible()
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
            headers: { "retry-after": "1" },
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
        signInNavigationThroughCore({ page, request, identity: "navigationConsent" })
      );
      yield* Effect.tryPromise(() => page.goto("/settings/account"));
      const counts = { reads: 0, pairings: 0 };
      yield* Effect.tryPromise(() => installConsentPressure(page, counts));
      yield* Effect.tryPromise(() => openTransactionsThroughCore(page));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeVisible()
      );
      expect(counts.reads).toBe(2);
      expect(counts.pairings).toBe(0);
    })
  ));
