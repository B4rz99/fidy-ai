import { expect, test } from "@playwright/test";
import { Effect, Schema } from "effect";
import { signInThroughCore, visiblePairingCode } from "./real-core-fixture";

const api = "https://127.0.0.1:4174";
const ok = 200;
const forbidden = 403;
const unauthorized = 401;
const noContent = 204;
const notFound = 404;

test("reviews a real PATPairing and presents its under-scoped Core refusal without leaking details", async ({
  page,
  request,
}) => {
  await signInThroughCore({ page, request });
  const started = await request.post(`${api}/pat-pairings`, {
    data: { recipientLabel: "Agente emparejado", scopes: ["write"], lifetimeDays: 30 },
  });
  expect(started.status()).toBe(ok);
  const { pairingId, publicCode, privateDeviceCode } = Schema.decodeUnknownSync(
    Schema.Struct({
      pairingId: Schema.String,
      publicCode: Schema.String,
      privateDeviceCode: Schema.String,
    })
  )(await started.json());
  await page.goto("/settings/pats");
  await page.getByLabel("Código", { exact: true }).fill(publicCode.toLowerCase());
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByText("Agente emparejado").first()).toBeVisible();
  await page.getByRole("button", { name: "Autorizar acceso" }).click();
  await expect(page.getByText("Acceso autorizado")).toBeVisible();
  expect(await page.locator("body").textContent()).not.toContain(privateDeviceCode);
  const claimed = await request.post(`${api}/pat-pairings/claim`, {
    data: { pairingId, privateDeviceCode },
  });
  expect(claimed.status()).toBe(ok);
  const { bearer } = Schema.decodeUnknownSync(Schema.Struct({ bearer: Schema.String }))(
    await claimed.json()
  );
  expect(bearer).toMatch(/^fin_/u);
  expect(await page.locator("body").textContent()).not.toContain(bearer);
  const refused = await request.get(`${api}/transactions`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  expect(refused.status()).toBe(forbidden);
  await page.route(`${api}/transactions?*`, (route) => route.fulfill({ response: refused }));
  await page.goto("/app/transactions");
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await page.locator("body").textContent()).not.toContain(bearer);
  expect(await page.locator("body").textContent()).not.toContain(await refused.text());
});

test("a browser cannot render or fetch another User's private Transaction through public routes", async ({
  page,
  request,
}) => {
  await signInThroughCore({ page, request });
  await page.goto("/app/transactions");
  const refusal = await page.evaluate(async (url) => {
    // @effect-diagnostics-next-line globalFetch:off
    const response = await fetch(url, { credentials: "include" });
    return { status: response.status, body: await response.text() };
  }, `${api}/transactions/24000000-0000-4000-8000-000000000262`);
  expect(refusal.status).toBe(notFound);
  expect(refusal.body).not.toContain("OTHER-USER-PRIVATE");
  expect(await page.locator("body").textContent()).not.toContain("OTHER-USER-PRIVATE");
});

test("renders loading until the real Core answers Transactions", async ({ page, request }) => {
  await signInThroughCore({ page, request });
  await page.route(`${api}/transactions?*`, async (route) => {
    await Effect.runPromise(Effect.sleep("1 second"));
    await route.continue();
  });
  await page.goto("/app/transactions");
  await expect(page.getByRole("region", { name: "Cargando transacciones" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Cargando transacciones" })).toHaveCount(0);
});

test("approves a browser pairing through the real verified-email public route", async ({
  page,
  request,
}) => {
  await page.goto("/auth/pair");
  await page.getByRole("button", { name: "Iniciar sesión en el navegador" }).click();
  const code = await visiblePairingCode(page);
  await page.getByLabel("O accede con tu correo verificado").fill("usuario@example.com");
  await page.getByRole("button", { name: "Enviar código por correo" }).click();
  await expect(page.getByLabel("Código recibido por correo")).toBeVisible();
  const delivered = await request.post(`http://127.0.0.1:4175/email/login/deliver?code=${code}`);
  expect(delivered.status()).toBe(noContent);
  const proof = "ABCD-EFGH-JKLM-NPQR-STUV-WXYZ";
  await page.getByLabel("Código recibido por correo").fill(proof);
  await page.getByRole("button", { name: "Aprobar este navegador" }).click();
  await expect(page).toHaveURL(/\/app\/transactions$/u, { timeout: 15_000 });
  expect(page.url()).not.toContain(proof);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test("replaces a verified EmailCredential through public operations after fixture delivery", async ({
  page,
  request,
}) => {
  await signInThroughCore({ page, request });
  await page.goto("/settings/email");
  await page.getByLabel("Nuevo correo").fill("nuevo@example.com");
  await page.getByRole("button", { name: "Enviar código" }).click();
  await expect(page.getByText("Enviamos un código a nuevo@example.com.")).toBeVisible();
  const delivered = await request.post("http://127.0.0.1:4175/email/replacement/deliver");
  expect(delivered.status()).toBe(noContent);
  const code = "ABCD-EFGH-JKLM-NPQR-STUV-WXYZ";
  await page.getByLabel("Código de verificación").fill(code);
  await page.getByRole("button", { name: "Cambiar correo" }).click();
  await expect(page.getByText("Tu nuevo correo verificado ya está activo.")).toBeVisible();
  expect(page.url()).not.toContain(code);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test("submits reused-source Subscription enrollment through real public and Core routes", async ({
  page,
  request,
}) => {
  await signInThroughCore({ page, request });
  await page.goto("/upgrade");
  const preparing = page.waitForResponse(
    (response) => response.url() === `${api}/web/subscription/card-enrollments/prepare`
  );
  await page.getByRole("button", { name: "Elegir mensual" }).click();
  const prepared = await preparing;
  expect(prepared.status()).toBe(ok);
  await expect(
    page.getByText("Usaremos de nuevo tu fuente de pago guardada.", { exact: false })
  ).toBeVisible();
  await page.getByLabel(/Acepto el reglamento/iu).check();
  await page.getByLabel(/Autorizo el tratamiento/iu).check();
  const submission = page.waitForResponse(
    (response) => response.url() === `${api}/web/subscription/card-enrollments/submit`
  );
  await page.getByRole("button", { name: "Activar Pro" }).click();
  const submitted = await submission;
  expect(submitted.status()).toBe(ok);
  const submissionBody: unknown = await submitted.json();
  expect(submissionBody).toMatchObject({
    status: "payment-pending",
    billingAttempt: { status: "pending" },
  });
  const { billingAttempt } = Schema.decodeUnknownSync(
    Schema.Struct({ billingAttempt: Schema.Struct({ id: Schema.String }) })
  )(submissionBody);
  expect((await request.post("http://127.0.0.1:4175/billing/collect")).status()).toBe(noContent);
  const settled = await page.request.get(
    `${api}/web/subscription/billing-attempts/${billingAttempt.id}`,
    {
      headers: { origin: "https://127.0.0.1:4173" },
    }
  );
  expect(settled.status()).toBe(ok);
  expect(await settled.json()).toMatchObject({ status: "succeeded" });
  await expect(page.getByText("Tu pago fue realizado y tu suscripción está activa.")).toBeVisible({
    timeout: 20_000,
  });
});

test("a read-only PAT issued through the real browser session cannot capture Transactions after review or revocation", async ({
  page,
  request,
}) => {
  await signInThroughCore({ page, request });
  await page.goto("/settings/pats");
  await page.getByLabel("Nombre", { exact: true }).fill("Agente de casa");
  await page.getByRole("checkbox", { name: /^Lectura:/u }).check();
  await page.getByRole("button", { name: "30 días" }).click();
  await page.getByRole("button", { name: "Revisar token" }).click();
  await expect(page.getByRole("heading", { name: "Revisa el acceso" })).toBeVisible();
  await page.getByRole("button", { name: "Confirmar y crear token" }).click();
  const bearer = await page.locator("code").filter({ hasText: /^fin_/u }).textContent();
  expect(bearer).toMatch(/^fin_/u);
  const readOnly = await request.post(`${api}/transactions`, {
    headers: { authorization: `Bearer ${bearer}` },
    data: { money: { amount: "1", currency: "COP" } },
  });
  expect(readOnly.status()).toBe(forbidden);
  await page.getByRole("button", { name: "Crear otro token" }).click();
  await expect(page.getByText(bearer ?? "never-issued")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Agente de casa" })).toBeVisible();
  await page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole("heading", { name: "Agente de casa" }) })
    .getByRole("button", { name: "Desactivar", exact: true })
    .click();
  await page.getByRole("button", { name: "Sí, desactivar" }).click();
  await expect(page.getByText("Token desactivado. Dejó de funcionar de inmediato.")).toBeVisible();
  const revoked = await request.get(`${api}/transactions`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  expect(revoked.status()).toBe(unauthorized);
});
