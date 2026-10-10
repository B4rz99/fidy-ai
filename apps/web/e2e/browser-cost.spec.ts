import type { APIRequestContext, Page } from "@playwright/test";
import { type Cause, Config, Effect, Schema } from "effect";
import { playwright } from "./playwright-runtime";
import { signInThroughCore, visiblePairingCode } from "./real-core-fixture";

const { test, expect } = playwright;
test.skip(
  Effect.runSync(Config.String("BROWSER_COST_MEASUREMENT").pipe(Config.withDefault("0"))) !== "1",
  "Opt-in local resource investigation"
);
test.describe.configure({ mode: "serial" });
const measurementTimeoutMilliseconds = 300_000;
test.setTimeout(measurementTimeoutMilliseconds);
const api = "https://127.0.0.1:4174";
const operator = "http://127.0.0.1:4175";
const Cost = Schema.Struct({ rowsRead: Schema.Int, rowsWritten: Schema.Int });
const cancelledWindowMilliseconds = 20_000;
const observationWindowMilliseconds = 60_000;
const pendingStatus = 202;
const successStatus = 200;
const noContentStatus = 204;
const forbiddenStatus = 403;
const wait = <A>(promise: Promise<A>): Effect.Effect<A, Cause.UnknownError> =>
  Effect.tryPromise(() => promise);
const snapshot = (
  request: APIRequestContext
): Effect.Effect<typeof Cost.Type, Cause.UnknownError | Schema.SchemaError> =>
  wait(request.get(`${operator}/browser-cost`)).pipe(
    Effect.flatMap((reply) => wait(reply.json())),
    Effect.flatMap(Schema.decodeUnknownEffect(Cost))
  );

// Only method, normalized route, status and row counters leave the fixture.
type RequestObserver = Readonly<{
  count: () => number;
  report: (scenario: string, before: typeof Cost.Type, after: typeof Cost.Type) => void;
}>;
const observeRequests = (page: Page): RequestObserver => {
  const counts = new Map<string, number>();
  const attempts = new Map<string, number>();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== api || request.method() === "OPTIONS") return;
    const path = url.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gu, ":id");
    const key = `${request.method()} ${path}`;
    attempts.set(key, (attempts.get(key) ?? 0) + 1);
  });
  page.on("response", (reply) => {
    const url = new URL(reply.url());
    if (url.origin !== api || reply.request().method() === "OPTIONS") return;
    expect(reply.headers()["cache-control"]).toContain("no-store");
    const path = url.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gu, ":id");
    const key = `${reply.request().method()} ${path} ${reply.status()}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return {
    count: (): number => Array.from(attempts.values()).reduce((sum, count) => sum + count, 0),
    report: (scenario, before, after): void => {
      process.stdout.write(
        `BROWSER_COST ${JSON.stringify({
          scenario,
          attempts: Object.fromEntries(attempts),
          requests: Object.fromEntries(counts),
          rowsRead: after.rowsRead - before.rowsRead,
          rowsWritten: after.rowsWritten - before.rowsWritten,
        })}\n`
      );
      counts.clear();
      attempts.clear();
    },
  };
};

const setVisibility = (page: Page, hidden: boolean): Effect.Effect<void, Cause.UnknownError> =>
  wait(
    page.evaluate((value) => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => (value ? "hidden" : "visible"),
      });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden)
  );

test("measures pending provider status, hidden continuation and cancellation", ({
  page,
  context,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(
        context.route("https://accounts.google.com/**", (route) =>
          route.fulfill({ contentType: "text/html", body: "Synthetic pending provider" })
        )
      );
      expect(
        (yield* wait(
          request.get(`${operator}/browser-cost`, { headers: { origin: api } })
        )).status()
      ).toBe(forbiddenStatus);
      yield* wait(page.goto("/auth/google"));
      yield* wait(page.getByLabel("Acepto el tratamiento de datos descrito").check());
      const observed = observeRequests(page);
      const before = yield* snapshot(request);
      yield* wait(page.getByRole("button", { name: "Continuar con Google" }).click());
      for (let index = 0; index < 4; index += 1) {
        yield* wait(page.waitForResponse("**/web/providers/google/status"));
      }
      observed.report("provider-start-and-four-status", before, yield* snapshot(request));
      yield* setVisibility(page, true);
      const hiddenBefore = yield* snapshot(request);
      for (let index = 0; index < 3; index += 1) {
        yield* wait(page.waitForResponse("**/web/providers/google/status"));
      }
      observed.report("provider-hidden-three-status", hiddenBefore, yield* snapshot(request));
      yield* setVisibility(page, false);
      yield* wait(page.getByRole("button", { name: "Cancelar", exact: true }).click());
      const cancelledBefore = yield* snapshot(request);
      yield* wait(page.clock.install());
      yield* wait(page.clock.runFor(cancelledWindowMilliseconds));
      expect(observed.count()).toBe(0);
      observed.report("provider-cancelled-20s", cancelledBefore, yield* snapshot(request));
    })
  ));

test("measures advertised pairing cadence and route unmount", ({ page, request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(page.goto("/auth/pair"));
      const observed = observeRequests(page);
      const before = yield* snapshot(request);
      yield* wait(page.getByRole("button", { name: "Iniciar sesión en el navegador" }).click());
      yield* wait(visiblePairingCode(page));
      for (let index = 0; index < 2; index += 1) {
        const reply = yield* wait(page.waitForResponse("**/web/pairings/redeem"));
        expect(reply.status()).toBe(pendingStatus);
      }
      observed.report("ordinary-start-and-two-pending-polls", before, yield* snapshot(request));
      yield* wait(page.goto("/"));
      const unmountedBefore = yield* snapshot(request);
      yield* wait(page.clock.install());
      yield* wait(page.clock.runFor(cancelledWindowMilliseconds));
      expect(observed.count()).toBe(0);
      observed.report("ordinary-after-route-unmount", unmountedBefore, yield* snapshot(request));
    })
  ));

const measureNavigation = Effect.fn(function* (
  page: Page,
  request: APIRequestContext,
  observed: RequestObserver
) {
  const navigationBefore = yield* snapshot(request);
  for (let index = 0; index < 3; index += 1) {
    yield* wait(page.goto("/upgrade"));
    yield* wait(expect(page.getByRole("button", { name: "Elegir mensual" })).toBeVisible());
    yield* wait(page.waitForLoadState("networkidle"));
    yield* wait(page.goto("/app/transactions"));
    yield* wait(
      expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeVisible()
    );
  }
  yield* wait(page.waitForLoadState("networkidle"));
  observed.report(
    "three-document-navigation-round-trips",
    navigationBefore,
    yield* snapshot(request)
  );
  const routeBefore = yield* snapshot(request);
  yield* wait(page.getByText("Ajustes", { exact: true }).first().click());
  for (let index = 0; index < 3; index += 1) {
    yield* wait(page.getByRole("link", { name: "Correo", exact: true }).first().click());
    yield* wait(expect(page).toHaveURL(/\/settings\/email$/u));
    yield* wait(page.getByRole("link", { name: "Transacciones", exact: true }).first().click());
    yield* wait(
      expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeVisible()
    );
  }
  yield* wait(page.waitForLoadState("networkidle"));
  observed.report("three-spa-navigation-round-trips", routeBefore, yield* snapshot(request));
});

const measureSettlement = Effect.fn(function* (
  page: Page,
  request: APIRequestContext,
  observed: RequestObserver
) {
  yield* setVisibility(page, true);
  const hiddenBefore = yield* snapshot(request);
  yield* wait(page.clock.install());
  yield* wait(page.clock.runFor(observationWindowMilliseconds));
  expect(observed.count()).toBe(0);
  observed.report("payment-hidden-60s", hiddenBefore, yield* snapshot(request));
  expect((yield* wait(request.post(`${operator}/billing/collect`))).status()).toBe(noContentStatus);
  const resumedBefore = yield* snapshot(request);
  const settled = page.waitForResponse("**/web/subscription/billing-attempts/*");
  yield* setVisibility(page, false);
  yield* wait(settled);
  yield* wait(page.clock.runFor(observationWindowMilliseconds));
  expect(observed.count()).toBe(1);
  observed.report(
    "payment-resumed-settlement-and-terminal-60s",
    resumedBefore,
    yield* snapshot(request)
  );
  const navigationBefore = yield* snapshot(request);
  yield* wait(page.goto("/app/transactions"));
  yield* wait(expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeVisible());
  yield* wait(page.waitForLoadState("networkidle"));
  observed.report("navigation-before-logout", navigationBefore, yield* snapshot(request));
  const logoutBefore = yield* snapshot(request);
  const logout = page.waitForResponse("**/web/session/logout");
  yield* wait(page.getByRole("button", { name: "Cerrar sesión" }).click());
  yield* wait(logout);
  observed.report("logout", logoutBefore, yield* snapshot(request));
  const replacedBefore = yield* snapshot(request);
  yield* wait(page.clock.runFor(observationWindowMilliseconds));
  expect(observed.count()).toBe(0);
  observed.report("authentication-replaced-60s", replacedBefore, yield* snapshot(request));
});

test("measures authenticated navigation, pending payment, visibility and settlement", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* wait(signInThroughCore({ page, request }));
      yield* wait(
        expect(page.getByRole("button", { name: "+ Registrar", exact: true })).toBeVisible()
      );
      yield* wait(page.clock.resume());
      const observed = observeRequests(page);
      yield* measureNavigation(page, request, observed);
      const paymentSetupBefore = yield* snapshot(request);
      yield* wait(page.goto("/upgrade"));
      yield* wait(page.getByRole("button", { name: "Elegir mensual" }).click());
      yield* wait(page.getByLabel(/Acepto el reglamento/iu).check());
      yield* wait(page.getByLabel(/Autorizo el tratamiento/iu).check());
      const submitting = page.waitForResponse("**/web/subscription/payment-enrollments/submit");
      yield* wait(page.getByRole("button", { name: "Activar Pro" }).click());
      expect((yield* wait(submitting)).status()).toBe(successStatus);
      // Finish setup responses before starting the marginal polling window.
      yield* wait(page.waitForResponse("**/web/subscription/billing-attempts/*"));
      observed.report("payment-setup-and-first-poll", paymentSetupBefore, yield* snapshot(request));
      const pendingBefore = yield* snapshot(request);
      for (let index = 0; index < 2; index += 1) {
        yield* wait(page.waitForResponse("**/web/subscription/billing-attempts/*"));
      }
      observed.report("payment-two-pending-polls", pendingBefore, yield* snapshot(request));
      yield* measureSettlement(page, request, observed);
    })
  ));
