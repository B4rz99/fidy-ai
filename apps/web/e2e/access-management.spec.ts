import type { Page } from "@playwright/test";
import { Clock, Duration, Effect } from "effect";
import { apiOrigin, installCategories, installUser, makeUser, response } from "./http-fixtures";
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
type ConnectionReadState = "unavailable" | "unauthenticated" | "ready";
const unavailableStatus = 503;
const unauthenticatedStatus = 401;
const readyStatus = 200;
const installConnectionRead = (
  page: Page,
  state: Readonly<{ current: ConnectionReadState }>
): ReturnType<Page["route"]> =>
  page.route(`${apiOrigin}/web/oauth/connections**`, (route) => {
    const snapshots = {
      unavailable: { status: unavailableStatus, body: { error: "temporarily_unavailable" } },
      unauthenticated: { status: unauthenticatedStatus, body: { error: "unauthenticated" } },
      ready: { status: readyStatus, body: { connections: [connection], nextCursor: null } },
    };
    const snapshot = snapshots[state.current];
    return route.fulfill({
      status: snapshot.status,
      contentType: "application/json",
      body: JSON.stringify(snapshot.body),
    });
  });

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

const checkIdentityResume = Effect.fn(function* (page: Page, sameUser: boolean) {
  yield* Effect.tryPromise(() => installAccess(page));
  let mutations = 0;
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/pats`, (route) => {
      if (route.request().method() !== "GET") mutations += 1;
      return route.fulfill({
        contentType: "application/json",
        body: response({ pats: [token] }),
      });
    })
  );
  const expiresAt = (yield* Clock.currentTimeMillis) + Duration.toMillis(Duration.minutes(1));
  yield* Effect.tryPromise(() =>
    page.addInitScript(
      ({ userId, expiresAt }) => {
        window.sessionStorage.setItem(
          "fidy:pat-identity-confirmation",
          JSON.stringify({
            version: 1,
            userId,
            expiresAt,
            draft: { recipientLabel: "Retained review", scopes: ["read"], lifetimeDays: 7 },
          })
        );
      },
      {
        expiresAt,
        userId: sameUser ? makeUser().id : "24000000-0000-4000-8000-000000000242",
      }
    )
  );
  yield* Effect.tryPromise(() => page.goto("/settings/access?resume=pat"));
  const review = page.getByRole("region", { name: "Revisión del token" });
  if (sameUser) {
    yield* Effect.tryPromise(() => expect(review).toContainText("Retained review"));
    yield* Effect.tryPromise(() => expect(review).toContainText("7 días"));
  } else {
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Nombre", { exact: true })).toHaveValue("")
    );
    yield* Effect.tryPromise(() => expect(review).toHaveCount(0));
  }
  expect(
    yield* Effect.tryPromise(() =>
      page.evaluate(() => window.sessionStorage.getItem("fidy:pat-identity-confirmation"))
    )
  ).toBeNull();
  expect(mutations).toBe(0);
});
for (const sameUser of [true, false]) {
  test(`identity confirmation ${sameUser ? "restores the same User's review" : "discards another User's draft"} without issuing a token`, ({
    page,
  }) => Effect.runPromise(checkIdentityResume(page, sameUser)));
}

test("Accesos displays token and MCP metadata without horizontal overflow", ({ page }) =>
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
        expect(page.getByText("1 oct 2026", { exact: true })).toBeVisible()
      );
      for (const label of [
        "Desactivar",
        "Desactivar todos los tokens",
        "Revocar este agente",
        "Revocar todos los agentes conectados",
      ]) {
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("button", { name: label, exact: true })).toBeEnabled()
        );
      }
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
      const duration = page.getByRole("button", { name: /^Duración del token:/u });
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

test("temporary MCP list failure offers retry without asking to sign in", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installAccess(page));
      const state: { current: ConnectionReadState } = { current: "unavailable" };
      yield* Effect.tryPromise(() => installConnectionRead(page, state));
      yield* Effect.tryPromise(() => page.goto("/settings/access"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Actualizar lista" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Iniciar sesión de nuevo", { exact: true })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() => expect(page.getByText(token.recipientLabel)).toBeVisible());
      state.current = "ready";
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Actualizar lista" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("table", { name: "Conexiones MCP" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText(connection.claimedClientName)).toBeVisible()
      );
    })
  ));

test("unauthenticated MCP list still offers sign in", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installAccess(page));
      yield* Effect.tryPromise(() => installConnectionRead(page, { current: "unauthenticated" }));
      yield* Effect.tryPromise(() => page.goto("/settings/access"));
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Iniciar sesión de nuevo", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toHaveText("Inicia sesión para consultar tus conexiones.")
      );
      yield* Effect.tryPromise(() => expect(page.getByText(token.recipientLabel)).toBeVisible());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("table", { name: "Conexiones MCP" })).toHaveCount(0)
      );
    })
  ));
