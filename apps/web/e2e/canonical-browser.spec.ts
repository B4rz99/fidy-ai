import { expect, test } from "@playwright/test";

const apiOrigin = "https://127.0.0.1:4174";
const user = {
  id: "24000000-0000-4000-8000-000000000241",
  serviceMarket: "CO",
  locale: "es-CO",
  timeZone: "America/Bogota",
  trialPeriod: { startedAt: "2026-08-01T00:00:00Z", endsAt: "2026-08-08T00:00:00Z" },
  createdAt: "2026-08-01T00:00:00Z",
};
const response = (data: unknown): string => JSON.stringify({ data, next: [] });

// Browser-level HTTP fixtures exercise the built app and generated client; platform authority is
// covered separately by the public-ingress integration tests, not simulated in this suite.
test("loads empty Transactions through canonical queries on the separate API origin", async ({
  page,
}) => {
  const requests: Array<string> = [];
  await page.route(`${apiOrigin}/user`, (route) => {
    requests.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "application/json", body: response(user) });
  });
  await page.route(`${apiOrigin}/categories`, (route) => {
    requests.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "application/json", body: response([]) });
  });
  await page.route(new RegExp(`^${apiOrigin}/transactions\\?`, "u"), (route) => {
    requests.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "application/json", body: response([]) });
  });

  await page.goto("/app/transactions");
  await expect(page.getByText("Aún no hay transacciones este mes")).toBeVisible();
  expect(requests).toHaveLength(3);
  expect(requests.every((url) => url.startsWith(apiOrigin))).toBe(true);
});

test("replaces verified email through two canonical operations without putting the proof in a URL", async ({
  page,
}) => {
  const email = "nuevo@example.com";
  const code = "ABCD-EFGH-JKLM-NPQR-STUV-WXYZ";
  const calls: Array<string> = [];
  await page.route(`${apiOrigin}/email/replacement`, async (route) => {
    calls.push(route.request().url());
    expect(route.request().postDataJSON()).toEqual({ candidateEmail: email });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: response({ status: "pending" }),
    });
  });
  await page.route(`${apiOrigin}/web/email/replacement/verify`, async (route) => {
    calls.push(route.request().url());
    expect(route.request().postDataJSON()).toEqual({ combinedCode: code });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: response({ status: "replaced" }),
    });
  });
  await page.goto("/settings/email");
  await page.getByLabel("Nuevo correo").fill(email);
  await page.getByRole("button", { name: "Enviar código" }).click();
  await expect(page.getByText(`Enviamos un código a ${email}.`)).toBeVisible();
  await page.getByLabel("Código de verificación").fill(code);
  await page.getByRole("button", { name: "Cambiar correo" }).click();
  await expect(page.getByText("Tu nuevo correo verificado ya está activo.")).toBeVisible();
  expect(calls).toEqual([
    `${apiOrigin}/email/replacement`,
    `${apiOrigin}/web/email/replacement/verify`,
  ]);
  expect(page.url()).not.toContain(code);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test("an under-scoped Transactions query displays only generic failure copy", async ({ page }) => {
  const secret = "other-user-financial-content";
  await page.route(`${apiOrigin}/user`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: response(user) })
  );
  await page.route(`${apiOrigin}/categories`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: response([]) })
  );
  await page.route(new RegExp(`^${apiOrigin}/transactions\\?`, "u"), (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "scope_missing", message: secret }, next: [] }),
    })
  );
  await page.goto("/app/transactions");
  await expect(page.getByText("No pudimos cargar tus transacciones")).toBeVisible();
  expect(await page.locator("body").textContent()).not.toContain(secret);
});

test("revoked session hides Transactions without showing an internal response body", async ({
  page,
}) => {
  const secret = "internal-session-diagnostics";
  await page.route(`${apiOrigin}/user`, (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unauthenticated", message: secret }, next: [] }),
    })
  );
  await page.goto("/app/transactions");
  await expect(page.getByText("Tu sesión venció. Inicia sesión de nuevo.")).toBeVisible();
  await expect(page.getByText("Aún no hay transacciones este mes")).toHaveCount(0);
  expect(await page.locator("body").textContent()).not.toContain(secret);
});
