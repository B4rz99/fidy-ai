import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const ok = 200;
const missing = 404;
const mobileWidth = 390;
const mobileHeight = 844;

for (const path of ["/conectar/mcp", "/transacciones/registrar-corregir", "/consultar/finanzas"]) {
  test(`customers can read ${path} without JavaScript and retrieve the same Markdown`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    const response = await page.goto(`http://127.0.0.1:4324${path}`);
    expect(response?.status()).toBe(ok);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      `https://docs.fidyapp.com${path}`
    );
    const markdown = await page
      .getByRole("link", { name: "Ver Markdown", exact: true })
      .getAttribute("href");
    const raw = await context.request.get(`http://127.0.0.1:4324${markdown}`);
    expect(raw.status()).toBe(ok);
    expect(await raw.text()).toContain(await page.locator("h1").innerText());
    expect((await page.goto("http://127.0.0.1:4324/does-not-exist"))?.status()).toBe(missing);
    await context.close();
  });
}

test("search finds a task and copy Markdown returns the source without browser or CSP errors", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/transacciones/registrar-corregir");
  await page.getByRole("button", { name: "Copiar Markdown", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Markdown copiado");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("# Registrar y corregir transacciones");
  expect(copied).toContain('"expectedRevision": 0');
  await page.getByRole("button", { name: "Buscar", exact: false }).click();
  await page.getByRole("textbox", { name: "Buscar", exact: true }).fill("corregir");
  await expect(page.locator(".pagefind-ui__result-link").first()).toBeVisible();
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

test("mobile navigation and the guide remain accessible without horizontal page overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: mobileWidth, height: mobileHeight });
  await page.goto("/");
  await page.getByRole("button", { name: "Menú" }).click();
  await page.getByRole("link", { name: "Conectar mi agente con MCP", exact: true }).click();
  await expect(page.locator("h1")).toHaveText("Conectar mi agente con MCP");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical"
    )
  ).toEqual([]);
});
