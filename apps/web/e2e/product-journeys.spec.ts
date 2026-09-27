import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { apiOrigin, response, user } from "./http-fixtures";

const ok = 200;
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
  trialPeriod: user.trialPeriod,
  paidSubscription: null,
  recentAttempts: [],
};

test("shows expired TrialPeriod standing and the authoritative three Subscription offers", async ({
  page,
}) => {
  const calls: Array<string> = [];
  await page.route(`${apiOrigin}/subscription/status`, (route) => {
    calls.push(route.request().url());
    return route.fulfill({ status: ok, contentType: "application/json", body: response(standing) });
  });
  await page.route(`${apiOrigin}/subscription/offers`, (route) => {
    calls.push(route.request().url());
    return route.fulfill({ status: ok, contentType: "application/json", body: response(offers) });
  });
  await page.goto("/upgrade");
  await expect(page.getByText("Tu acceso: Gratis")).toBeVisible();
  await expect(page.getByRole("button", { name: "Elegir mensual" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Elegir semanal" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Elegir anual" })).toBeVisible();
  expect(calls).toEqual(
    expect.arrayContaining([`${apiOrigin}/subscription/status`, `${apiOrigin}/subscription/offers`])
  );
});

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

const installReusedEnrollment = async (page: Page): Promise<() => unknown> => {
  await page.route(`${apiOrigin}/subscription/status`, (route) =>
    route.fulfill({ status: ok, contentType: "application/json", body: response(standing) })
  );
  await page.route(`${apiOrigin}/subscription/offers`, (route) =>
    route.fulfill({ status: ok, contentType: "application/json", body: response(offers) })
  );
  let submitted: unknown;
  await page.route(`${apiOrigin}/web/subscription/card-enrollments/prepare`, (route) => {
    expect(route.request().postDataJSON()).toEqual({ priceId: offerIds[1] });
    return route.fulfill({
      status: ok,
      contentType: "application/json",
      body: JSON.stringify(prepared),
    });
  });
  await page.route(`${apiOrigin}/web/subscription/card-enrollments/submit`, (route) => {
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
  });
  return () => submitted;
};

test("activates Subscription through reviewed reused-source terms without sending card data to Fidy", async ({
  page,
}) => {
  const submitted = await installReusedEnrollment(page);
  await page.goto("/upgrade");
  await page.getByRole("button", { name: "Elegir mensual" }).click();
  await expect(
    page.getByText("Usaremos de nuevo tu fuente de pago guardada.", { exact: false })
  ).toBeVisible();
  await page.getByLabel(/Acepto el reglamento/iu).check();
  await page.getByLabel(/Autorizo el tratamiento/iu).check();
  await page.getByRole("button", { name: "Activar Pro" }).click();
  await expect(page.getByText("Tu pago fue realizado y tu suscripción está activa.")).toBeVisible();
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
  expect(JSON.stringify(submitted())).not.toContain("cardToken");
});

const widgetId = "24000000-0000-4000-8000-000000000255";
const dashboardView = {
  title: "Mi tablero",
  context: {
    serviceMarket: "CO",
    locale: "es-CO",
    timeZone: "America/Bogota",
    calculatedAt: "2026-09-27T12:00:00.000Z",
  },
  layout: {
    kind: "leaf",
    widget: {
      widget: {
        id: widgetId,
        type: "spending-chart",
        title: "Gastos por categoría",
        groupBy: "category",
        period: "this-month",
      },
      result: {
        appliedPeriod: {
          requested: "this-month",
          from: "2026-09-01T05:00:00.000Z",
          toExclusive: "2026-10-01T05:00:00.000Z",
          timeZone: "America/Bogota",
        },
        buckets: [],
      },
    },
  },
};

test("loads a Dashboard through canonical queries and commits an edited Widget title", async ({
  page,
}) => {
  let view = dashboardView;
  let edit: unknown;
  await page.route(`${apiOrigin}/dashboard/view`, (route) =>
    route.fulfill({ status: ok, contentType: "application/json", body: response(view) })
  );
  await page.route(`${apiOrigin}/dashboard/catalog`, (route) =>
    route.fulfill({ status: ok, contentType: "application/json", body: response([]) })
  );
  await page.route(`${apiOrigin}/dashboard/edits`, async (route) => {
    edit = route.request().postDataJSON();
    view = {
      ...dashboardView,
      layout: {
        ...dashboardView.layout,
        widget: {
          ...dashboardView.layout.widget,
          widget: { ...dashboardView.layout.widget.widget, title: "Gastos visibles" },
        },
      },
    };
    await route.fulfill({
      status: ok,
      contentType: "application/json",
      body: response({
        title: "Mi tablero",
        layout: { kind: "leaf", widget: view.layout.widget.widget },
      }),
    });
  });
  await page.goto("/app/dashboard");
  await expect(page.getByRole("heading", { name: "Tablero" })).toBeVisible();
  await expect(page.getByText("Gastos por categoría").first()).toBeVisible();
  await page.getByRole("button", { name: "Personalizar" }).click();
  await page.getByRole("button", { name: "Renombrar Gastos por categoría" }).click();
  await page.getByRole("textbox", { name: "Nuevo nombre del Widget" }).fill("Gastos visibles");
  await page.getByRole("button", { name: "Guardar nombre del Widget" }).click();
  await expect.poll(() => edit).toBeDefined();
  expect(JSON.stringify(edit)).toContain("Gastos visibles");
});
