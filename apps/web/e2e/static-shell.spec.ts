import { AxeBuilder } from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const expectSeriousAccessibilityViolations = async (page: Page): Promise<void> => {
  const results = await new AxeBuilder({ page }).analyze();
  const seriousViolations = results.violations.filter(
    ({ impact }) => impact === "serious" || impact === "critical"
  );
  expect(seriousViolations, JSON.stringify(seriousViolations, null, 2)).toEqual([]);
};

test.describe("built public static shell", () => {
  test("renders the public home route without serious accessibility violations", async ({
    page,
  }) => {
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
});
