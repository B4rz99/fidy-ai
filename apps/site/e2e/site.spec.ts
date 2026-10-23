import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { isAcceptedSloganContrast, unexpectedViolations } from "./accepted-contrast";

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
    "https://app.fidyapp.com/login"
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
  await page.locator('astro-island[component-export="FeatureTabs"]:not([ssr])').waitFor();
  await page.getByRole("tab", { name: "Presupuestos" }).click();
  await expect(page.getByRole("tab", { name: "Presupuestos" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await page.locator("#precios").scrollIntoViewIfNeeded();
  await page.locator('astro-island[component-export="Pricing"]:not([ssr])').waitFor();
  await page.getByRole("button", { name: "Anual", exact: true }).click();
  await expect(page.getByText("$289.900", { exact: false }).first()).toBeVisible();
  await page.goto("/funciones/transacciones");
  await expect(page.locator(".fidy-landing")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Probar una corrección" }).scrollIntoViewIfNeeded();
  await page.locator('astro-island[component-export="CorrectionDemo"]:not([ssr])').waitFor();
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

for (const theme of ["light", "dark"] as const) {
  for (const path of publicPaths) {
    test(`audits rendered public content and CSP with documented design exceptions: ${path} ${theme}`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
      await page.goto(path);
      await page.evaluate(settleEntranceMotion);
      const results = await new AxeBuilder({ page }).analyze();
      const violations = unexpectedViolations(results.violations, path, theme);
      const accepted = results.violations.flatMap((violation) =>
        violation.nodes.filter((node) =>
          isAcceptedSloganContrast({ path, theme }, violation.id, node)
        )
      );
      if (accepted.length > 0) {
        test.info().annotations.push({
          type: "accepted-design-exception",
          description:
            "#1524: light slogan #88CC20 on #FAE3D9 is 1.59:1 and does not meet WCAG AA (3:1).",
        });
        await test.info().attach("accepted-slogan-contrast.json", {
          body: JSON.stringify(accepted, null, 2),
          contentType: "application/json",
        });
      }
      expect(
        violations.filter(({ impact }) => impact === "serious" || impact === "critical")
      ).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}

test("limits the approved contrast exception to the exact light slogan and color pair", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
  await page.goto("/");
  const results = await new AxeBuilder({ page }).analyze();
  const violation = results.violations.find(({ id }) => id === "color-contrast");
  expect(violation).toBeDefined();
  if (!violation) throw new Error("Expected the explicitly documented slogan contrast violation");
  const node = violation.nodes[0];
  expect(isAcceptedSloganContrast({ path: "/", theme: "light" }, violation.id, node)).toBe(true);
  expect(isAcceptedSloganContrast({ path: "/", theme: "dark" }, violation.id, node)).toBe(false);
  expect(
    isAcceptedSloganContrast({ path: "/funciones/agentes", theme: "light" }, violation.id, node)
  ).toBe(false);
  expect(isAcceptedSloganContrast({ path: "/", theme: "light" }, "another-rule", node)).toBe(false);
  const otherElement = { ...node, target: [".other-heading"] };
  const changedText = { ...node, html: "<em>Different slogan</em>" };
  const changedForeground = {
    ...node,
    any: [
      {
        ...node.any[0],
        data: { fgColor: "#97ca47", bgColor: "#fae3d9", expectedContrastRatio: "3:1" },
      },
    ],
  };
  const changedBackground = {
    ...node,
    any: [
      {
        ...node.any[0],
        data: { fgColor: "#88cc20", bgColor: "#fffaf6", expectedContrastRatio: "3:1" },
      },
    ],
  };
  for (const changed of [otherElement, changedText, changedForeground, changedBackground]) {
    expect(unexpectedViolations([{ ...violation, nodes: [changed] }], "/", "light")).toHaveLength(
      1
    );
  }
  expect(
    unexpectedViolations([{ ...violation, nodes: [node, otherElement] }], "/", "light")[0].nodes
  ).toEqual([otherElement]);
});

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

const responsiveWidths = { compactPhone: 320, phone: 390, compactTablet: 768, tablet: 820 };
const minimumDemoFontSize = 11;
for (const width of Object.values(responsiveWidths)) {
  test(`keeps the landing demonstration readable without horizontal scrolling at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.locator("#demo").scrollIntoViewIfNeeded();
    const layout = await page.evaluate(() => ({
      viewport: window.innerWidth,
      content: document.documentElement.scrollWidth,
      fontSize: Number.parseFloat(
        getComputedStyle(document.querySelector(".bubble") ?? document.body).fontSize
      ),
    }));
    expect(layout.content).toBeLessThanOrEqual(layout.viewport);
    expect(layout.fontSize).toBeGreaterThanOrEqual(minimumDemoFontSize);
    await expect(page.getByRole("button", { name: "Presupuestar", exact: true })).toBeVisible();
  });
}

test("conversation replay does not cancel the visible coin flip on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await page.locator("astro-island[component-export='PhoneDemo']:not([ssr])").waitFor();
  await page.evaluate(() => {
    const coin = document.querySelector(".coin");
    if (coin === null) throw new Error("Missing landing coin");
    window.scrollTo({
      top: coin.getBoundingClientRect().top + window.scrollY - 100,
      behavior: "instant",
    });
  });
  await expect
    .poll(() => page.locator(".coin").evaluate((coin) => coin.getAnimations().length))
    .toBe(1);
  await page.locator(".coin").evaluate((coin) => coin.getAnimations()[0]?.pause());
  await page.getByRole("button", { name: "Repetir animación de la conversación" }).click();
  expect(await page.locator(".coin").evaluate((coin) => coin.getAnimations()[0]?.playState)).toBe(
    "paused"
  );
});

test("replays the coin and conversation after scrolling away and returning", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await page.locator("astro-island[component-export='PhoneDemo']:not([ssr])").waitFor();
  const revisit = async (visit: string): Promise<void> => {
    await page.evaluate(async () => {
      window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await expect
      .poll(() =>
        page
          .locator(".bubble")
          .first()
          .evaluate((bubble) => bubble.getAnimations().length)
      )
      .toBe(0);
    await page.locator("#demo").evaluate((demo) => {
      window.scrollTo({
        top: demo.getBoundingClientRect().top + window.scrollY,
        behavior: "instant",
      });
    });
    await expect
      .poll(() => page.locator(".coin").evaluate((coin) => coin.getAnimations().length), {
        message: `${visit} coin entrance`,
      })
      .toBe(1);
    await expect
      .poll(
        () =>
          page
            .locator(".bubble")
            .last()
            .evaluate((bubble) => bubble.getAnimations().length),
        { message: `${visit} conversation entrance` }
      )
      .toBe(1);
    await page.evaluate(settleEntranceMotion);
  };
  await revisit("first");
  await revisit("second");
});

for (const width of Object.values(responsiveWidths)) {
  test(`aligns the Pro selection pill after plan changes and resize at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");
    await page.locator("#precios").scrollIntoViewIfNeeded();
    await page.locator('astro-island[component-export="Pricing"]:not([ssr])').waitFor();
    await page.getByRole("button", { name: "Anual", exact: true }).click();
    const alignment = (): Promise<number> =>
      page.locator(".price-options").evaluate((options) => {
        const pill = options.querySelector(".price-pill")?.getBoundingClientRect();
        const selected = options.querySelector('[aria-pressed="true"]')?.getBoundingClientRect();
        if (!pill || !selected) return Infinity;
        return Math.max(Math.abs(pill.left - selected.left), Math.abs(pill.right - selected.right));
      });
    await expect.poll(alignment).toBeLessThan(1);
    await expect(page.locator('.price-frame[data-visible="true"]')).toContainText("$289.900");
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect.poll(alignment).toBeLessThan(1);
    await page.getByRole("button", { name: "Semanal", exact: true }).focus();
    await page.keyboard.press("Enter");
    expect(await alignment()).toBeLessThan(1);
    await expect(page.locator('.price-frame[data-visible="true"]')).toContainText("$9.900");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Mensual", exact: true }).click();
    await expect(page.locator(".price-pill")).toBeHidden();
    await expect(page.locator('.price-frame[data-visible="true"]')).toContainText("$28.900");
  });
}

const compositionWidths = { narrow: 320, mobile: 491, wideMobile: 557, tablet: 664 };
for (const width of Object.values(compositionWidths)) {
  test(`keeps the budget card overlapping the phone and the coin visible at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 978 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.locator("#demo").scrollIntoViewIfNeeded();
    await page.locator("astro-island[component-export='PhoneDemo']:not([ssr])").waitFor();
    await page.evaluate(settleEntranceMotion);
    const composition = await page.locator(".hero-stage").evaluate((stage) => {
      const bounds = (selector: string): DOMRect => {
        const element = stage.querySelector(selector);
        if (element === null) throw new Error("Missing phone composition");
        return element.getBoundingClientRect();
      };
      const phone = bounds(".phone");
      const note = bounds(".floating-note");
      const coin = bounds(".coin");
      return {
        overlaps: note.top < phone.bottom && note.left < phone.right && note.right > phone.left,
        noteOnRight: note.left > phone.left,
        coinNearTop: coin.top < phone.top + coin.height,
        contained: coin.left >= 0 && coin.right <= innerWidth && note.right <= innerWidth,
      };
    });
    expect(composition).toEqual({
      overlaps: true,
      noteOnRight: true,
      coinNearTop: true,
      contained: true,
    });
  });
}

test("keeps the browser canvas and chrome aligned with system and saved appearance", async ({
  page,
}) => {
  const darkCanvas = "rgb(20, 20, 20)";
  const lightCanvas = "rgb(255, 250, 246)";
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    "content",
    /viewport-fit=cover/u
  );
  await expect(page.locator("html")).toHaveCSS("background-color", darkCanvas);
  await expect(page.locator("body")).toHaveCSS("background-color", darkCanvas);
  await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute(
    "content",
    darkCanvas
  );
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveCSS("background-color", lightCanvas);
  await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute(
    "content",
    lightCanvas
  );
  await page.getByRole("button", { name: "Activar tema oscuro" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveCSS("background-color", darkCanvas);
  await expect(page.locator("body")).toHaveCSS("background-color", darkCanvas);
  await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute(
    "content",
    darkCanvas
  );
});

const channelMobileWidth = 390;
const channelDesktopWidth = 1440;
const channelViewportWidths = [channelMobileWidth, channelDesktopWidth];
const channelEntryStart = 0.1;
const channelEntrySecond = 0.57;
for (const width of channelViewportWidths) {
  for (const javaScriptEnabled of [true, false]) {
    test(`reveals channels only with scroll, without a final-state flash: ${width}px JS=${javaScriptEnabled}`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        javaScriptEnabled,
        viewport: { width, height: 900 },
        reducedMotion: "no-preference",
      });
      const page = await context.newPage();
      await page.goto("http://127.0.0.1:4322/");
      const cards = page.locator(".channel-card");
      await expect(cards.nth(0)).toHaveCSS("opacity", "1");
      await expect(cards.nth(1)).toHaveCSS("opacity", "0");
      await expect(cards.nth(2)).toHaveCSS("opacity", "0");
      const scrollToProgress = async (progress: number): Promise<void> => {
        await page.locator(".channel-story").evaluate((element, fraction) => {
          const rect = element.getBoundingClientRect();
          window.scrollTo({
            top:
              window.scrollY +
              rect.top -
              window.innerHeight +
              Math.min(rect.height, window.innerHeight) * fraction,
            behavior: "instant",
          });
        }, progress);
      };
      await scrollToProgress(channelEntryStart);
      await expect(cards.nth(1)).toHaveCSS("opacity", "0");
      await expect(cards.nth(2)).toHaveCSS("opacity", "0");
      await scrollToProgress(channelEntrySecond);
      await expect(cards.nth(1)).toHaveCSS("opacity", "1");
      await expect(cards.nth(2)).toHaveCSS("opacity", "0");
      await scrollToProgress(1);
      await expect(cards.nth(2)).toHaveCSS("opacity", "1");
      await scrollToProgress(channelEntryStart);
      await expect(cards.nth(1)).toHaveCSS("opacity", "0");
      await expect(cards.nth(2)).toHaveCSS("opacity", "0");
      await page.reload();
      await expect(cards.nth(1)).toHaveCSS("opacity", "0");
      await expect(cards.nth(2)).toHaveCSS("opacity", "0");
      await context.close();
    });
  }
  test(`shows all channels immediately with reduced motion: ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await Promise.all(
      (await page.locator(".channel-card").all()).map(async (card) => {
        await expect(card).toHaveCSS("opacity", "1");
        await expect(card).toHaveCSS("animation-name", "none");
      })
    );
  });
}
