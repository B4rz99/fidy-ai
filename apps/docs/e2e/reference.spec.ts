import { expect, test } from "@playwright/test";

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`${viewport.name} readers can navigate the filtered schema without returning to a hidden schema`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/referencia/esquemas");
    const filter = page.getByRole("searchbox", { name: "Buscar por nombre de esquema" });
    await filter.fill("ValidationFailedEncoded");
    const selected = page.locator("#schema-ValidationFailedEncoded");
    await expect(
      selected.getByRole("heading", { name: "ValidationFailedEncoded", exact: true })
    ).toBeVisible();
    if (viewport.name === "mobile") {
      await page.getByRole("button", { name: "En esta página", exact: true }).click();
    }
    await page.getByRole("link", { name: "Propiedades", exact: true }).click();
    await expect(page).toHaveURL(/#schema-ValidationFailedEncoded-propiedades$/u);
    await expect(filter).toHaveValue("ValidationFailedEncoded");
    await expect(selected.getByRole("table").first()).toBeInViewport();
    if (viewport.name === "mobile") {
      await page.getByRole("button", { name: "En esta página", exact: true }).click();
    }
    await page.getByRole("link", { name: "JSON completo", exact: true }).click();
    await expect(page).toHaveURL(/#schema-ValidationFailedEncoded-json-completo$/u);
    await expect(
      selected.getByRole("heading", { name: "JSON completo", exact: true })
    ).toBeInViewport();
    await filter.fill("");
    if (viewport.name === "mobile") {
      await page.getByRole("button", { name: "En esta página", exact: true }).click();
    }
    await page.getByRole("link", { name: "Propiedades", exact: true }).click();
    await expect(page).toHaveURL(/#propiedades$/u);
    await expect(
      page.locator("#schema-CreateBudgetInput_1").getByRole("table").first()
    ).toBeInViewport();
  });
}

test("schema deep links and reader selection update the contextual table of contents", async ({
  page,
}) => {
  await page.goto("/referencia/esquemas#schema-ValidationFailedEncoded");
  await page.getByRole("link", { name: "JSON completo", exact: true }).click();
  await expect(page).toHaveURL(/#schema-ValidationFailedEncoded-json-completo$/u);
  const filter = page.getByRole("searchbox", { name: "Buscar por nombre de esquema" });
  await filter.fill("zxq-no-schema");
  await expect(page.getByRole("link", { name: "Propiedades", exact: true })).toBeHidden();
  await page.goto("/referencia/esquemas#schema-TransactionOccurredAt");
  await expect(filter).toHaveValue("");
  await page.getByRole("link", { name: "JSON completo", exact: true }).click();
  await expect(page).toHaveURL(/#schema-TransactionOccurredAt-json-completo$/u);
  await expect(
    page
      .locator("#schema-TransactionOccurredAt")
      .getByRole("heading", { name: "JSON completo", exact: true })
  ).toBeInViewport();
  await page
    .locator("#schema-CategoryId")
    .getByRole("heading", { name: "CategoryId", exact: true })
    .click();
  await page.getByRole("link", { name: "JSON completo", exact: true }).click();
  await expect(page).toHaveURL(/#schema-CategoryId-json-completo$/u);
});

test("required request properties are labeled on their own rows", async ({ page }) => {
  await page.goto("/reference/transactions.createtransaction");
  const occurredAt = page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: /^occurredAt\b/u }) })
    .first();
  await expect(occurredAt.getByText("obligatorio", { exact: true })).toBeVisible();
  await expect(occurredAt.getByText("opcional", { exact: true })).toHaveCount(0);
});

test("JSON scrolling instructions follow actual overflow and preserve keyboard access", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/reference/budgets.listbudgets");
  const empty = page.getByRole("region", { name: "Parámetros HTTP", exact: true });
  const compact = empty.locator(".reference-json");
  await expect(compact.getByText("Desliza para ver el código completo")).toBeHidden();
  const compactHeight = 84;
  await expect.poll(async () => (await compact.boundingBox())?.height).toBe(compactHeight);
  await expect(compact.locator("pre")).toHaveText("[]");

  await page.goto("/reference/budgets.getbudget");
  const parameters = page.getByRole("region", { name: "Parámetros HTTP", exact: true });
  const operationPreviewHeight = 149;
  await expect
    .poll(async () => (await parameters.locator("pre").boundingBox())?.height)
    .toBe(operationPreviewHeight);
  await expect(parameters.getByText("Desliza para ver el código completo")).toBeVisible();

  await page.goto("/referencia/esquemas");
  const filter = page.getByRole("searchbox", { name: "Buscar por nombre de esquema" });
  await filter.fill("CanonicalOperationId");
  const panel = page.locator("#schema-CanonicalOperationId .reference-json");
  const instruction = panel.getByText("Desliza para ver el código completo");
  await expect(instruction).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(instruction).toBeVisible();
  const code = panel.locator("pre");
  await code.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => code.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(instruction).toBeHidden();

  await filter.fill("CreateBudgetInput_1");
  const vertical = page.locator("#schema-CreateBudgetInput_1 .reference-json");
  await expect(vertical.getByText("Desliza para ver el código completo")).toBeVisible();
  const longCode = vertical.locator("pre");
  await longCode.focus();
  await page.keyboard.press("End");
  await expect.poll(() => longCode.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});
