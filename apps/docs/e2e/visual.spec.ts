import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";
import { Option } from "effect";
import { visualRoutes } from "./visual-routes";

const ok = 200;
const missing = 404;
const captureEnabled = process.env.DOCS_VISUAL_CAPTURE === "1";
const viewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
] as const;
const themes = ["light", "dark"] as const;
const widthBreakpoints = {
  codeCompact: 640,
  docsMobile: 800,
  starlightWide: 1152,
  docsContext: 1280,
};
type Viewport = { width: number; height: number };
type Evidence = { testInfo: TestInfo; viewport: Viewport };
type SemanticTarget = { heading: string; id: string; schema: Option.Option<string> };

const serializeTarget = (
  target: Option.Option<SemanticTarget>
): { heading: string; id: string; schema: string } =>
  Option.match(target, {
    onNone: () => ({ heading: "", id: "", schema: "" }),
    onSome: ({ heading, id, schema }) => ({
      heading,
      id,
      schema: Option.getOrElse(schema, () => ""),
    }),
  });

const clientViewport = (page: Page): Promise<Viewport> =>
  page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  }));

const calibrateViewport = async (page: Page, viewport: Viewport): Promise<void> => {
  const gutter = await page.evaluate(() => ({
    width: window.innerWidth - document.documentElement.clientWidth,
    height: window.innerHeight - document.documentElement.clientHeight,
  }));
  await page.setViewportSize({
    width: viewport.width + gutter.width,
    height: viewport.height + gutter.height,
  });
  await expect.poll(() => clientViewport(page)).toEqual(viewport);
  const configured = Option.getOrThrow(Option.fromNullishOr(page.viewportSize()));
  // Every width boundary in the built docs CSS stays on the same side of the client area.
  for (const breakpoint of Object.values(widthBreakpoints)) {
    expect(configured.width >= breakpoint).toBe(viewport.width >= breakpoint);
  }
};

const capture = async (
  page: Page,
  evidence: Evidence,
  target: { name: string; semanticTarget: Option.Option<SemanticTarget> }
): Promise<void> => {
  const { name } = target;
  const { testInfo, viewport } = evidence;
  await calibrateViewport(page, viewport);
  const semanticTarget = serializeTarget(target.semanticTarget);
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  const clip = { x: 0, y: 0, ...viewport };
  await page.screenshot({ path: screenshotPath, animations: "disabled", clip });
  const metadata = await page.evaluate(() => ({
    url: window.location.href,
    viewport: {
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    },
    windowViewport: { width: window.innerWidth, height: window.innerHeight },
    theme: document.documentElement.dataset.theme,
    scrollY: window.scrollY,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    fonts: document.fonts.status,
    hash: window.location.hash,
  }));
  await writeFile(
    testInfo.outputPath(`${name}.json`),
    JSON.stringify(
      {
        commit: process.env.DOCS_CAPTURE_SHA,
        screenshotPath,
        framing: "complete-client-area",
        requestedViewport: viewport,
        browserViewport: Option.getOrThrow(Option.fromNullishOr(page.viewportSize())),
        clip,
        semanticTarget,
        ...metadata,
      },
      undefined,
      2
    )
  );
  expect(metadata.viewport).toEqual(viewport);
  expect(metadata.horizontalOverflow, `${name}: horizontal viewport overflow`).toBe(false);
};

const captureState = (page: Page, evidence: Evidence, name: string): Promise<void> =>
  capture(page, evidence, { name, semanticTarget: Option.none() });

const captureSearch = async (page: Page, evidence: Evidence): Promise<void> => {
  await page.getByRole("button", { name: "Buscar", exact: true }).click();
  await captureState(page, evidence, "search-idle");
  const input = page.getByRole("textbox", { name: "Buscar", exact: true });
  await input.fill("transacciones");
  await expect(page.getByRole("dialog").getByRole("link").first()).toBeVisible();
  await captureState(page, evidence, "search");
  await input.fill("zxq-no-result");
  await expect(page.getByRole("heading", { name: "Sin resultados" })).toBeVisible();
  await captureState(page, evidence, "search-empty");
  await page.keyboard.press("Escape");
};

const captureLower = async (
  page: Page,
  evidence: Evidence,
  route: (typeof visualRoutes)[number]
): Promise<void> => {
  let target = page.locator("#_top");
  if (Option.isSome(route.schema)) {
    await page
      .getByRole("searchbox", { name: "Buscar por nombre de esquema" })
      .fill(route.schema.value);
    target = page.locator(`#schema-${route.schema.value}`);
    await page.getByRole("searchbox", { name: "Buscar por nombre de esquema" }).blur();
  } else {
    const heading =
      route.route === "/reference"
        ? page.locator("#dominio-dashboard")
        : page.getByRole("heading", { name: route.heading, exact: true }).first();
    target = heading;
  }
  await calibrateViewport(page, evidence.viewport);
  await target.evaluate((element) => element.scrollIntoView());
  const id = Option.fromNullishOr(await target.getAttribute("id")).pipe(
    Option.filter((value) => value.length > 0),
    Option.getOrThrowWith(() => new Error(`Missing anchor ID for ${route.route}: ${route.heading}`))
  );
  await capture(page, evidence, {
    name: "lower-semantic",
    semanticTarget: Option.some({ heading: route.heading, id, schema: route.schema }),
  });
};

if (captureEnabled) {
  for (const viewport of viewports) {
    for (const theme of themes) {
      test.describe(`${viewport.name} ${theme}`, () => {
        const designViewport = { width: viewport.width, height: viewport.height };
        test.use({ viewport: designViewport, colorScheme: theme });
        for (const route of visualRoutes) {
          test(`visual ${route.route}`, async ({ page }, testInfo) => {
            const evidence = { testInfo, viewport: designViewport };
            const response = await page.goto(route.route);
            expect(response?.status()).toBe(ok);
            await page.evaluate(() => document.fonts.ready);
            await expect(page.locator("main h1")).toHaveText(route.title);
            await capture(page, evidence, {
              name: "initial",
              semanticTarget: Option.some({
                heading: route.title,
                id: "_top",
                schema: Option.none(),
              }),
            });
            await captureLower(page, evidence, route);
          });
        }
        test("search, theme, copy and missing-page states", async ({ page, context }, testInfo) => {
          const evidence = { testInfo, viewport: designViewport };
          await context.grantPermissions(["clipboard-read", "clipboard-write"]);
          await page.goto("/");
          await page.evaluate(() => document.fonts.ready);
          await captureSearch(page, evidence);
          await page.getByRole("button", { name: "Elegir tema" }).click();
          await page
            .getByRole("radio", { name: theme === "light" ? "Claro" : "Oscuro", exact: true })
            .check();
          await page.getByRole("button", { name: "Elegir tema" }).click();
          await captureState(page, evidence, "theme");
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: "Copiar Markdown", exact: true }).click();
          await expect(page.locator("[data-copy-status]:visible")).toHaveText("Markdown copiado");
          await page.evaluate(() => window.scrollTo(0, 0));
          await captureState(page, evidence, "copy");
          expect((await page.goto("/no-existe-esta-pagina"))?.status()).toBe(missing);
          await page.evaluate(() => document.fonts.ready);
          await captureState(page, evidence, "404");
        });
        if (viewport.name === "mobile") {
          test("drawer and table of contents states", async ({ page }, testInfo) => {
            const evidence = { testInfo, viewport: designViewport };
            await page.goto("/");
            await page.evaluate(() => document.fonts.ready);
            await page.getByRole("button", { name: "Menú", exact: true }).click();
            await captureState(page, evidence, "drawer");
            await page.keyboard.press("Escape");
            await page.goto("/conectar/cli");
            await page.getByRole("button", { name: "En esta página", exact: true }).click();
            await captureState(page, evidence, "toc");
            const toc = page.locator(".docs-mobile-toc:popover-open");
            const bounds = Option.getOrThrow(Option.fromNullishOr(await toc.boundingBox()));
            expect(bounds).toMatchObject({ x: 12, y: 120, width: 366, height: 412 });
            expect(bounds.x + bounds.width).toBeLessThanOrEqual((await clientViewport(page)).width);
          });
        }
      });
    }
  }
}
