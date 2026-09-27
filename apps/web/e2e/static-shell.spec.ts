import { AxeBuilder } from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const expectSeriousAccessibilityViolations = (page: Page): Promise<void> =>
  new AxeBuilder({ page }).analyze().then((results) => {
    const seriousViolations = results.violations.filter(
      ({ impact }) => impact === "serious" || impact === "critical"
    );
    expect(seriousViolations, JSON.stringify(seriousViolations, null, 2)).toEqual([]);
  });

test.describe("built public static shell", () => {
  test("renders the public home route without serious accessibility violations", ({ page }) =>
    page
      .goto("/")
      .then(() => expect(page).toHaveTitle("fidy"))
      .then(() => expect(page.getByRole("heading", { level: 1, name: "Fidy" })).toBeVisible())
      .then(() => expectSeriousAccessibilityViolations(page)));

  test("renders the policy route without serious accessibility violations", ({ page }) =>
    page
      .goto("/politica")
      .then(() =>
        expect(
          page.getByRole("heading", {
            level: 1,
            name: "Política de tratamiento de datos personales",
          })
        ).toBeVisible()
      )
      .then(() => expectSeriousAccessibilityViolations(page)));

  test("renders not-found behavior without serious accessibility violations", ({ page }) =>
    page
      .goto("/ruta-inexistente")
      .then(() => expect(page.getByRole("heading", { name: "Página no encontrada" })).toBeVisible())
      .then(() => expectSeriousAccessibilityViolations(page)));
});
