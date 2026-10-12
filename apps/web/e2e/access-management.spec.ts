import type { Page } from "@playwright/test";
import { Effect } from "effect";
import { apiOrigin, installCategories, installUser, response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;
const connectionId = "10000000-0000-4000-8000-000000000001";
const token = {
  shortId: "sample01",
  recipientLabel: "Mi agente personal",
  scopes: ["read", "write", "dashboard"],
  createdAt: "2026-10-01T14:00:00Z",
  lastUsedAt: null,
  expiresAt: "2026-12-30T14:00:00Z",
};
const connection = {
  connectionId,
  claimedClientName: "Claude Desktop",
  scopes: ["read"],
  permissions: [{ scope: "read", label: "Lectura", description: "Consultar datos" }],
  expiresAt: "2026-12-01T14:00:00Z",
  state: "active",
  recentActivity: [],
};
const installAccess = (page: Page): Promise<void> =>
  installUser(page)
    .then(() =>
      page.route(`${apiOrigin}/pats`, (route) =>
        route.fulfill({
          contentType: "application/json",
          body: response({ pats: [token] }),
        })
      )
    )
    .then(() =>
      page.route(`${apiOrigin}/web/oauth/connections**`, (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ connections: [connection], nextCursor: null }),
        })
      )
    )
    .then(() => {});

const railGeometry = (rail: Element): Readonly<{ bottom: number; viewport: number }> => ({
  bottom: rail.getBoundingClientRect().bottom,
  viewport: window.innerHeight,
});
const revocationFollowsTable = (table: Element): boolean => {
  const button = Array.from(
    table.parentElement?.parentElement?.querySelectorAll("button") ?? []
  ).find((control) => control.textContent === "Revocar todos los agentes conectados");
  return (
    button !== undefined &&
    Boolean(table.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING)
  );
};
const documentWidths = (): Readonly<{ content: number; viewport: number }> => ({
  content: document.documentElement.scrollWidth,
  viewport: window.innerWidth,
});

const disclosedBearer = "fin_created1_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
const createdToken = { ...token, shortId: "created1", recipientLabel: "Agente nuevo" };
const installIssuance = (page: Page): ReturnType<Page["route"]> => {
  let issued = false;
  return page.route(`${apiOrigin}/pats`, (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        contentType: "application/json",
        body: response({ pats: issued ? [token, createdToken] : [token] }),
      });
    }
    issued = true;
    return route.fulfill({
      contentType: "application/json",
      body: response({
        bearer: disclosedBearer,
        pat: {
          ...createdToken,
          _tag: "PAT",
          id: "f1d1a000-0000-4000-8000-000000000248",
          lifetimeDays: 90,
          revokedAt: null,
          idleExpiresAt: createdToken.expiresAt,
        },
      }),
    });
  });
};

const installEmptyHistory = (page: Page): ReturnType<Page["route"]> =>
  page.route(`${apiOrigin}/transactions**`, (route) =>
    route.fulfill({ contentType: "application/json", body: response([]) })
  );

test("Accesos combines aligned token and MCP tables with a full-height creation rail", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => page.setViewportSize({ width: 1366, height: 978 }));
      yield* Effect.tryPromise(() => installAccess(page));
      yield* Effect.tryPromise(() => page.goto("/settings/access"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Accesos", exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("table", { name: "Tokens activos" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("table", { name: "Conexiones MCP" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Nunca", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("01-10-2026", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText(connectionId, { exact: true })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Actividad reciente", { exact: true })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Actualizar lista", exact: true })).toHaveCount(0)
      );
      const geometry = yield* Effect.tryPromise(() =>
        page.locator("main > div > aside").evaluate(railGeometry)
      );
      expect(geometry.bottom).toBeGreaterThanOrEqual(geometry.viewport);
      const order = yield* Effect.tryPromise(() =>
        page.getByRole("table", { name: "Conexiones MCP" }).evaluate(revocationFollowsTable)
      );
      expect(order).toBe(true);
      yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
      const widths = yield* Effect.tryPromise(() => page.evaluate(documentWidths));
      expect(widths.content).toBeLessThanOrEqual(widths.viewport);
    })
  ));

test("Accesos refreshes issued metadata and erases its one-time disclosure on navigation", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installAccess(page));
      yield* Effect.tryPromise(() => installIssuance(page));
      yield* Effect.tryPromise(() => installCategories({ page, categories: [] }));
      yield* Effect.tryPromise(() => installEmptyHistory(page));
      yield* Effect.tryPromise(() => page.goto("/settings/access"));
      yield* Effect.tryPromise(() =>
        page.getByLabel("Nombre", { exact: true }).fill("Agente nuevo")
      );
      yield* Effect.tryPromise(() => page.getByRole("checkbox", { name: /^Lectura:/u }).check());
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Crear token", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Confirmar y crear token", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText(disclosedBearer, { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page
            .getByRole("table", { name: "Tokens activos" })
            .getByText("Agente nuevo", { exact: true })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Transacciones", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Transacciones", exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page
          .getByRole("navigation", { name: "Aplicación", exact: true })
          .getByText("Ajustes", { exact: true })
          .click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("link", { name: "Accesos", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Nombre", { exact: true })).toHaveValue("")
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText(disclosedBearer, { exact: true })).toHaveCount(0)
      );
    })
  ));

test("narrow Accesos permits keyboard grant review and restores the draft for editing", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
      yield* Effect.tryPromise(() => installAccess(page));
      yield* Effect.tryPromise(() => page.goto("/settings/access"));
      const name = page.getByLabel("Nombre", { exact: true });
      yield* Effect.tryPromise(() => name.fill("Agente teclado"));
      yield* Effect.tryPromise(() => name.press("Tab"));
      const read = page.getByRole("checkbox", { name: /^Lectura:/u });
      yield* Effect.tryPromise(() => expect(read).toBeFocused());
      yield* Effect.tryPromise(() => read.press("Space"));
      yield* Effect.tryPromise(() => expect(read).toBeChecked());
      yield* Effect.tryPromise(() => page.keyboard.press("Tab"));
      yield* Effect.tryPromise(() => page.keyboard.press("Tab"));
      yield* Effect.tryPromise(() => page.keyboard.press("Tab"));
      const duration = page.getByRole("button", { name: "Duración del token", exact: true });
      yield* Effect.tryPromise(() => expect(duration).toBeFocused());
      yield* Effect.tryPromise(() => duration.press("Enter"));
      const sevenDays = page.getByRole("menuitemradio", { name: "7 días", exact: true });
      yield* Effect.tryPromise(() => sevenDays.press("Home"));
      yield* Effect.tryPromise(() => expect(sevenDays).toBeFocused());
      yield* Effect.tryPromise(() => sevenDays.press("Enter"));
      yield* Effect.tryPromise(() => expect(duration).toHaveText("7 días"));
      yield* Effect.tryPromise(() => duration.press("Tab"));
      const create = page.getByRole("button", { name: "Crear token", exact: true });
      yield* Effect.tryPromise(() => expect(create).toBeFocused());
      yield* Effect.tryPromise(() => create.press("Enter"));
      const review = page.getByRole("region", { name: "Revisión del token" });
      yield* Effect.tryPromise(() => expect(review).toBeVisible());
      const edit = review.getByRole("button", { name: "Editar", exact: true });
      yield* Effect.tryPromise(() => edit.focus());
      yield* Effect.tryPromise(() => edit.press("Enter"));
      yield* Effect.tryPromise(() => expect(name).toHaveValue("Agente teclado"));
      yield* Effect.tryPromise(() => expect(read).toBeChecked());
      yield* Effect.tryPromise(() => expect(duration).toHaveText("7 días"));
    })
  ));
