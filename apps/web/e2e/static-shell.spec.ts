import { AxeBuilder } from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const expectSeriousAccessibilityViolations = async (page: Page): Promise<void> => {
  const results = await new AxeBuilder({ page }).analyze();
  const seriousViolations = results.violations.filter(
    ({ impact }) => impact === "serious" || impact === "critical"
  );
  expect(seriousViolations, JSON.stringify(seriousViolations, null, 2)).toEqual([]);
};

const ok = 200;
const notFound = 404;

test("serves the checked-in security policy on SPA fallbacks", async ({ request }) => {
  const shell = await request.get("/app/transactions");
  expect(shell.status()).toBe(ok);
  expect(await shell.text()).toContain('id="root"');
  expect(shell.headers()["cache-control"]).toBe("no-cache");
  expect(shell.headers()["content-security-policy"]).toContain(
    "connect-src https://127.0.0.1:4174"
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
