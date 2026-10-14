import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const ok = 200;
const notFound = 404;
const faqCount = 8;
const publicPaths = [
  "/",
  "/funciones/transacciones",
  "/funciones/presupuestos",
  "/funciones/asistente",
  "/funciones/tablero",
  "/funciones/insights",
  "/funciones/agentes",
  "/politica",
  "/cookies",
  "/terminos",
];
for (const path of publicPaths) {
  test(`delivers complete HTML and canonical metadata without JavaScript: ${path}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    const response = await page.goto(`http://127.0.0.1:4322${path}`);
    expect(response?.status()).toBe(ok);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator('meta[http-equiv="content-security-policy"]')).toHaveAttribute(
      "content",
      /default-src 'none'/u
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      `https://fidyapp.com${path}`
    );
    await expect(page.locator('meta[name="description"]')).not.toHaveAttribute("content", "");
    await context.close();
  });
}

test("exposes answers, product signup, feature links and a real 404 without JavaScript", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:4322/");
  await expect(page.getByText("¿Cuánto cuesta?")).toBeVisible();
  await expect(
    page.locator('[itemtype="https://schema.org/FAQPage"] [itemprop="acceptedAnswer"]')
  ).toHaveCount(faqCount);
  await expect(page.getByRole("link", { name: "Crear mi cuenta" }).first()).toHaveAttribute(
    "href",
    "https://app.fidyapp.com/auth/google"
  );
  await expect(page.getByRole("link", { name: "Conecta tu agente", exact: true })).toHaveAttribute(
    "href",
    "/funciones/agentes#conectar"
  );
  const missing = await page.goto("http://127.0.0.1:4322/no-existe");
  expect(missing?.status()).toBe(notFound);
  await expect(page.locator("h1")).toHaveText("Página no encontrada");
  await context.close();
});

test("hydrates demos and preserves appearance without browser errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "Activar tema oscuro" }).click();
  await expect(page.locator(".fidy-landing")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.getByRole("button", { name: "Activar tema claro" })).toBeVisible();
  await page.locator("#funciones").scrollIntoViewIfNeeded();
  await page.getByRole("tab", { name: "Presupuestos" }).click();
  await expect(page.getByRole("tab", { name: "Presupuestos" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await page.locator("#precios").scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Anual", exact: true }).click();
  await expect(page.getByText("$289.900", { exact: false }).first()).toBeVisible();
  await page.goto("/funciones/transacciones");
  await expect(page.locator(".fidy-landing")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Probar una corrección" }).click();
  await expect(page.locator("[data-correction-amount]")).toHaveText("$26.000 COP");
  await page.getByRole("button", { name: "Activar tema claro" }).click();
  await expect(page.locator(".fidy-landing")).toHaveAttribute("data-theme", "light");
  expect(errors).toEqual([]);
});

const settleEntranceMotion = async (): Promise<void> => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.all(
    document
      .getAnimations()
      .filter(
        (animation) =>
          animation.timeline instanceof DocumentTimeline &&
          animation.effect?.getTiming().iterations !== Infinity
      )
      .map((animation) => animation.finished.catch(() => undefined))
  );
};

for (const path of publicPaths) {
  test(`keeps rendered public content accessible and CSP compatible: ${path}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(path);
    await page.evaluate(settleEntranceMotion);
    const results = await new AxeBuilder({ page }).analyze();
    expect(
      results.violations.filter(({ impact }) => impact === "serious" || impact === "critical")
    ).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("publishes canonical discovery files and keeps draft terms out of the sitemap", async ({
  page,
  request,
}) => {
  const sitemap = await request.get("/sitemap-0.xml");
  const xml = await sitemap.text();
  expect(xml).not.toContain("/terminos");
  expect(xml).not.toContain("/404");
  expect(xml).not.toContain(".html");
  expect(xml).toContain("https://fidyapp.com/funciones/transacciones");
  const robots = await request.get("/robots.txt");
  expect(await robots.text()).toContain("https://fidyapp.com/sitemap-index.xml");
  const agentGuide = await request.get("/llms.txt");
  expect(await agentGuide.text()).toContain("https://fidyapp.com/funciones/agentes#conectar");
  await page.goto("/terminos");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, follow");
});
