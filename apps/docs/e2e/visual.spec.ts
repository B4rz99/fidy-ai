import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";
import { visualRoutes } from "./visual-routes";

const ok = 200;
const missing = 404;
const captureEnabled = process.env.DOCS_VISUAL_CAPTURE === "1";
const viewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
] as const;
const themes = ["light", "dark"] as const;
const capture = async (page: Page, testInfo: TestInfo, name: string): Promise<void> => {
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshotPath, animations: "disabled" });
  const metadata = await page.evaluate(() => ({
    url: window.location.href,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    theme: document.documentElement.dataset.theme,
    scrollY: window.scrollY,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    fonts: document.fonts.status,
    hash: window.location.hash,
  }));
  await writeFile(
    testInfo.outputPath(`${name}.json`),
    JSON.stringify(
      {
        commit: process.env.DOCS_CAPTURE_SHA,
        screenshotPath,
        ...metadata,
      },
      undefined,
      2
    )
  );
  expect(metadata.horizontalOverflow, `${name}: horizontal viewport overflow`).toBe(false);
};

const captureSearch = async (page: Page, testInfo: TestInfo): Promise<void> => {
  await page.getByRole("button", { name: "Buscar", exact: true }).click();
  await capture(page, testInfo, "search-idle");
  const input = page.getByRole("textbox", { name: "Buscar", exact: true });
  await input.fill("transacciones");
  await expect(page.getByRole("dialog").getByRole("link").first()).toBeVisible();
  await capture(page, testInfo, "search");
  await input.fill("zxq-no-result");
  await expect(page.getByRole("heading", { name: "Sin resultados" })).toBeVisible();
  await capture(page, testInfo, "search-empty");
  await page.keyboard.press("Escape");
};

if (captureEnabled) {
  for (const viewport of viewports) {
    for (const theme of themes) {
      test.describe(`${viewport.name} ${theme}`, () => {
        test.use({ viewport, colorScheme: theme });
        for (const route of visualRoutes) {
          test(`visual ${route.route}`, async ({ page }, testInfo) => {
            const response = await page.goto(route.route);
            expect(response?.status()).toBe(ok);
            await page.evaluate(() => document.fonts.ready);
            await expect(page.locator("main h1")).toHaveText(route.title);
            await capture(page, testInfo, "initial");
            if (route.schema) {
              await page
                .getByRole("searchbox", { name: "Buscar por nombre de esquema" })
                .fill(route.schema);
              await page
                .locator(`#schema-${route.schema}`)
                .evaluate((element) => element.scrollIntoView());
            } else {
              const heading =
                route.route === "/reference"
                  ? page.locator("#dominio-dashboard")
                  : page.getByRole("heading", { name: route.heading, exact: true }).first();
              await heading.evaluate((element) => element.scrollIntoView());
            }
            await capture(page, testInfo, "lower-semantic");
          });
        }
        test("search, theme, copy and missing-page states", async ({ page, context }, testInfo) => {
          await context.grantPermissions(["clipboard-read", "clipboard-write"]);
          await page.goto("/");
          await page.evaluate(() => document.fonts.ready);
          await captureSearch(page, testInfo);
          await page.getByRole("button", { name: "Elegir tema" }).click();
          await capture(page, testInfo, "theme");
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: "Copiar Markdown", exact: true }).click();
          await expect(page.locator("[data-copy-status]:visible")).toHaveText("Markdown copiado");
          await page.evaluate(() => window.scrollTo(0, 0));
          await capture(page, testInfo, "copy");
          expect((await page.goto("/no-existe-esta-pagina"))?.status()).toBe(missing);
          await page.evaluate(() => document.fonts.ready);
          await capture(page, testInfo, "404");
        });
        if (viewport.name === "mobile") {
          test("drawer and table of contents states", async ({ page }, testInfo) => {
            await page.goto("/");
            await page.evaluate(() => document.fonts.ready);
            await page.getByRole("button", { name: "Menú", exact: true }).click();
            await capture(page, testInfo, "drawer");
            await page.keyboard.press("Escape");
            await page.goto("/conectar/cli");
            await page.getByRole("button", { name: "En esta página", exact: true }).click();
            await capture(page, testInfo, "toc");
          });
        }
      });
    }
  }
}
