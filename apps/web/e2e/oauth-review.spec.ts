import type { APIRequestContext, APIResponse, BrowserContext, Page, Route } from "@playwright/test";
import { Effect, Schema } from "effect";
import type { Cause } from "effect";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";
import { playwright } from "./playwright-runtime";
import { signInFirstCardThroughCore, visiblePairingCode } from "./real-core-fixture";

const { test, expect } = playwright;
const { api, app, operator } = browserAcceptanceTopology();
const firstPoll = 5000;
const created = 201;
const found = 302;
const noContent = 204;
const ok = 200;
const invalid = 400;
const unauthorized = 401;
const forbidden = 403;
const rateLimited = 429;
const registrationAttempts = 11;
const discoveryAttempts = 61;
const oversizedBytes = 16385;
type TestFailure = Cause.UnknownError | Schema.SchemaError;
const Client = Schema.Struct({ client_id: Schema.String });
const protectedCallback = (route: Route): Promise<void> =>
  route.fulfill({
    status: ok,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
    contentType: "text/html",
    body: "<!doctype html><title>Client callback</title><p>Return to your agent</p>",
  });
const browserStorageCount = (): number => localStorage.length + sessionStorage.length;

const authorization = (request: APIRequestContext): Effect.Effect<URLSearchParams, TestFailure> =>
  Effect.gen(function* () {
    const registered = yield* Effect.tryPromise(() =>
      request.post(`${api}/oauth/register`, {
        data: {
          client_name: "<img src=x onerror=alert(1)>",
          redirect_uris: ["http://127.0.0.1/callback"],
          grant_types: ["authorization_code", "refresh_token"],
        },
      })
    );
    expect(registered.status()).toBe(created);
    const client = yield* Schema.decodeUnknownEffect(Client)(
      yield* Effect.tryPromise(() => registered.json())
    );
    return new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "http://127.0.0.1:3456/callback",
      resource: "https://api.fidyapp.com/mcp",
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    });
  });
const beginReview = (
  request: APIRequestContext,
  query: URLSearchParams
): Effect.Effect<string, TestFailure> =>
  Effect.gen(function* () {
    const started = yield* Effect.tryPromise(() =>
      request.get(`${api}/oauth/authorize?${query}`, { maxRedirects: 0 })
    );
    expect(started.status()).toBe(found);
    return new URL(started.headers().location ?? "").pathname;
  });
const loginFromReview = (
  page: Page,
  request: APIRequestContext,
  path: string
): Effect.Effect<void, TestFailure> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => page.clock.install());
    yield* Effect.tryPromise(() => page.goto(path));
    yield* Effect.tryPromise(() =>
      page.getByRole("link", { name: "Iniciar sesión", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Iniciar sesión en el navegador" }).click()
    );
    const code = yield* Effect.tryPromise(() => visiblePairingCode(page));
    const approval = yield* Effect.tryPromise(() =>
      request.post(`${operator}/approve?code=${code}&firstCard=false`)
    );
    expect(approval.status()).toBe(noContent);
    const redemption = page.waitForResponse("**/web/pairings/redeem");
    yield* Effect.tryPromise(() => page.clock.fastForward(firstPoll));
    expect((yield* Effect.tryPromise(() => redemption)).status()).toBe(ok);
    yield* Effect.tryPromise(() => expect(page).toHaveURL(`${app}${path}`));
  });
const assertReview = (page: Page): Effect.Effect<void, TestFailure> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("heading", { name: "Conectar con Fidy" })).toBeVisible()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByText("<img src=x onerror=alert(1)>")).toBeVisible()
    );
    yield* Effect.tryPromise(() => expect(page.locator("img")).toHaveCount(0));
    yield* Effect.tryPromise(() => expect(page.getByRole("checkbox")).toHaveCount(1));
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "90 días" })).toHaveAttribute("aria-pressed", "true")
    );
    yield* Effect.tryPromise(() => page.getByRole("checkbox").uncheck());
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("alert")).toHaveText("Selecciona al menos un permiso.")
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Conectar", exact: true })).toBeDisabled()
    );
  });

test("built browser returns from established sign-in to a text-only request review and cancels without authority", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const path = yield* beginReview(request, yield* authorization(request));
      yield* loginFromReview(page, request, path);
      yield* assertReview(page);
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Cancelar" }).click());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("status")).toHaveText(
          "Solicitud cancelada. No se autorizó ningún acceso."
        )
      );
      expect(yield* Effect.tryPromise(() => page.evaluate(browserStorageCount))).toBe(0);
      expect(page.url()).not.toContain("code=");
    })
  ));

test("built browser approves an exact connection and exchanges its callback code without Fidy bearer storage", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const query = yield* authorization(request);
      query.set("state", "browser-callback-state");
      const path = yield* beginReview(request, query);
      yield* loginFromReview(page, request, path);
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Conectar", exact: true })).toBeEnabled()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "7 días", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.route("http://127.0.0.1:3456/callback?*", protectedCallback)
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Conectar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page).toHaveURL(/http:\/\/127\.0\.0\.1:3456\/callback\?/)
      );
      const callback = new URL(page.url());
      expect(callback.searchParams.get("state")).toBe("browser-callback-state");
      expect(callback.searchParams.get("iss")).toBe("https://api.fidyapp.com");
      expect(
        callback.searchParams.has("access_token") || callback.searchParams.has("refresh_token")
      ).toBe(false);
      const form = {
        grant_type: "authorization_code",
        code: callback.searchParams.get("code") ?? "",
        client_id: query.get("client_id") ?? "",
        redirect_uri: query.get("redirect_uri") ?? "",
        resource: query.get("resource") ?? "",
        code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      };
      const exchanged = yield* Effect.tryPromise(() =>
        request.post(`${api}/oauth/token`, { form })
      );
      expect(exchanged.status()).toBe(ok);
      const token = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String })
      )(yield* Effect.tryPromise(() => exchanged.json()));
      expect(
        (yield* Effect.tryPromise(() => request.post(`${api}/oauth/token`, { form }))).status()
      ).toBe(invalid);
      yield* inspectAndRevoke({ page, request, query, token });
    })
  ));

const callCategories = (request: APIRequestContext, bearer: string): Promise<APIResponse> =>
  request.post(`${api}/mcp`, {
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "categories.listCategories",
    },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "categories.listCategories",
        arguments: {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    },
  });
const inspectAndRevoke = (
  input: Readonly<{
    page: Page;
    request: APIRequestContext;
    query: URLSearchParams;
    token: Readonly<{ access_token: string; refresh_token: string }>;
  }>
): Effect.Effect<void, TestFailure> =>
  Effect.gen(function* () {
    const { page, request, query, token } = input;
    const connectionId = yield* inspectManagementPage({ page, request, token });
    const second = yield* reconnectFromBrowser({ page, request, query });
    yield* Effect.tryPromise(() => page.goto("/settings/agents"));
    yield* Effect.tryPromise(() =>
      expect(page.getByText("<img src=x onerror=alert(1)>")).toHaveCount(2)
    );
    yield* refuseOtherBrowser({ page, request, connectionId });
    const csrf = yield* Effect.tryPromise(() =>
      page.context().request.post(`${api}/web/oauth/revoke-all`, {
        headers: { origin: "https://evil.example" },
        data: {},
      })
    );
    expect(csrf.status()).toBe(forbidden);
    expect(
      (yield* Effect.tryPromise(() => callCategories(request, token.access_token))).status()
    ).toBe(ok);
    yield* Effect.tryPromise(() =>
      page
        .getByText(`Conexión: ${connectionId}`, { exact: true })
        .locator("..")
        .getByRole("button", { name: "Revocar este agente" })
        .click()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("status")).toHaveText(
        "Acceso revocado. Las acciones ya realizadas se conservan."
      )
    );
    yield* Effect.tryPromise(() => expect(page.getByText("Estado: Revocado")).toBeVisible());
    expect(
      (yield* Effect.tryPromise(() => callCategories(request, token.access_token))).status()
    ).toBe(unauthorized);
    const form = {
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
      client_id: query.get("client_id") ?? "",
      resource: "https://api.fidyapp.com/mcp",
    };
    expect(
      (yield* Effect.tryPromise(() => request.post(`${api}/oauth/token`, { form }))).status()
    ).toBe(invalid);
    expect(
      (yield* Effect.tryPromise(() => callCategories(request, second.access_token))).status()
    ).toBe(ok);
    yield* revokeAllWithRacingRefresh({ page, request, second, form });
    expect(yield* Effect.tryPromise(() => page.evaluate(browserStorageCount))).toBe(0);
    const text = yield* Effect.tryPromise(() => page.locator("body").innerText());
    expect(text.includes(token.access_token) || text.includes(token.refresh_token)).toBe(false);
  });
const inspectManagementPage = (
  input: Readonly<{
    page: Page;
    request: APIRequestContext;
    token: Readonly<{ access_token: string }>;
  }>
): Effect.Effect<string, TestFailure> =>
  Effect.gen(function* () {
    const { page, request, token } = input;
    expect(
      (yield* Effect.tryPromise(() => callCategories(request, token.access_token))).status()
    ).toBe(ok);
    yield* Effect.tryPromise(() => page.goto("/settings/agents"));
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("heading", { name: "Agentes conectados", exact: true })).toBeVisible()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByText("<img src=x onerror=alert(1)>")).toBeVisible()
    );
    yield* Effect.tryPromise(() => expect(page.locator("img")).toHaveCount(0));
    yield* Effect.tryPromise(() =>
      expect(page.getByText("categories.listCategories", { exact: true })).toBeVisible()
    );
    const listed = yield* Effect.tryPromise(() =>
      page.context().request.get(`${api}/web/oauth/connections`, { headers: { origin: app } })
    );
    const metadata = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ connections: Schema.Array(Schema.Struct({ connectionId: Schema.String })) })
    )(yield* Effect.tryPromise(() => listed.json()));
    return metadata.connections[0]?.connectionId ?? "";
  });
const revokeAllWithRacingRefresh = (
  input: Readonly<{
    page: Page;
    request: APIRequestContext;
    second: Readonly<{ access_token: string; refresh_token: string }>;
    form: Readonly<Record<string, string>>;
  }>
): Effect.Effect<void, TestFailure> =>
  Effect.gen(function* () {
    const { page, request, second, form } = input;
    const pendingRefresh = request.post(`${api}/oauth/token`, {
      form: { ...form, refresh_token: second.refresh_token },
    });
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Revocar todos los agentes conectados" }).click()
    );
    const raced = yield* Effect.tryPromise(() => pendingRefresh);
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("status")).toHaveText(
        "Acceso revocado. Las acciones ya realizadas se conservan."
      )
    );
    yield* Effect.tryPromise(() => expect(page.getByText("Estado: Revocado")).toHaveCount(2));
    expect(
      (yield* Effect.tryPromise(() => callCategories(request, second.access_token))).status()
    ).toBe(unauthorized);
    yield* assertRefreshWinnerRevoked({ request, response: raced });
  });
const assertRefreshWinnerRevoked = (
  input: Readonly<{ request: APIRequestContext; response: APIResponse }>
): Effect.Effect<void, TestFailure> =>
  Effect.gen(function* () {
    expect([ok, invalid]).toContain(input.response.status());
    if (input.response.status() !== ok) return;
    const winner = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ access_token: Schema.String })
    )(yield* Effect.tryPromise(() => input.response.json()));
    expect(
      (yield* Effect.tryPromise(() => callCategories(input.request, winner.access_token))).status()
    ).toBe(unauthorized);
  });
const reconnectFromBrowser = (
  input: Readonly<{ page: Page; request: APIRequestContext; query: URLSearchParams }>
): Effect.Effect<Readonly<{ access_token: string; refresh_token: string }>, TestFailure> =>
  Effect.gen(function* () {
    const path = yield* beginReview(input.request, input.query);
    yield* Effect.tryPromise(() => input.page.goto(path));
    yield* Effect.tryPromise(() =>
      input.page.getByRole("button", { name: "Conectar", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(input.page).toHaveURL(/http:\/\/127\.0\.0\.1:3456\/callback\?/)
    );
    const code = new URL(input.page.url()).searchParams.get("code") ?? "";
    const exchanged = yield* Effect.tryPromise(() =>
      input.request.post(`${api}/oauth/token`, {
        form: {
          grant_type: "authorization_code",
          code,
          client_id: input.query.get("client_id") ?? "",
          redirect_uri: input.query.get("redirect_uri") ?? "",
          resource: "https://api.fidyapp.com/mcp",
          code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        },
      })
    );
    expect(exchanged.status()).toBe(ok);
    return yield* Schema.decodeUnknownEffect(
      Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String })
    )(yield* Effect.tryPromise(() => exchanged.json()));
  });
const refuseOtherBrowser = (
  input: Readonly<{ page: Page; request: APIRequestContext; connectionId: string }>
): Effect.Effect<void, TestFailure> =>
  Effect.gen(function* () {
    const browser = yield* Effect.try(() => {
      const value = input.page.context().browser();
      if (value === null) throw new Error("Browser fixture unavailable");
      return value;
    });
    const other = yield* Effect.tryPromise(() =>
      browser.newContext({ baseURL: app, ignoreHTTPSErrors: true })
    );
    yield* Effect.acquireUseRelease(
      Effect.succeed(other),
      (context) => refuseOtherIdentity({ ...input, context }),
      (context) => Effect.tryPromise(() => context.close()).pipe(Effect.ignore)
    );
  });
const refuseOtherIdentity = (
  input: Readonly<{ context: BrowserContext; request: APIRequestContext; connectionId: string }>
): Effect.Effect<void, TestFailure> =>
  Effect.gen(function* () {
    const page = yield* Effect.tryPromise(() => input.context.newPage());
    yield* Effect.tryPromise(() => signInFirstCardThroughCore({ page, request: input.request }));
    yield* Effect.tryPromise(() => page.goto("/settings/agents"));
    yield* Effect.tryPromise(() =>
      expect(page.getByText("No hay conexiones en esta página.")).toBeVisible()
    );
    const refused = yield* Effect.tryPromise(() =>
      input.context.request.post(`${api}/web/oauth/revoke`, {
        headers: { origin: app },
        data: { connectionId: input.connectionId },
      })
    );
    expect(refused.status()).toBe(invalid);
    expect(yield* Effect.tryPromise(() => refused.text())).not.toContain(input.connectionId);
  });
const assertFloodBounds = ({
  page,
  request,
}: Readonly<{ page: Page; request: APIRequestContext }>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const statuses: Array<number> = [];
      for (let index = 0; index < registrationAttempts; index++) {
        const result = yield* Effect.tryPromise(() =>
          request.post(`${api}/oauth/register`, {
            data: { client_name: "Agente", redirect_uris: ["https://example.com/cb"] },
          })
        );
        statuses.push(result.status());
        if (result.status() === rateLimited) {
          expect(yield* Effect.tryPromise(() => result.json())).toEqual({ error: "slow_down" });
        }
      }
      expect(statuses).toContain(rateLimited);
      const discoveryStatuses: Array<number> = [];
      for (let index = 0; index < discoveryAttempts; index++) {
        const result = yield* Effect.tryPromise(() =>
          request.get(`${api}/.well-known/oauth-authorization-server`)
        );
        discoveryStatuses.push(result.status());
        if (result.status() === rateLimited) {
          expect(yield* Effect.tryPromise(() => result.json())).toEqual({ error: "slow_down" });
        }
      }
      expect(discoveryStatuses).toContain(rateLimited);
      yield* Effect.tryPromise(() => page.goto("/oauth/review/not-a-reference"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toHaveText("La solicitud no es válida.")
      );
    })
  );

const rejectSessionAndCsrf = (
  request: APIRequestContext,
  path: string
): Effect.Effect<void, TestFailure> =>
  Effect.gen(function* () {
    const requestId = path.split("/").at(-1) ?? "";
    expect(
      (yield* Effect.tryPromise(() =>
        request.get(`${api}/web/oauth/review?requestId=${requestId}`, {
          headers: { origin: app, cookie: "__Host-fidy_session=forged" },
        })
      )).status()
    ).toBe(unauthorized);
    expect(
      (yield* Effect.tryPromise(() =>
        request.post(`${api}/web/oauth/cancel`, {
          headers: { origin: "https://evil.example" },
          data: { requestId },
        })
      )).status()
    ).toBe(forbidden);
  });
test("built browser and real ingress refuse forged sessions, callback substitution, oversized claims and metadata-network destinations", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const query = yield* authorization(request);
      query.set("redirect_uri", "http://127.0.0.1:3456/other");
      expect(
        (yield* Effect.tryPromise(() =>
          request.get(`${api}/oauth/authorize?${query}`, { maxRedirects: 0 })
        )).status()
      ).toBe(invalid);
      query.set("redirect_uri", "http://127.0.0.1:3456/callback");
      query.set("resource", "https://evil.example/mcp");
      expect(
        (yield* Effect.tryPromise(() =>
          request.get(`${api}/oauth/authorize?${query}`, { maxRedirects: 0 })
        )).status()
      ).toBe(invalid);
      query.set("resource", "https://api.fidyapp.com/mcp");
      yield* rejectSessionAndCsrf(request, yield* beginReview(request, query));
      expect(
        (yield* Effect.tryPromise(() =>
          request.post(`${api}/oauth/register`, {
            data: {
              client_name: "x".repeat(oversizedBytes),
              redirect_uris: ["https://example.com/cb"],
            },
          })
        )).status()
      ).toBe(invalid);
      expect(
        (yield* Effect.tryPromise(() =>
          request.post(`${api}/oauth/register`, {
            data: { client_name: "Agente", redirect_uris: ["http://localhost/callback"] },
          })
        )).status()
      ).toBe(invalid);
      query.set("client_id", "https://evil.example/redirect-to-169.254.169.254");
      expect(
        (yield* Effect.tryPromise(() =>
          request.get(`${api}/oauth/authorize?${query}`, { maxRedirects: 0 })
        )).status()
      ).toBe(invalid);
      yield* Effect.tryPromise(() => page.goto("/oauth/review/not-a-reference"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toHaveText("La solicitud no es válida.")
      );
      expect((yield* Effect.tryPromise(() => request.post(`${api}/oauth/token`))).status()).toBe(
        invalid
      );
    })
  ));

const unavailableManagement = (route: Route): Promise<void> =>
  route.fulfill({
    status: 503,
    contentType: "application/json",
    body: '{"error":"temporarily_unavailable"}',
  });
const malformedManagement = (route: Route): Promise<void> =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: '{"connections":[],"nextCursor":"malformed"}',
  });
test("built agent settings report unavailable or malformed state without a false empty list or successful revocation", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const path = yield* beginReview(request, yield* authorization(request));
      yield* loginFromReview(page, request, path);
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Cancelar" }).click());
      yield* Effect.tryPromise(() => page.route("**/web/oauth/connections", unavailableManagement));
      yield* Effect.tryPromise(() => page.goto("/settings/agents"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toContainText("No pudimos consultar los agentes")
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("No hay conexiones en esta página.")).toHaveCount(0)
      );
      yield* Effect.tryPromise(() => page.unroute("**/web/oauth/connections"));
      yield* Effect.tryPromise(() => page.route("**/web/oauth/connections", malformedManagement));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Actualizar lista" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toContainText("No pudimos consultar los agentes")
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("No hay conexiones en esta página.")).toHaveCount(0)
      );
      yield* Effect.tryPromise(() => page.unroute("**/web/oauth/connections"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Actualizar lista" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("button", { name: "Revocar todos los agentes conectados" })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.route("**/web/oauth/revoke-all", unavailableManagement));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Revocar todos los agentes conectados" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toContainText("No pudimos confirmar la revocación")
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByText("Acceso revocado. Las acciones ya realizadas se conservan.")
        ).toHaveCount(0)
      );
    })
  ));

test(
  "real built-browser ingress bounds registration and discovery floods with metadata-safe refusals",
  assertFloodBounds
);
