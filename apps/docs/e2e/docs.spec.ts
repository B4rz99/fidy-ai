import { AxeBuilder } from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

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
  const originalMarkdown = await context.request.get("/transacciones/registrar-corregir.md");
  expect(copied).toBe(await originalMarkdown.text());
  await page.getByRole("button", { name: "Buscar", exact: false }).click();
  await page.getByRole("textbox", { name: "Buscar", exact: true }).fill("corregir");
  await expect(
    page.getByRole("dialog", { name: "Buscar documentación" }).getByRole("link").first()
  ).toBeVisible();
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

test("readers can recover from an empty search and open a guide by keyboard", async ({ page }) => {
  await page.goto("/");
  const openSearch = page.getByRole("button", { name: "Buscar", exact: true });
  await openSearch.click();
  const search = page.getByRole("dialog", { name: "Buscar documentación" });
  await expect(search.getByText("¿Qué quieres hacer con Fidy?", { exact: true })).toBeVisible();
  const input = search.getByRole("textbox", { name: "Buscar", exact: true });
  await input.fill("zxq-no-result");
  await expect(search.getByRole("heading", { name: "Sin resultados" })).toBeVisible();
  await search.getByRole("button", { name: "Limpiar búsqueda" }).click();
  await expect(input).toBeFocused();
  await input.fill("corregir");
  await expect(
    search.getByRole("link", { name: "Registrar y corregir transacciones" })
  ).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator("h1")).toHaveText("Registrar y corregir transacciones");
  await page.keyboard.press("Control+k");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Buscar", exact: true })).toBeFocused();
});

test("reader theme choices persist without replacing automatic system preferences", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await page.getByRole("button", { name: "Elegir tema" }).click();
  await page.getByRole("radio", { name: "Oscuro", exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Elegir tema" }).click();
  await page.getByRole("radio", { name: "Automático", exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("search query text cannot inject markup into the documentation", async ({ page }) => {
  await page.goto("/");
  const initialTitle = await page.title();
  await page.getByRole("button", { name: "Buscar", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Buscar documentación" });
  const input = dialog.getByRole("textbox", { name: "Buscar", exact: true });
  const query = '<img src=x onerror="document.title=123">zxq-no-result';
  await input.fill(query);
  await expect(dialog.getByRole("status")).toHaveText(/^\d+ resultados$/u);
  await expect(input).toHaveValue(query);
  await expect(dialog.locator("img")).toHaveCount(0);
  await expect(page).toHaveTitle(initialTitle);
});

test("an invalid stored theme falls back to the current system preference", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(() => window.localStorage.setItem("starlight-theme", "unknown-theme"));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Elegir tema" }).click();
  await expect(page.getByRole("radio", { name: "Automático", exact: true })).toBeChecked();
  await page.keyboard.press("Escape");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

const searchBoundaryModule = `
export async function options() {}
export async function search(term) {
  const examples = {
    trusted: [{ url: "/conectar/mcp" }],
    hostile: [
      { url: "https://example.invalid/conectar/mcp" },
      { url: "//example.invalid/conectar/mcp" },
      { url: "javascript:document.title='Injected'" },
      { url: "data:text/html,<img src=x onerror=alert(1)>" },
      { url: "/unknown-document" }
    ],
    mixed: [
      { url: "https://example.invalid/conectar/mcp" },
      { url: "/transacciones/registrar-corregir", meta: { title: "<img src=x onerror=alert(1)>" } },
      { url: "/unknown-document" }
    ],
    malformed: [{ url: "/conectar/mcp" }, { url: 42 }],
    invalidUrl: [{ url: "/conectar/mcp" }, { url: "http://[" }]
  };
  if (term === "invalidResponse") return { results: "not an array" };
  return { results: (examples[term] ?? []).map(value => ({ data: async () => value })) };
}
`;
const installSearchBoundary = async (page: Page): Promise<void> => {
  await page.route("**/pagefind/pagefind.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: searchBoundaryModule })
  );
};

test("search results cannot introduce an external destination or unknown documentation link", async ({
  page,
}) => {
  await installSearchBoundary(page);
  await page.goto("/");
  const initialTitle = await page.title();
  await page.getByRole("button", { name: "Buscar", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Buscar documentación" });
  const input = dialog.getByRole("textbox", { name: "Buscar", exact: true });
  await input.fill("hostile");
  await expect(dialog.getByRole("heading", { name: "Sin resultados" })).toBeVisible();
  await expect(dialog.getByRole("link")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/");
  await expect(page).toHaveTitle(initialTitle);
  await expect(dialog.locator("img")).toHaveCount(0);
  await input.fill("mixed");
  await expect(dialog.getByRole("status")).toHaveText("1 resultados");
  const result = dialog.getByRole("link");
  await expect(result).toHaveCount(1);
  await expect(result).toHaveAttribute("href", "/transacciones/registrar-corregir");
  await expect(result).toContainText("Registrar y corregir transacciones");
  await expect(dialog.locator("img")).toHaveCount(0);
  await result.click();
  await expect(page).toHaveURL("/transacciones/registrar-corregir");
});

for (const query of ["malformed", "invalidUrl", "invalidResponse"]) {
  test(`search clears previously valid results when the returned ${query} contract is invalid`, async ({
    page,
  }) => {
    await installSearchBoundary(page);
    await page.goto("/");
    const initialTitle = await page.title();
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Buscar documentación" });
    const input = dialog.getByRole("textbox", { name: "Buscar", exact: true });
    await input.fill("trusted");
    await expect(dialog.getByRole("link")).toHaveAttribute("href", "/conectar/mcp");
    await input.fill(query);
    await expect(dialog.getByRole("status")).toHaveText(
      "No se pudo cargar la búsqueda. Cierra e inténtalo de nuevo."
    );
    await expect(dialog.getByRole("link")).toHaveCount(0);
    await expect(dialog.locator("img")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/");
    await expect(page).toHaveTitle(initialTitle);
  });
}

test("medium-width home readers retain one working Markdown action pair", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  const markdown = page.getByRole("link", { name: "Ver Markdown", exact: true });
  const copy = page.getByRole("button", { name: "Copiar Markdown", exact: true });
  await expect(markdown).toHaveCount(1);
  await expect(copy).toHaveCount(1);
  await expect(markdown).toHaveAttribute("href", "/index.md");
  await copy.click();
  await expect(page.getByRole("status")).toContainText("Markdown copiado");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("# Guía de Fidy");
});
