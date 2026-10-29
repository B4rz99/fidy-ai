import { expect, test } from "@playwright/test";

const desktop = { width: 1440, height: 1000 };
const mobile = { width: 390, height: 844 };
const compactCodeHeight = 84;

test("code panels reserve a compact header and offer scrolling only when needed", async ({
  page,
}) => {
  await page.setViewportSize(desktop);
  await page.goto("/conectar/cli");
  await page.evaluate(() => document.fonts.ready);
  const shell = page.locator(".expressive-code .frame").first();
  await expect(shell).not.toHaveAttribute("data-docs-overflow");
  const size = await shell.boundingBox();
  expect(size?.height).toBeCloseTo(compactCodeHeight, 0);
  const powershell = page.locator('.expressive-code .frame:has(pre[data-language="powershell"])');
  await expect(powershell).toHaveAttribute("data-docs-overflow");
  const code = powershell.locator("pre");
  await code.focus();
  await page.keyboard.press("End");
  expect(await code.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
});

test("the drawer closes from its scrim control without locking subsequent navigation", async ({
  page,
}) => {
  await page.setViewportSize(mobile);
  await page.goto("/");
  await page.getByRole("button", { name: "Menú", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cerrar menú", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cerrar menú", exact: true }).click();
  await expect(page.locator("#starlight__sidebar")).not.toBeVisible();
  await expect(page.locator(".main-frame")).not.toHaveAttribute("inert");
  await page.getByRole("button", { name: "Menú", exact: true }).click();
  await page.getByRole("link", { name: "CLI", exact: true }).click();
  await expect(page.locator("h1")).toHaveText("Instalar y conectar la CLI");
  await page.goBack();
  await expect(page.locator(".main-frame")).not.toHaveAttribute("inert");
});

test("a denied clipboard write never announces that Markdown was copied", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new DOMException("Denied", "NotAllowedError")) },
    });
  });
  await page.goto("/conectar/cli");
  const copy = page.getByRole("button", { name: "Copiar Markdown", exact: true });
  await copy.click();
  await expect(page.locator("[data-copy-status]:visible")).toHaveText(
    "No se pudo copiar. Usa «Ver Markdown»."
  );
  await expect(copy).toBeEnabled();
  await copy.click();
  await expect(page.locator("[data-copy-status]:visible")).not.toHaveText("Markdown copiado");
  await expect(page.getByRole("link", { name: "Ver Markdown", exact: true })).toHaveAttribute(
    "href",
    "/conectar/cli.md"
  );
});

test("the table of contents follows linked access and catalog domain sections", async ({
  page,
}) => {
  await page.setViewportSize(desktop);
  await page.goto("/reference/transactions.createtransaction");
  await page.locator("#acceso").evaluate((element) => element.scrollIntoView());
  await expect(page.locator('.docs-toc a[href="#acceso"]')).toHaveAttribute(
    "aria-current",
    "location"
  );
  await page.goto("/reference");
  await page.locator("#dominio-dashboard").evaluate((element) => element.scrollIntoView());
  await expect(page.locator('.docs-toc a[href="#por-dominio"]')).toHaveAttribute(
    "aria-current",
    "location"
  );
});
