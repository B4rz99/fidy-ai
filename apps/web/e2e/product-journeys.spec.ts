import type { Page, Route } from "@playwright/test";
import { type Cause, Effect, Schema } from "effect";
import { apiOrigin, makeUser, response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";
import { signInThroughCore } from "./real-core-fixture";

const { expect, test } = playwright;

const ok = 200;
test.beforeEach(({ page }) =>
  page.route(`${apiOrigin}/web/consent`, (route) =>
    route.fulfill({
      status: ok,
      contentType: "application/json",
      body: JSON.stringify({ status: "Granted", withdrawal: null }),
    })
  )
);
const installRoute = (
  page: Page,
  url: string,
  handler: (route: Route) => Promise<void>
): Effect.Effect<unknown, Cause.UnknownError> => Effect.tryPromise(() => page.route(url, handler));
const installEnrollmentAvailability = (page: Page): Effect.Effect<unknown, Cause.UnknownError> =>
  installRoute(page, `${apiOrigin}/web/subscription/payment-enrollments/availability`, (route) => {
    expect(route.request().method()).toBe("GET");
    return route.fulfill({
      status: ok,
      contentType: "application/json",
      body: JSON.stringify({ enabledMethods: ["card", "nequi"] }),
    });
  });
const offerIds = [
  "24000000-0000-4000-8000-000000000250",
  "24000000-0000-4000-8000-000000000251",
  "24000000-0000-4000-8000-000000000252",
];
const offers = (["weekly", "monthly", "yearly"] as const).map((billingPeriod, index) => ({
  id: offerIds[index],
  money: { amount: ["9900", "28900", "289900"][index], currency: "COP" },
  billingPeriod,
  serviceMarket: "CO",
  taxTreatment: "not-taxable",
  renewalTerms: {
    automaticRenewal: true,
    renewalReminder: "none",
    cancellation: "future-renewals-only",
    paidAccessEnds: "paid-period-end",
  },
  paymentMethods: ["card", "nequi", "daviplata"],
}));
const standing = {
  accessTier: "free",
  trialPeriod: makeUser().trialPeriod,
  paidSubscription: null,
  recentAttempts: [],
};

test("Upgrade waits for verified Consent and recovers from a failed check without requesting payment data", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => signInThroughCore({ page, request }));
      const unavailable = 503;
      let available = false;
      const paymentRequests: Array<string> = [];
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith("/subscription/") || path.startsWith("/web/subscription/")) {
          paymentRequests.push(path);
        }
      });
      yield* installRoute(page, `${apiOrigin}/web/consent`, (route) =>
        route.fulfill({
          status: available ? ok : unavailable,
          contentType: "application/json",
          body: available ? JSON.stringify({ status: "Granted", withdrawal: null }) : "{}",
        })
      );
      yield* installEnrollmentAvailability(page);
      yield* installRoute(page, `${apiOrigin}/subscription/offers`, (route) =>
        route.fulfill({ status: ok, contentType: "application/json", body: response(offers) })
      );
      yield* installRoute(page, `${apiOrigin}/subscription/status`, (route) =>
        route.fulfill({ status: ok, contentType: "application/json", body: response(standing) })
      );
      yield* Effect.tryPromise(() => page.goto("/upgrade"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toContainText("No pudimos verificar tu autorización")
      );
      expect(paymentRequests).toEqual([]);
      available = true;
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Reintentar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Elegir semanal" })).toBeVisible()
      );
    })
  ));

test("Upgrade requests sign-in when the browser has no session", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const unauthorized = 401;
      yield* installRoute(page, `${apiOrigin}/web/consent`, (route) =>
        route.fulfill({ status: unauthorized })
      );
      yield* Effect.tryPromise(() => page.goto("/upgrade"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toContainText("Inicia sesión para activar Pro")
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("link", { name: "Iniciar sesión", exact: true })).toHaveAttribute(
          "href",
          "/auth/pair"
        )
      );
    })
  ));

test("shows expired TrialPeriod standing and the authoritative three Subscription offers", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const calls: Array<string> = [];
      yield* installEnrollmentAvailability(page);
      yield* installRoute(page, `${apiOrigin}/subscription/status`, (route) => {
        calls.push(route.request().url());
        return route.fulfill({
          status: ok,
          contentType: "application/json",
          body: response(standing),
        });
      });
      yield* installRoute(page, `${apiOrigin}/subscription/offers`, (route) => {
        calls.push(route.request().url());
        return route.fulfill({
          status: ok,
          contentType: "application/json",
          body: response(offers),
        });
      });
      yield* Effect.tryPromise(() => page.goto("/upgrade"));
      yield* Effect.tryPromise(() => expect(page.getByText("Tu acceso: Gratis")).toBeVisible());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Elegir mensual" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Elegir semanal" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Elegir anual" })).toBeVisible()
      );
      expect(calls).toEqual(
        expect.arrayContaining([
          `${apiOrigin}/subscription/status`,
          `${apiOrigin}/subscription/offers`,
        ])
      );
    })
  ));

const sha256HexLength = 64;
const enrollmentId = "24000000-0000-4000-8000-000000000254";
const terms = (
  kind: "end-user-policy" | "personal-data-authorization"
): Readonly<{
  kind: "end-user-policy" | "personal-data-authorization";
  permalink: string;
  displayedText: string;
  contentSha256: string;
  providerContentHash: string;
  observedAt: string;
}> => ({
  kind,
  permalink: `https://wompi.co/${kind}`,
  displayedText: kind,
  contentSha256: "a".repeat(sha256HexLength),
  providerContentHash: "b".repeat(sha256HexLength),
  observedAt: "2026-09-27T00:00:00.000Z",
});
const prepared = {
  status: "prepared",
  method: "card",
  enrollmentId,
  price: offers[1],
  billingEmail: "usuario@example.com",
  paymentSourceMode: "reuse",
  wompiPublicKey: "pub_test_12345678",
  expiresAt: "2099-01-01T00:00:00.000Z",
  contracts: {
    endUserPolicy: terms("end-user-policy"),
    personalDataAuthorization: terms("personal-data-authorization"),
  },
  recurringDisclosure: {
    revision: "wompi-card-enrollment-v1",
    displayedText: "Cobros recurrentes",
    contentSha256: "c".repeat(sha256HexLength),
  },
};

const installReusedEnrollment = (page: Page): Promise<() => unknown> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* installEnrollmentAvailability(page);
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/subscription/status`, (route) =>
          route.fulfill({ status: ok, contentType: "application/json", body: response(standing) })
        )
      );
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/subscription/offers`, (route) =>
          route.fulfill({ status: ok, contentType: "application/json", body: response(offers) })
        )
      );
      let submitted: unknown;
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/web/subscription/payment-enrollments/prepare`, (route) => {
          expect(route.request().postDataJSON()).toEqual({ priceId: offerIds[1], method: "card" });
          return route.fulfill({
            status: ok,
            contentType: "application/json",
            body: JSON.stringify(prepared),
          });
        })
      );
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/web/subscription/payment-enrollments/submit`, (route) => {
          submitted = route.request().postDataJSON();
          return route.fulfill({
            status: ok,
            contentType: "application/json",
            body: JSON.stringify({
              status: "payment-pending",
              enrollmentId,
              billingAttempt: {
                id: "24000000-0000-4000-8000-000000000257",
                priceId: offerIds[1],
                money: offers[1]?.money,
                billingPeriod: "monthly",
                serviceMarket: "CO",
                taxTreatment: "not-taxable",
                timeZone: "America/Bogota",
                createdAt: "2026-09-27T00:00:00.000Z",
                status: "succeeded",
                finalizedAt: "2026-09-27T00:00:01.000Z",
                paidPeriodEndsAt: "2026-10-27T00:00:00.000Z",
                renewalAnchor: "2026-09-27T00:00:00.000Z",
              },
            }),
          });
        })
      );
      return () => submitted;
    })
  );

test("activates Subscription through reviewed reused-source terms without sending card data to Fidy", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const submitted = yield* Effect.tryPromise(() => installReusedEnrollment(page));
      yield* Effect.tryPromise(() => page.goto("/upgrade"));
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Elegir mensual" }).click());
      yield* Effect.tryPromise(() =>
        expect(
          page.getByText("Usaremos de nuevo tu fuente de pago guardada.", { exact: false })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.getByLabel(/Acepto el reglamento/iu).check());
      yield* Effect.tryPromise(() => page.getByLabel(/Autorizo el tratamiento/iu).check());
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Activar Pro" }).click());
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Tu pago fue realizado y tu suscripción está activa.")).toBeVisible()
      );
      expect(submitted()).toMatchObject({
        paymentSourceMode: "reuse",
        enrollmentId,
        billingEmail: "usuario@example.com",
        decisions: {
          acceptedEndUserPolicy: true,
          acceptedPersonalDataAuthorization: true,
          authorizedRecurringCharges: true,
        },
      });
      const submittedJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        submitted()
      );
      expect(submittedJson).not.toContain("cardToken");
    })
  ));
