import { CreateManualPATPayload } from "@fidy/server/client";
import type { Page, Route } from "@playwright/test";
import { type Cause, Clock, Deferred, Duration, Effect, Schema } from "effect";
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

const editReviewedGrant = Effect.fn(function* (page: Page) {
  yield* Effect.tryPromise(() => page.goto("/settings/access"));
  const name = page.getByLabel("Nombre", { exact: true });
  yield* Effect.tryPromise(() => name.fill("  Primer agente  "));
  yield* Effect.tryPromise(() => page.getByRole("checkbox", { name: /^Lectura:/u }).check());
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Crear token", exact: true }).click()
  );
  const review = page.getByRole("region", { name: "Revisión del token" });
  yield* Effect.tryPromise(() => review.getByRole("button", { name: "Editar" }).click());
  yield* Effect.tryPromise(() => name.fill("  Agente editado  "));
  yield* Effect.tryPromise(() => page.getByRole("checkbox", { name: /^Lectura:/u }).uncheck());
  yield* Effect.tryPromise(() => page.getByRole("checkbox", { name: /^Escritura:/u }).check());
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: /^Duración del token:/u }).click()
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("menuitemradio", { name: "7 días", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Crear token", exact: true }).click()
  );
  yield* Effect.tryPromise(() => expect(review).toContainText("Agente editado"));
  yield* Effect.tryPromise(() => expect(review).toContainText("Escritura"));
  yield* Effect.tryPromise(() => expect(review).not.toContainText("Lectura"));
  yield* Effect.tryPromise(() => expect(review).toContainText("Vencimiento estimado"));
  yield* Effect.tryPromise(() =>
    expect(review).toContainText(
      "El vencimiento exacto se calculará al crear el token, 7 días después."
    )
  );
  return review;
});
const checkReviewedIssuance = Effect.fn(function* (page: Page) {
  yield* Effect.tryPromise(() => installAccess(page));
  yield* Effect.tryPromise(() => installIssuance(page));
  const submissions: unknown[] = [];
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/pats`, (route) => {
      if (route.request().method() === "POST") {
        submissions.push(route.request().postDataJSON());
      }
      return route.fallback();
    })
  );
  const review = yield* editReviewedGrant(page);
  const reviewExpiresAt = yield* Effect.tryPromise(() =>
    review.locator("time").getAttribute("datetime")
  );
  expect(submissions).toHaveLength(0);
  yield* Effect.tryPromise(() =>
    review
      .getByRole("button", { name: "Confirmar y crear token", exact: true })
      .evaluate((button) => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      })
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByText(disclosedBearer, { exact: true })).toBeVisible()
  );
  expect(submissions).toEqual([
    {
      requestId: expect.stringMatching(/^[\da-f-]{36}$/u),
      grant: {
        recipientLabel: "Agente editado",
        scopes: ["write"],
        lifetimeDays: 7,
        reviewExpiresAt,
      },
    },
  ]);
});
test("Accesos issues only the newly reviewed grant once after permission and lifetime edits", ({
  page,
}) => Effect.runPromise(checkReviewedIssuance(page)));

const checkPagehideActions = Effect.fn(function* (page: Page) {
  yield* Effect.tryPromise(() => installAccess(page));
  yield* Effect.tryPromise(() => page.goto("/settings/access"));
  const name = page.getByLabel("Nombre", { exact: true });
  yield* Effect.tryPromise(() => name.fill("Agente anterior"));
  yield* Effect.tryPromise(() => page.getByRole("checkbox", { name: /^Lectura:/u }).check());
  yield* Effect.tryPromise(() =>
    name.evaluate((input) => {
      if (!(input instanceof HTMLInputElement)) return;
      const form = input.form;
      window.dispatchEvent(new PageTransitionEvent("pagehide"));
      input.select();
      input.setRangeText("Acción anterior");
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      form?.requestSubmit();
    })
  );
  yield* Effect.tryPromise(() => expect(name).toHaveValue(""));
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("checkbox", { name: /^Lectura:/u })).not.toBeChecked()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("region", { name: "Revisión del token" })).toHaveCount(0)
  );
  yield* Effect.tryPromise(() =>
    page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")))
  );
  yield* Effect.tryPromise(() => name.fill("Nueva revisión"));
  yield* Effect.tryPromise(() => page.getByRole("checkbox", { name: /^Lectura:/u }).check());
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Crear token", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("region", { name: "Revisión del token" })).toContainText("Nueva revisión")
  );
});
test("Accesos refuses pending draft actions after pagehide clears the task", ({ page }) =>
  Effect.runPromise(checkPagehideActions(page)));

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
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("table", { name: "Tokens activos" }).getByText(token.recipientLabel)
        ).toBeVisible()
      );
      state.current = "ready";
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Actualizar lista" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("table", { name: "Conexiones MCP" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page
            .getByRole("table", { name: "Conexiones MCP" })
            .getByText(connection.claimedClientName)
        ).toBeVisible()
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
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("table", { name: "Tokens activos" }).getByText(token.recipientLabel)
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("table", { name: "Conexiones MCP" })).toHaveCount(0)
      );
    })
  ));

const reviewNewPAT = Effect.fn(function* (page: Page) {
  yield* Effect.tryPromise(() => page.goto("/settings/access"));
  yield* Effect.tryPromise(() => page.getByLabel("Nombre", { exact: true }).fill("Agente nuevo"));
  yield* Effect.tryPromise(() => page.getByRole("checkbox", { name: /^Lectura:/u }).check());
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Crear token", exact: true }).click()
  );
});
type UnknownOutcome = "undecodable" | "lost" | "consumed";
type UnknownFixture = { submissions: unknown[]; metadataFails: boolean };
const installUnknownIssuance = (
  page: Page,
  outcome: UnknownOutcome,
  state: UnknownFixture
): Promise<void> =>
  page
    .route(`${apiOrigin}/pats`, (route) => {
      if (route.request().method() === "POST") {
        state.submissions.push(route.request().postDataJSON());
        if (outcome === "lost") return route.abort("failed");
        if (outcome === "consumed") {
          return route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              error: {
                code: "user_action_required",
                message:
                  "This manual PAT issuance request was already consumed. Start a new reviewed request.",
              },
              next: [],
            }),
          });
        }
        return route.fulfill({
          contentType: "application/json",
          body: response({ unexpected: disclosedBearer }),
        });
      }
      return route.fulfill({
        status: state.metadataFails ? unavailableStatus : readyStatus,
        contentType: "application/json",
        body: state.metadataFails
          ? JSON.stringify({ error: { code: "unavailable", message: "Unavailable" }, next: [] })
          : response({ pats: state.submissions.length > 0 ? [token, createdToken] : [token] }),
      });
    })
    .then(() => {});
const checkUnknownIssuance = Effect.fn(function* (page: Page, outcome: UnknownOutcome) {
  yield* Effect.tryPromise(() => installAccess(page));
  const state: UnknownFixture = { submissions: [], metadataFails: false };
  yield* Effect.tryPromise(() => installUnknownIssuance(page, outcome, state));
  yield* reviewNewPAT(page);
  const requestPromise = page.waitForRequest(
    (request) => request.method() === "POST" && request.url() === `${apiOrigin}/pats`
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Confirmar y crear token", exact: true }).click()
  );
  const submitted = yield* Effect.tryPromise(() => requestPromise);
  const submittedPayload = yield* Schema.decodeUnknownEffect(
    Schema.toCodecJson(CreateManualPATPayload)
  )(submitted.postDataJSON());
  const requestId = submittedPayload.requestId;
  const uncertainty = page.getByRole("region", { name: "Creación sin confirmar" });
  yield* Effect.tryPromise(() => expect(uncertainty).toContainText(requestId));
  yield* Effect.tryPromise(() => expect(uncertainty).toContainText("Agente nuevo"));
  yield* Effect.tryPromise(() =>
    expect(page.getByText(disclosedBearer, { exact: true })).toHaveCount(0)
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("button", { name: "Volver a la revisión", exact: true })).toHaveCount(0)
  );
  expect(state.submissions).toHaveLength(1);
  // Every fault has reached the same cause-free Uncertain state; inspect its lifecycle once.
  if (outcome !== "lost") return;
  state.metadataFails = true;
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Actualizar tokens", exact: true }).press("Enter")
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByText("No pudimos actualizar tus tokens")).toBeVisible()
  );
  yield* Effect.tryPromise(() => expect(uncertainty).toBeVisible());
  state.metadataFails = false;
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Actualizar tokens", exact: true }).press("Enter")
  );
  yield* Effect.tryPromise(() =>
    expect(
      page.getByRole("table", { name: "Tokens activos" }).getByText("Agente nuevo", { exact: true })
    ).toBeVisible()
  );
  yield* Effect.tryPromise(() =>
    expect(uncertainty).toContainText("La lista no confirma el resultado de esta solicitud")
  );
  expect(state.submissions).toHaveLength(1);
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Revisé los tokens; preparar otro", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Nombre", { exact: true })).toHaveValue("Agente nuevo")
  );
  expect(state.submissions).toHaveLength(1);
});
for (const outcome of ["undecodable", "lost", "consumed"] as const) {
  test(`Accesos retains a ${outcome} issuance without replay${outcome === "lost" ? " through failed and successful metadata inspection" : ""}`, ({
    page,
  }) => Effect.runPromise(checkUnknownIssuance(page, outcome)));
}

type IssuanceRefusal = Readonly<{ status: number; error: unknown }>;
const installIssuanceRefusal = (
  page: Page,
  refusal: IssuanceRefusal,
  submitted: (payload: CreateManualPATPayload) => void
): Promise<void> =>
  page
    .route(`${apiOrigin}/pats`, (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      submitted(
        Schema.decodeUnknownSync(Schema.toCodecJson(CreateManualPATPayload))(
          route.request().postDataJSON()
        )
      );
      return route.fulfill({
        status: refusal.status,
        contentType: "application/json",
        body: JSON.stringify({ error: refusal.error, next: [] }),
      });
    })
    .then(() => {});
const checkReviewRefusal = Effect.fn(function* (page: Page) {
  yield* Effect.tryPromise(() => installAccess(page));
  const requestIds: string[] = [];
  yield* Effect.tryPromise(() =>
    installIssuanceRefusal(
      page,
      {
        status: 422,
        error: {
          code: "user_action_required",
          message:
            "This PAT review is stale or inconsistent. Review the grant again before creating it.",
        },
      },
      (payload) => {
        requestIds.push(payload.requestId);
      }
    )
  );
  yield* reviewNewPAT(page);
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Confirmar y crear token", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(
      page.getByText(
        "La revisión venció. Revisa de nuevo los permisos y la duración antes de crear el token.",
        { exact: true }
      )
    ).toBeVisible()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("region", { name: "Creación sin confirmar" })).toHaveCount(0)
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Revisar de nuevo", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Nombre", { exact: true })).toHaveValue("Agente nuevo")
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Crear token", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Confirmar y crear token", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("button", { name: "Revisar de nuevo", exact: true })).toBeVisible()
  );
  expect(requestIds).toHaveLength(2);
  expect(requestIds[1]).not.toBe(requestIds[0]);
});
test("Accesos renews an expired review after a definitive refusal without reusing its request identity", ({
  page,
}) => Effect.runPromise(checkReviewRefusal(page)));

const rateRefusalAdvance = 4_000;
const checkRateRefusal = Effect.fn(function* (page: Page) {
  yield* Effect.tryPromise(() => page.clock.install());
  yield* Effect.tryPromise(() => installAccess(page));
  let mutations = 0;
  yield* Effect.tryPromise(() =>
    installIssuanceRefusal(
      page,
      {
        status: 429,
        error: {
          code: "rate_limited",
          message:
            "This User has created too many PATs recently. Wait for the retry interval before trying again.",
          retryAfterSeconds: 3,
        },
      },
      () => {
        mutations += 1;
      }
    )
  );
  yield* reviewNewPAT(page);
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Confirmar y crear token", exact: true }).click()
  );
  const review = page.getByRole("button", { name: "Revisar de nuevo", exact: true });
  yield* Effect.tryPromise(() => expect(review).toBeDisabled());
  yield* Effect.tryPromise(() =>
    expect(page.getByText("No se creó el token", { exact: true })).toBeVisible()
  );
  yield* Effect.tryPromise(() => page.clock.fastForward(rateRefusalAdvance));
  yield* Effect.tryPromise(() => expect(review).toBeEnabled());
  yield* Effect.tryPromise(() => review.click());
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Nombre", { exact: true })).toHaveValue("Agente nuevo")
  );
  expect(mutations).toBe(1);
});
test("Accesos honors a declared issuance rate refusal before permitting a new review", ({ page }) =>
  Effect.runPromise(checkRateRefusal(page)));

const issuanceRefusals = [
  {
    title: "input",
    status: 400,
    error: {
      code: "validation_failed",
      message: "Invalid reviewed grant",
      fields: [{ path: "grant", message: "Invalid grant" }],
    },
    expected: "Revisa el nombre, los permisos y la duración antes de crear el token.",
    action: "Revisar de nuevo",
  },
  {
    title: "Consent",
    status: 403,
    error: { code: "consent_required", message: "Current Consent is required" },
    expected:
      "Necesitas una autorización de tratamiento vigente para crear el token. Iniciar sesión no la renueva.",
    action: "Revisar privacidad",
  },
] as const;
const checkDeclaredRefusal = Effect.fn(function* (
  page: Page,
  refusal: (typeof issuanceRefusals)[number]
) {
  yield* Effect.tryPromise(() => installAccess(page));
  let mutations = 0;
  yield* Effect.tryPromise(() =>
    installIssuanceRefusal(page, refusal, () => {
      mutations += 1;
    })
  );
  yield* reviewNewPAT(page);
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Confirmar y crear token", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByText(refusal.expected, { exact: true })).toBeVisible()
  );
  yield* Effect.tryPromise(() =>
    expect(
      page.getByRole(refusal.title === "Consent" ? "link" : "button", {
        name: refusal.action,
        exact: true,
      })
    ).toBeVisible()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("region", { name: "Creación sin confirmar" })).toHaveCount(0)
  );
  expect(mutations).toBe(1);
});
for (const refusal of issuanceRefusals) {
  test(`Accesos distinguishes a definitive ${refusal.title} refusal from an unknown issuance`, ({
    page,
  }) => Effect.runPromise(checkDeclaredRefusal(page, refusal)));
}

const installTestClipboard = (page: Page, delayed: boolean): Promise<void> =>
  page
    .addInitScript((delayWrite) => {
      let value = "";
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          readText: (): Promise<string> => Promise.resolve(value),
          writeText: (next: string): Promise<void> => {
            if (delayWrite && next !== "") {
              return (() => {
                const { promise, resolve } = Promise.withResolvers<void>();
                window.addEventListener(
                  "acknowledge-sensitive-copy",
                  () => {
                    value = next;
                    resolve();
                  },
                  { once: true }
                );
                return promise;
              })();
            }
            value = next;
            return Promise.resolve();
          },
        },
      });
    }, delayed)
    .then(() => {});
const beforeDisclosureDeadline = 540_000;
const afterDisclosureDeadline = 61_000;
const checkDisclosureDeadline = Effect.fn(function* (page: Page) {
  yield* Effect.tryPromise(() => page.clock.install());
  yield* Effect.tryPromise(() => installTestClipboard(page, false));
  yield* Effect.tryPromise(() => installAccess(page));
  yield* Effect.tryPromise(() => installIssuance(page));
  yield* reviewNewPAT(page);
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Confirmar y crear token", exact: true }).click()
  );
  const bearer = page.getByText(disclosedBearer, { exact: true });
  yield* Effect.tryPromise(() => expect(bearer).toBeVisible());
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Copiar token", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("button", { name: "Copiado", exact: true })).toBeVisible()
  );
  expect(yield* Effect.tryPromise(() => page.evaluate(() => navigator.clipboard.readText()))).toBe(
    disclosedBearer
  );
  yield* Effect.tryPromise(() => page.clock.fastForward(beforeDisclosureDeadline));
  yield* Effect.tryPromise(() => expect(bearer).toBeVisible());
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Copiado", exact: true }).click()
  );
  yield* Effect.tryPromise(() => page.clock.fastForward(afterDisclosureDeadline));
  yield* Effect.tryPromise(() => expect(bearer).toHaveCount(0));
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Nombre", { exact: true })).toHaveValue("")
  );
  yield* Effect.tryPromise(() => expect.poll(() => readTestClipboard(page)).toBe(""));
});
test("Accesos clears disclosure and matching clipboard at its original deadline despite another copy", ({
  page,
}) => Effect.runPromise(checkDisclosureDeadline(page)));

const readTestClipboard = (page: Page): Promise<string> =>
  page.evaluate(() => navigator.clipboard.readText());
const checkLateCopy = Effect.fn(function* (page: Page) {
  yield* Effect.tryPromise(() => installTestClipboard(page, true));
  yield* Effect.tryPromise(() => installAccess(page));
  yield* Effect.tryPromise(() => installIssuance(page));
  yield* reviewNewPAT(page);
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Confirmar y crear token", exact: true }).click()
  );
  const copy = page.getByRole("button", { name: "Copiar token", exact: true });
  yield* Effect.tryPromise(() => copy.click());
  yield* Effect.tryPromise(() => expect(copy).toBeVisible());
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("button", { name: "Copiado", exact: true })).toHaveCount(0)
  );
  yield* Effect.tryPromise(() =>
    page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")))
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Nombre", { exact: true })).toHaveValue("")
  );
  yield* Effect.tryPromise(() =>
    page.evaluate(() => window.dispatchEvent(new Event("acknowledge-sensitive-copy")))
  );
  yield* Effect.tryPromise(() => expect.poll(() => readTestClipboard(page)).toBe(""));
  yield* Effect.tryPromise(() =>
    expect(page.getByText(disclosedBearer, { exact: true })).toHaveCount(0)
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("button", { name: "Copiado", exact: true })).toHaveCount(0)
  );
});
test("Accesos acknowledges copying only after the write and fences a late acknowledgement after leaving", ({
  page,
}) => Effect.runPromise(checkLateCopy(page)));

const releaseIssuance = (route: Route, pending: Promise<void>): Promise<void> =>
  pending.then(() => route.fallback());
const checkLateIssuance = Effect.fn(function* (page: Page) {
  yield* Effect.tryPromise(() => installAccess(page));
  yield* Effect.tryPromise(() => installIssuance(page));
  const pending = yield* Deferred.make<void>();
  const context = yield* Effect.context<never>();
  const awaiting = Effect.runPromiseWith(context)(Deferred.await(pending));
  let mutations = 0;
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/pats`, (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      mutations += 1;
      return releaseIssuance(route, awaiting);
    })
  );
  yield* reviewNewPAT(page);
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Confirmar y crear token", exact: true }).click()
  );
  yield* Effect.tryPromise(() => expect.poll(() => mutations).toBe(1));
  yield* Effect.tryPromise(() =>
    page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")))
  );
  yield* Effect.tryPromise(() => page.getByLabel("Nombre", { exact: true }).fill("Nueva tarea"));
  const completed = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url() === `${apiOrigin}/pats`
  );
  yield* Deferred.succeed(pending, undefined);
  yield* Effect.tryPromise(() => completed);
  yield* Effect.tryPromise(() =>
    expect(page.getByText(disclosedBearer, { exact: true })).toHaveCount(0)
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Nombre", { exact: true })).toHaveValue("Nueva tarea")
  );
  expect(mutations).toBe(1);
});
test("Accesos never discloses a late issuance result into the task created after pagehide", ({
  page,
}) => Effect.runPromise(checkLateIssuance(page)));

const reviewTokenForRevocation = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() => page.getByRole("button", { name: "Desactivar", exact: true }).click());
const confirmRevocationTwice = (page: Page, all = false): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    page
      .getByRole("button", { name: all ? "Sí, desactivar todos" : "Sí, desactivar", exact: true })
      .evaluate((button) => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      })
  );
const recoverPATMetadata = (page: Page): Promise<void> =>
  page.getByRole("button", { name: "Comprobar estado de tokens", exact: true }).click();
const refreshPATMetadata = (page: Page): Promise<void> =>
  page.getByRole("button", { name: "Actualizar tokens", exact: true }).press("Enter");
const checkUnknownRevocation = Effect.fn(function* (page: Page) {
  yield* Effect.tryPromise(() => page.setViewportSize({ width: 1440, height: 1100 }));
  yield* Effect.tryPromise(() => installAccess(page));
  let mutations = 0,
    current = true,
    failRead = false;
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/pats**`, (route) => {
      if (route.request().method() === "DELETE") {
        mutations += 1;
        current = false;
        return route.fulfill({ status: 200, contentType: "application/json", body: "{" });
      }
      return failRead
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              error: { code: "unavailable", message: "Unavailable" },
              next: [],
            }),
          })
        : route.fulfill({
            contentType: "application/json",
            body: response({ pats: current ? [token] : [] }),
          });
    })
  );
  yield* Effect.tryPromise(() => page.goto("/settings/access"));
  yield* reviewTokenForRevocation(page);
  yield* confirmRevocationTwice(page);
  yield* uncertainRevocation(page);
  failRead = true;
  yield* Effect.tryPromise(() => recoverPATMetadata(page));
  yield* Effect.tryPromise(() =>
    expect(page.getByText("No pudimos actualizar tus tokens", { exact: true })).toBeVisible()
  );
  yield* Effect.tryPromise(() =>
    expect(
      page.getByRole("button", { name: "Desactivar todos los tokens", exact: true })
    ).toBeDisabled()
  );
  yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
  failRead = false;
  yield* Effect.tryPromise(() => recoverPATMetadata(page));
  yield* Effect.tryPromise(() =>
    expect(
      page.getByText(
        "El token ya no figura activo. Esto no confirma el resultado de la desactivación anterior.",
        { exact: true }
      )
    ).toBeVisible()
  );
  yield* Effect.tryPromise(() =>
    expect(
      page.getByRole("button", { name: "Desactivar todos los tokens", exact: true })
    ).toBeEnabled()
  );
  expect(mutations).toBe(1);
});
test("Accesos recovers unknown revocation by explicit metadata reads without replay or fabricated receipt", ({
  page,
}) => Effect.runPromise(checkUnknownRevocation(page)));

type ManagementFixture = {
  pats: (typeof token)[];
  mutations: string[];
  reply: "lost" | "acknowledged" | "refused" | "unavailable";
};
const installManagement = (page: Page, fixture: ManagementFixture): Promise<void> =>
  installAccess(page)
    .then(() =>
      page.route(`${apiOrigin}/pats**`, (route) => {
        if (route.request().method() !== "DELETE") {
          return route.fulfill({
            contentType: "application/json",
            body: response({ pats: fixture.pats }),
          });
        }
        const path = new URL(route.request().url()).pathname;
        fixture.mutations.push(path);
        switch (fixture.reply) {
          case "lost":
            return route.fulfill({ status: 200, contentType: "application/json", body: "{" });
          case "acknowledged":
            return route.fulfill({
              contentType: "application/json",
              body: response(path === "/pats" ? { revokedCount: 7 } : { shortId: token.shortId }),
            });
          case "refused":
            return route.fulfill({
              status: 404,
              contentType: "application/json",
              body: JSON.stringify({
                error: { code: "not_found", message: "Not found" },
                next: [],
              }),
            });
          case "unavailable":
            return route.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({
                error: { code: "unavailable", message: "Unavailable" },
                next: [],
              }),
            });
        }
      })
    )
    .then(() => {});
const reviewAllTokens = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    page.getByRole("button", { name: "Desactivar todos los tokens", exact: true }).click()
  );
const uncertainRevocation = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    expect(page.getByText("Desactivación sin confirmar", { exact: true })).toBeVisible()
  );

const checkAggregateRecovery = Effect.fn(function* (page: Page) {
  const fixture: ManagementFixture = { pats: [token], mutations: [], reply: "lost" };
  yield* Effect.tryPromise(() => installManagement(page, fixture));
  yield* Effect.tryPromise(() => page.goto("/settings/access"));
  yield* reviewAllTokens(page);
  yield* confirmRevocationTwice(page, true);
  yield* uncertainRevocation(page);
  fixture.pats = [];
  yield* Effect.tryPromise(() => recoverPATMetadata(page));
  const unknown = page.getByText(
    "La lista está actualizada. El resultado de la desactivación anterior y su cantidad siguen sin confirmar; la lista no confirma el cierre de autorizaciones pendientes.",
    { exact: true }
  );
  yield* Effect.tryPromise(() => expect(unknown).toBeVisible());
  yield* Effect.tryPromise(() =>
    expect(page.getByText("No tienes tokens activos.", { exact: true })).toBeVisible()
  );
  fixture.pats = [{ ...token, shortId: "issued02", recipientLabel: "Agente posterior" }];
  yield* Effect.tryPromise(() => refreshPATMetadata(page));
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("table", { name: "Tokens activos" })).toContainText("Agente posterior")
  );
  yield* Effect.tryPromise(() => expect(unknown).toBeVisible());
  yield* reviewAllTokens(page);
  yield* Effect.tryPromise(() => expect(unknown).toBeVisible());
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Cancelar", exact: true }).click()
  );
  expect(fixture.mutations).toEqual(["/pats"]);
});
test("Accesos preserves an unknown aggregate count through empty reads, concurrent issuance and a new review", ({
  page,
}) => Effect.runPromise(checkAggregateRecovery(page)));

const competeRevocationReviews = (button: HTMLElement | SVGElement): void => {
  const aggregate = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.getAttribute("aria-label") === "Desactivar todos los tokens"
  );
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  aggregate?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
};
const checkCompetingRevocation = Effect.fn(function* (page: Page) {
  const fixture: ManagementFixture = { pats: [token], mutations: [], reply: "acknowledged" };
  yield* Effect.tryPromise(() => installManagement(page, fixture));
  yield* Effect.tryPromise(() => page.goto("/settings/access"));
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Desactivar", exact: true }).evaluate(competeRevocationReviews)
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("button", { name: "Sí, desactivar", exact: true })).toBeVisible()
  );
  yield* confirmRevocationTwice(page);
  yield* Effect.tryPromise(() =>
    expect(
      page.getByText(
        `Token desactivado. Dejó de funcionar de inmediato. Identificador: ${token.shortId}.`,
        { exact: true }
      )
    ).toBeVisible()
  );
  expect(fixture.mutations).toEqual([`/pats/${token.shortId}`]);
  yield* reviewAllTokens(page);
  yield* confirmRevocationTwice(page, true);
  yield* Effect.tryPromise(() =>
    expect(page.getByText("Se desactivaron 7 tokens activos.", { exact: true })).toBeVisible()
  );
  expect(fixture.mutations).toEqual([`/pats/${token.shortId}`, "/pats"]);
});
test("Accesos serializes same-tick single and aggregate reviews and acknowledges exact command results once", ({
  page,
}) => Effect.runPromise(checkCompetingRevocation(page)));

const checkRetainedReview = Effect.fn(function* (page: Page) {
  const fixture: ManagementFixture = { pats: [token], mutations: [], reply: "acknowledged" };
  yield* Effect.tryPromise(() => installManagement(page, fixture));
  yield* Effect.tryPromise(() => page.goto("/settings/access"));
  yield* reviewTokenForRevocation(page);
  fixture.pats = [{ ...token, recipientLabel: "Nombre actualizado" }];
  yield* Effect.tryPromise(() => refreshPATMetadata(page));
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("table", { name: "Tokens activos" })).toContainText("Nombre actualizado")
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByText(/¿Quieres desactivar el token/u)).toContainText(token.recipientLabel)
  );
  fixture.pats = [];
  yield* Effect.tryPromise(() => refreshPATMetadata(page));
  yield* Effect.tryPromise(() =>
    expect(page.getByText("No tienes tokens activos.", { exact: true })).toBeVisible()
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Cancelar", exact: true }).click()
  );
  yield* reviewAllTokens(page);
  expect(fixture.mutations).toEqual([]);
});
test("Accesos keeps the exact reviewed identity and cancellation after metadata changes or expiry", ({
  page,
}) => Effect.runPromise(checkRetainedReview(page)));

const checkRevocationRefusal = Effect.fn(function* (page: Page, reply: "refused" | "unavailable") {
  const fixture: ManagementFixture = { pats: [token], mutations: [], reply };
  yield* Effect.tryPromise(() => installManagement(page, fixture));
  yield* Effect.tryPromise(() => page.goto("/settings/access"));
  yield* reviewTokenForRevocation(page);
  yield* confirmRevocationTwice(page);
  if (reply === "refused") {
    yield* Effect.tryPromise(() =>
      expect(
        page.getByText(
          "No se encontró ese token. Actualiza la lista antes de revisar otra solicitud.",
          { exact: true }
        )
      ).toBeVisible()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByText("Desactivación sin confirmar", { exact: true })).toHaveCount(0)
    );
  } else {
    yield* uncertainRevocation(page);
    yield* Effect.tryPromise(() =>
      expect(
        page.getByRole("button", { name: "Desactivar todos los tokens", exact: true })
      ).toBeDisabled()
    );
  }
  expect(fixture.mutations).toEqual([`/pats/${token.shortId}`]);
});
for (const reply of ["refused", "unavailable"] as const) {
  test(`Accesos treats ${reply} revocation distinctly without automatic replay`, ({ page }) =>
    Effect.runPromise(checkRevocationRefusal(page, reply)));
}

const releaseManagementReply = (
  route: Route,
  pending: Promise<void>,
  data: unknown
): Promise<void> =>
  pending.then(() => route.fulfill({ contentType: "application/json", body: response(data) }));
const installReplacementUser = (page: Page): Promise<void> =>
  page
    .route(`${apiOrigin}/user`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: response(makeUser({ id: "24000000-0000-4000-8000-000000000242" })),
      })
    )
    .then(() => {});
const checkRetiredManagement = Effect.fn(function* (page: Page, pending: "mutation" | "refresh") {
  const fixture: ManagementFixture = { pats: [token], mutations: [], reply: "lost" };
  yield* Effect.tryPromise(() => installManagement(page, fixture));
  const release = Promise.withResolvers<void>();
  const replied = Promise.withResolvers<void>();
  let held = 0,
    holding = pending === "mutation";
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/pats**`, (route) => {
      const method = route.request().method();
      if (!holding || method !== (pending === "mutation" ? "DELETE" : "GET")) {
        return route.fallback();
      }
      held += 1;
      if (method === "DELETE") fixture.mutations.push(new URL(route.request().url()).pathname);
      return releaseManagementReply(
        route,
        release.promise,
        method === "DELETE" ? { shortId: token.shortId } : { pats: [token] }
      ).then(replied.resolve);
    })
  );
  yield* Effect.tryPromise(() => page.goto("/settings/access"));
  yield* reviewTokenForRevocation(page);
  yield* confirmRevocationTwice(page);
  if (pending === "refresh") {
    yield* uncertainRevocation(page);
    holding = true;
    yield* Effect.tryPromise(() => recoverPATMetadata(page));
  }
  yield* Effect.tryPromise(() => expect.poll(() => held).toBe(1));
  yield* Effect.tryPromise(() =>
    page.evaluate(() => window.dispatchEvent(new Event("fidy:authentication-ended")))
  );
  release.resolve();
  yield* Effect.tryPromise(() => replied.promise);
  yield* Effect.tryPromise(() =>
    expect(page.getByText(/Token desactivado|El token figura activo/u)).toHaveCount(0)
  );
  fixture.pats = [{ ...token, shortId: "other002", recipientLabel: "Agente de otra persona" }];
  holding = false;
  yield* Effect.tryPromise(() => installReplacementUser(page));
  yield* Effect.tryPromise(() => page.reload());
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("table", { name: "Tokens activos" })).toContainText(
      "Agente de otra persona"
    )
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByText(token.recipientLabel, { exact: true })).toHaveCount(0)
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByText(/Token desactivado|El token figura activo/u)).toHaveCount(0)
  );
  expect(fixture.mutations).toEqual([`/pats/${token.shortId}`]);
});
for (const pending of ["mutation", "refresh"] as const) {
  test(`Accesos fences a late ${pending} result after authentication replacement`, ({ page }) =>
    Effect.runPromise(checkRetiredManagement(page, pending)));
}

const checkOldMetadataGeneration = Effect.fn(function* (page: Page) {
  const fixture: ManagementFixture = { pats: [token], mutations: [], reply: "lost" };
  yield* Effect.tryPromise(() => installManagement(page, fixture));
  yield* Effect.tryPromise(() => page.goto("/settings/access"));
  yield* reviewTokenForRevocation(page);
  yield* confirmRevocationTwice(page);
  yield* uncertainRevocation(page);
  const oldRead = Promise.withResolvers<void>();
  const newRead = Promise.withResolvers<void>();
  let reads = 0;
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/pats`, (route) => {
      reads += 1;
      return releaseManagementReply(route, reads === 1 ? oldRead.promise : newRead.promise, {
        pats: reads === 1 ? [token] : [],
      });
    })
  );
  yield* Effect.tryPromise(() =>
    page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")))
  );
  yield* Effect.tryPromise(() => expect.poll(() => reads).toBe(1));
  yield* Effect.tryPromise(() =>
    expect(
      page.getByRole("button", { name: "Comprobar estado de tokens", exact: true })
    ).toBeEnabled()
  );
  yield* Effect.tryPromise(() => recoverPATMetadata(page));
  yield* Effect.tryPromise(() => expect.poll(() => reads).toBe(2));
  yield* Effect.tryPromise(() =>
    expect(
      page.getByRole("button", { name: "Comprobar estado de tokens", exact: true })
    ).toBeDisabled()
  );
  yield* Effect.tryPromise(() =>
    expect(
      page.getByRole("button", { name: "Comprobar estado de tokens", exact: true })
    ).toHaveText("Comprobando…")
  );
  oldRead.resolve();
  yield* uncertainRevocation(page);
  yield* Effect.tryPromise(() =>
    expect(
      page.getByRole("button", { name: "Desactivar todos los tokens", exact: true })
    ).toBeDisabled()
  );
  newRead.resolve();
  yield* Effect.tryPromise(() =>
    expect(
      page.getByText(
        "El token ya no figura activo. Esto no confirma el resultado de la desactivación anterior.",
        { exact: true }
      )
    ).toBeVisible()
  );
  expect(fixture.mutations).toEqual([`/pats/${token.shortId}`]);
});
test("Accesos rejects an older metadata generation while explicit recovery waits for its fresh read", ({
  page,
}) => Effect.runPromise(checkOldMetadataGeneration(page)));
