import { AxeBuilder } from "@axe-core/playwright";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";

const expectSeriousAccessibilityViolations = async (page: Page): Promise<void> => {
  const results = await new AxeBuilder({ page }).analyze();
  const seriousViolations = results.violations.filter(
    ({ impact }) => impact === "serious" || impact === "critical"
  );
  expect(seriousViolations, JSON.stringify(seriousViolations, null, 2)).toEqual([]);
};

const ok = 200;
const notFound = 404;
const accepted = 204;
const forbidden = 403;
const unauthorized = 401;
const methodNotAllowed = 405;

test("serves the checked-in security policy on SPA fallbacks", async ({ request }) => {
  const shell = await request.get("/app/transactions");
  expect(shell.status()).toBe(ok);
  expect(await shell.text()).toContain('id="root"');
  expect(shell.headers()["cache-control"]).toBe("no-cache");
  expect(shell.headers()["content-security-policy"]).toContain(
    "connect-src https://127.0.0.1:4174 https://sandbox.wompi.co https://production.wompi.co;"
  );
  expect(shell.headers()["x-frame-options"]).toBe("DENY");
  expect(shell.headers()["referrer-policy"]).toBe("no-referrer");
});

test("keeps hashed assets immutable without relaxing security headers or publishing maps", async ({
  request,
}) => {
  const shell = await request.get("/");
  const asset = (await shell.text()).match(/\/(assets\/[^"']+\.js)/u)?.[1];
  expect(asset).toMatch(/^assets\/.+-[A-Za-z0-9_-]{8,}\.js$/u);
  const hashed = await request.get(`/${asset}`);
  expect(hashed.status()).toBe(ok);
  expect(hashed.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect(hashed.headers()["content-security-policy"]).toBe(
    shell.headers()["content-security-policy"]
  );
  expect((await request.get(`${asset}.map`)).status()).toBe(notFound);
});

test("does not publish an OpenAPI document or source maps as static assets", async ({
  request,
}) => {
  const paths = ["/openapi.json", "/assets/source.js.map"];
  const responses = await Promise.all(paths.map((path) => request.get(path)));
  for (const [index, response] of responses.entries()) {
    expect(response.status(), paths[index]).toBe(notFound);
  }
  expect(
    (await Promise.all(responses.map((response) => response.text()))).every(
      (body) => !body.includes('id="root"')
    )
  ).toBe(true);
});

test("keeps API ownership and credentialed CORS on the real ingress, not the static host", async ({
  request,
}) => {
  const api = "https://127.0.0.1:4174";
  const browser = "https://127.0.0.1:4173";
  const headers = {
    origin: browser,
    "access-control-request-method": "POST",
    "access-control-request-headers": "content-type",
  };
  const preflight = await request.fetch(`${api}/web/pairings`, {
    method: "OPTIONS",
    headers,
  });
  expect(preflight.status()).toBe(accepted);
  expect(preflight.headers()["access-control-allow-origin"]).toBe(browser);
  expect(preflight.headers()["access-control-allow-credentials"]).toBe("true");
  expect(preflight.headers()["cache-control"]).toBe("no-store");
  const hostile = await request.fetch(`${api}/web/pairings`, {
    method: "OPTIONS",
    headers: { ...headers, origin: "https://attacker.example" },
  });
  expect(hostile.status()).toBe(forbidden);
  expect(hostile.headers()["access-control-allow-origin"]).toBeUndefined();
  const wrongMethod = await request.get(`${api}/web/pairings`, { headers: { origin: browser } });
  expect(wrongMethod.status()).toBe(methodNotAllowed);
  expect(wrongMethod.headers().allow).toBe("POST");
  expect((await request.post("/web/pairings")).status()).toBe(methodNotAllowed);
  const staticAuth = await request.get("/web/email/authentication/start");
  expect(staticAuth.status()).toBe(ok);
  expect(staticAuth.headers()["content-type"]).toContain("text/html");
  expect(staticAuth.headers()["set-cookie"]).toBeUndefined();
  expect((await request.get(`${api}/openapi.json`)).status()).toBe(notFound);
});

test("creates a browser pairing through the real public and Core Workers", async ({ request }) => {
  const response = await request.post("https://127.0.0.1:4174/web/pairings", {
    headers: { origin: "https://127.0.0.1:4173" },
  });
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({
    pairingId: expect.any(String),
    privateVerifier: expect.any(String),
    publicCode: expect.any(String),
  });
});

const expectUnauthenticated = (request: APIRequestContext, path: string): Promise<void> =>
  request
    .get(`https://127.0.0.1:4174${path}`, { headers: { origin: "https://127.0.0.1:4173" } })
    .then((result) => {
      expect(result.status(), path).toBe(unauthorized);
      expect(result.headers()["cache-control"], path).toBe("no-store");
      expect(result.headers()["set-cookie"], path).toBeUndefined();
    });

test("Core refuses unauthenticated financial routes and untrusted support decisions", async ({
  request,
}) => {
  const api = "https://127.0.0.1:4174";
  const headers = { origin: "https://127.0.0.1:4173" };
  const protectedPaths = [
    "/categories",
    "/transactions",
    "/dashboard/view",
    "/subscription/status",
  ];
  await Promise.all(protectedPaths.map((path) => expectUnauthenticated(request, path)));
  const support = await request.post(`${api}/internal/support-recovery`, {
    headers,
    data: { pairingCode: "BCDF-GHJK", backupRecoveryCode: "invalid" },
  });
  expect(support.status()).toBe(forbidden);
  expect(support.headers()["access-control-allow-origin"]).toBeUndefined();
});

test("renders the public home route without serious accessibility violations", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("fidy");
  await expect(page.getByRole("heading", { level: 1, name: "Fidy" })).toBeVisible();
  await expectSeriousAccessibilityViolations(page);
});

test("renders the policy route without serious accessibility violations", async ({ page }) => {
  await page.goto("/politica");

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Política de tratamiento de datos personales",
    })
  ).toBeVisible();
  await expectSeriousAccessibilityViolations(page);
});

test("renders not-found behavior without serious accessibility violations", async ({ page }) => {
  await page.goto("/ruta-inexistente");

  await expect(page.getByRole("heading", { name: "Página no encontrada" })).toBeVisible();
  await expectSeriousAccessibilityViolations(page);
});
