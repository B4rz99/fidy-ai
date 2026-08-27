import {
  ClaimedPATPairing,
  DashboardDocument,
  DashboardEdit,
  EmailVerificationCode,
  StartedBrowserLoginPairing,
  StartedPATPairing,
} from "@fidy/server/client";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page, Response } from "@playwright/test";
import { Option, Redacted, Schema, Struct } from "effect";

const apiOrigin = "https://127.0.0.1:4174";
const controlOrigin = "https://127.0.0.1:4175";
const acceptanceEmail = "browser-pairing-acceptance@fidyapp.com";
const opaqueProofEncodedLength = 43;
const millisecondsPerSecond = 1_000;
const successStatus = 200;
const createdStatus = 201;
const pendingStatus = 202;
const noContentStatus = 204;
const invalidStatus = 400;
const unauthorizedStatus = 401;
const forbiddenStatus = 403;
const notFoundStatus = 404;
const anonymousSourceHeaders = { "x-forwarded-for": "198.51.100.249" };
const dragAttempts = 3;
const dragCoordinateDivisor = 2;
const dragMovementSteps = 20;
const dragResponseTimeoutMilliseconds = 3_000;
const invalidPairingBody = {
  error: {
    code: "pairing_invalid",
    message: "Esta vinculación ya no es válida. Inicia de nuevo.",
  },
};
const subscriptionOffersBody = {
  data: [
    {
      id: "22700000-0000-4000-8000-000000000001",
      money: { amount: "9900", currency: "COP" },
      billingPeriod: "weekly",
      serviceMarket: "CO",
      taxTreatment: "not-taxable",
      renewalTerms: {
        automaticRenewal: true,
        renewalReminder: "none",
        cancellation: "future-renewals-only",
        paidAccessEnds: "paid-period-end",
      },
      paymentMethods: ["card", "nequi", "daviplata"],
    },
    {
      id: "22700000-0000-4000-8000-000000000002",
      money: { amount: "28900", currency: "COP" },
      billingPeriod: "monthly",
      serviceMarket: "CO",
      taxTreatment: "not-taxable",
      renewalTerms: {
        automaticRenewal: true,
        renewalReminder: "none",
        cancellation: "future-renewals-only",
        paidAccessEnds: "paid-period-end",
      },
      paymentMethods: ["card", "nequi", "daviplata"],
    },
    {
      id: "22700000-0000-4000-8000-000000000003",
      money: { amount: "289900", currency: "COP" },
      billingPeriod: "yearly",
      serviceMarket: "CO",
      taxTreatment: "not-taxable",
      renewalTerms: {
        automaticRenewal: true,
        renewalReminder: "none",
        cancellation: "future-renewals-only",
        paidAccessEnds: "paid-period-end",
      },
      paymentMethods: ["card", "nequi", "daviplata"],
    },
  ],
  next: [],
};

const PairingStartBody = StartedBrowserLoginPairing.mapFields(Struct.pick(["privateVerifier"]));
const OpenApi = Schema.Struct({ openapi: Schema.String });
const DashboardDocumentResponse = Schema.Struct({ data: DashboardDocument });

const DeliveredEmailCode = Schema.Struct({ combinedCode: EmailVerificationCode });
const IdentityObservation = Schema.Struct({
  userCount: Schema.Int,
  verifiedEmailCount: Schema.Int,
  verifiedEmailAddress: Schema.NullOr(Schema.String),
  verifiedEmailRevision: Schema.NullOr(Schema.String),
  whatsAppIdentityCount: Schema.Int,
  transactionCount: Schema.Int,
  userRecordSha256: Schema.String,
  verifiedEmailRecordSha256: Schema.String,
  whatsAppIdentityRecordsSha256: Schema.String,
  transactionRecordsSha256: Schema.String,
});
const SessionObservation = Schema.Struct({
  sessionCount: Schema.Int,
  revoked: Schema.Boolean,
});

const browserStorageValues = (): string =>
  [localStorage, sessionStorage]
    .flatMap((storage) =>
      Array.from({ length: storage.length }, (_, index) => {
        const key = storage.key(index);
        return key === null ? "" : (storage.getItem(key) ?? "");
      })
    )
    .join("\n");

type IdentityObservation = typeof IdentityObservation.Type;
type SessionObservation = typeof SessionObservation.Type;

const resetAcceptanceState = async (request: APIRequestContext): Promise<void> => {
  const response = await request.post(`${controlOrigin}/reset`);
  expect(response.status(), await response.text()).toBe(noContentStatus);
};

const revokeAcceptanceConsent = async (request: APIRequestContext): Promise<void> => {
  expect((await request.post(`${controlOrigin}/revoke-consent`)).status()).toBe(noContentStatus);
};

const tryDashboardDrag = async (page: Page, attemptsRemaining: number): Promise<Response> => {
  if (attemptsRemaining === 0) throw new Error("Dashboard drag did not produce an edit");
  const source = page
    .getByRole("list", { name: "Widgets disponibles para arrastrar" })
    .getByRole("button", { name: "Arrastrar Transacciones recientes" });
  const target = page.getByRole("region", { name: "Colocar arriba de Gastos por categoría" });
  await expect(source).toBeEnabled();
  await source.hover();
  const sourceBox = await source.boundingBox();
  if (sourceBox === null) throw new Error("Expected visible drag source geometry");
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width, sourceBox.y + sourceBox.height);
  await target.scrollIntoViewIfNeeded();
  const targetBox = await target.boundingBox();
  if (targetBox === null) throw new Error("Expected visible drop target geometry");
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url() === `${apiOrigin}/dashboard/edits` && candidate.request().method() === "POST",
    { timeout: dragResponseTimeoutMilliseconds }
  );
  await page.mouse.move(
    targetBox.x + targetBox.width / dragCoordinateDivisor,
    targetBox.y + targetBox.height / dragCoordinateDivisor,
    { steps: dragMovementSteps }
  );
  await page.mouse.up();
  const outcome = await response.then(Option.some, () => Option.none<Response>());
  return Option.isSome(outcome) ? outcome.value : tryDashboardDrag(page, attemptsRemaining - 1);
};

const dragRecentTransactionsToDashboardStart = (page: Page): Promise<Response> =>
  tryDashboardDrag(page, dragAttempts);

const moveBudgetWithKeyboard = async (page: Page): Promise<Response> => {
  const source = page
    .getByRole("region", { name: "Diseño responsivo del tablero" })
    .getByRole("button", { name: "Arrastrar Presupuesto de restaurantes", exact: true });
  await source.focus();
  await source.press("Enter");
  await expect(source).toHaveAttribute("aria-pressed", "true");
  await source.press("ArrowRight");
  await source.press("ArrowRight");
  await source.press("ArrowRight");
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url() === `${apiOrigin}/dashboard/edits` && candidate.request().method() === "POST"
  );
  await source.press("Enter");
  return response;
};

const approvePairing = async (request: APIRequestContext, publicCode: string): Promise<void> => {
  const response = await request.post(`${controlOrigin}/approve-pairing`, {
    data: { publicCode },
  });
  expect(response.status()).toBe(noContentStatus);
};

const completePairing = async (page: Page, request: APIRequestContext): Promise<void> => {
  await page.goto("/auth/pair");
  const startResponse = page.waitForResponse(
    (response) =>
      response.url() === `${apiOrigin}/web/pairings` && response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Iniciar sesión en el navegador" }).click();
  const startedResponse = await startResponse;
  expect(startedResponse.status()).toBe(successStatus);
  const started = Schema.decodeUnknownSync(PairingStartBody)(await startedResponse.json());
  const privateVerifier = Redacted.value(started.privateVerifier);
  expect(privateVerifier).toHaveLength(opaqueProofEncodedLength);
  await expect(page.locator("body")).not.toContainText(privateVerifier);
  const retainedBrowserValues = await page.evaluate(browserStorageValues);
  expect([retainedBrowserValues, await page.content(), page.url()].join("\n")).not.toContain(
    privateVerifier
  );
  const codeNode = page.locator('[aria-label^="Código de vinculación "]');
  await expect(codeNode).toBeVisible();
  const publicCode = Option.getOrThrow(Option.fromNullishOr(await codeNode.textContent())).trim();
  expect(publicCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u);
  const currentUserResponse = page.waitForResponse(
    (response) =>
      response.url() === `${apiOrigin}/user` &&
      response.request().method() === "GET" &&
      response.status() === successStatus
  );
  await approvePairing(request, publicCode);
  await expect(page).toHaveURL(/\/app\/transactions$/u, { timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "Transacciones" })).toBeVisible();
  await expect(page.getByText("America/Bogota", { exact: true })).toBeVisible();
  const userResponse = await currentUserResponse;
  expect(userResponse.status()).toBe(successStatus);
  expect(userResponse.headers()["access-control-allow-origin"]).toBe("https://127.0.0.1:4173");
  expect(userResponse.headers()["access-control-allow-credentials"]).toBe("true");
  expect(userResponse.headers()["access-control-allow-origin"]).not.toBe("*");
};

const issueDashboardPAT = async (page: Page): Promise<string> => {
  await page.goto("/settings/pats");
  await page.getByLabel("Nombre").fill("Paridad del tablero");
  await page.getByRole("checkbox", { name: /Lectura/iu }).click();
  await page.getByRole("checkbox", { name: /Tablero/iu }).click();
  await page.getByRole("button", { name: "Revisar token" }).click();
  const issueResponse = page.waitForResponse(
    (response) => response.url() === `${apiOrigin}/pats` && response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Confirmar y crear token" }).click();
  const body = Schema.decodeUnknownSync(
    Schema.Struct({ data: Schema.Struct({ bearer: Schema.String }) })
  )(await (await issueResponse).json());
  return body.data.bearer;
};

const SeededTransaction = Schema.Struct({ categoryLabel: Schema.String });

const completePairingByEmail = async (page: Page, request: APIRequestContext): Promise<void> => {
  await page.goto("/auth/pair");
  await page.getByRole("button", { name: "Iniciar sesión en el navegador" }).click();
  await page.getByLabel("O accede con tu correo verificado").fill(acceptanceEmail);
  const startResponse = page.waitForResponse(
    (response) => response.url() === `${apiOrigin}/web/email/authentication/start`
  );
  await page.getByRole("button", { name: "Enviar código por correo" }).click();
  expect((await startResponse).status()).toBe(pendingStatus);
  await expect(page.getByLabel("Código recibido por correo")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Solicitar otro código al mismo correo" })
  ).toBeVisible();

  const delivery = await request.post(`${controlOrigin}/process-email-delivery`);
  expect(delivery.status()).toBe(successStatus);
  const { combinedCode } = Schema.decodeUnknownSync(DeliveredEmailCode)(await delivery.json());
  const completionResponse = page.waitForResponse(
    (response) => response.url() === `${apiOrigin}/web/email/authentication/complete`
  );
  await page.getByLabel("Código recibido por correo").fill(combinedCode);
  await page.getByRole("button", { name: "Aprobar este navegador" }).click();
  const completed = await completionResponse;
  expect(completed.status()).toBe(successStatus);
  expect(completed.headers()["set-cookie"]).toBeUndefined();
  await expect(page).toHaveURL(/\/app\/transactions$/u, { timeout: 15_000 });
};

const seedCurrentMonthTransaction = async (
  request: APIRequestContext
): Promise<typeof SeededTransaction.Type> => {
  const response = await request.post(`${controlOrigin}/seed-current-month-transaction`);
  expect(response.status()).toBe(createdStatus);
  return Schema.decodeUnknownSync(SeededTransaction)(await response.json());
};

const observeIdentity = async (request: APIRequestContext): Promise<IdentityObservation> => {
  const response = await request.get(`${controlOrigin}/identity-observation`);
  expect(response.status()).toBe(successStatus);
  return Schema.decodeUnknownSync(IdentityObservation)(await response.json());
};

const observeSession = async (request: APIRequestContext): Promise<SessionObservation> => {
  const response = await request.get(`${controlOrigin}/session-observation`);
  expect(response.status()).toBe(successStatus);
  return Schema.decodeUnknownSync(SessionObservation)(await response.json());
};

const revokeVisiblePAT = async (
  page: Page,
  request: APIRequestContext,
  bearer: string
): Promise<void> => {
  await expect(page.getByText("Automatización casa", { exact: true }).last()).toBeVisible();
  const shortId = Option.getOrThrow(Option.fromNullishOr(bearer.split("_")[1]));
  await expect(page.getByText(shortId, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Desactivar", exact: true }).click();
  await expect(page.getByText(/dejará de funcionar de inmediato/iu)).toBeVisible();
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url() === `${apiOrigin}/pats/${shortId}` &&
      candidate.request().method() === "DELETE"
  );
  await page.getByRole("button", { name: "Sí, desactivar" }).click();
  expect((await response).status()).toBe(successStatus);
  await expect(page.getByText(/dejó de funcionar de inmediato/iu)).toBeVisible();
  const revokedBearer = await request.get(`${apiOrigin}/categories`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  expect(revokedBearer.status()).toBe(unauthorizedStatus);
};

const revokeRetainedSession = async (page: Page): Promise<void> => {
  const logoutResponse = page.waitForResponse(
    (response) =>
      response.url() === `${apiOrigin}/web/session/logout` && response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Cerrar sesión" }).click();
  expect((await logoutResponse).status()).toBe(noContentStatus);
};

const assertReplayRefused = async (
  request: APIRequestContext,
  redemptionPayload: unknown
): Promise<void> => {
  const replay = await request.post(`${apiOrigin}/web/pairings/redeem`, {
    data: redemptionPayload,
  });
  expect(replay.status()).toBe(invalidStatus);
  expect(await replay.json()).toEqual(invalidPairingBody);
  expect(await observeSession(request)).toEqual({ sessionCount: 1, revoked: false });
};

const assertUnknownWrongVerifierRefused = async (request: APIRequestContext): Promise<void> => {
  const response = await request.post(`${apiOrigin}/web/pairings/redeem`, {
    data: {
      pairingId: "24000000-0000-4000-8000-000000000241",
      privateVerifier: "w".repeat(opaqueProofEncodedLength),
    },
  });
  expect(response.status()).toBe(invalidStatus);
  expect(await response.json()).toEqual(invalidPairingBody);
};

test("proves independent production-like web and API route ownership", async ({ request }) => {
  const shellPaths = ["/", "/auth/pair", "/upgrade", "/app/transactions", "/settings/pats"];
  const shellResponses = await Promise.all(shellPaths.map((path) => request.get(path)));
  for (const response of shellResponses) {
    expect(response.status()).toBe(successStatus);
    expect(response.headers()["cache-control"]).toBe("no-cache");
    expect(response.headers()["content-security-policy"]).toContain(
      "connect-src https://127.0.0.1:4174"
    );
    expect(response.headers()["cross-origin-opener-policy"]).toBe("same-origin");
    expect(response.headers()["cross-origin-resource-policy"]).toBe("same-origin");
    expect(response.headers()["permissions-policy"]).toContain("camera=()");
    expect(response.headers()["referrer-policy"]).toBe("no-referrer");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    expect(response.headers()["x-frame-options"]).toBe("DENY");
  }

  const shell = await (await request.get("/")).text();
  const assetPath = Option.getOrThrow(
    Option.fromNullishOr(shell.match(/src="(\/assets\/[^"?]+\.js)"/u)?.[1])
  );
  expect(assetPath).toMatch(/^\/assets\/.+-[A-Za-z0-9_-]{8,}\.js$/u);
  const asset = await request.get(assetPath);
  expect(asset.status()).toBe(successStatus);
  expect(asset.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect((await request.get(`${assetPath}.map`)).status()).toBe(notFoundStatus);

  expect((await request.get(`${apiOrigin}/`)).status()).toBe(notFoundStatus);
  expect((await request.get(`${apiOrigin}/auth/pair`)).status()).toBe(notFoundStatus);
  const health = await request.get(`${apiOrigin}/health`);
  expect(health.status()).toBe(successStatus);
  expect(await health.json()).toMatchObject({ status: "ok" });
  const openApi = await request.get(`${apiOrigin}/openapi.json`);
  expect(openApi.status()).toBe(successStatus);
  expect(Schema.decodeUnknownSync(OpenApi)(await openApi.json()).openapi).toMatch(/^3\./u);
  const docs = await request.get(`${apiOrigin}/docs`);
  expect(docs.status()).toBe(successStatus);
  expect(docs.headers()["content-type"]).toContain("text/html");
  expect((await request.get(`${apiOrigin}/user`)).status()).toBe(unauthorizedStatus);
  const invalidRedemption = await request.post(`${apiOrigin}/web/pairings/redeem`, {
    data: {
      pairingId: "24000000-0000-4000-8000-000000000243",
      privateVerifier: "x".repeat(opaqueProofEncodedLength),
    },
  });
  expect(invalidRedemption.status()).toBe(invalidStatus);
  expect(invalidRedemption.headers()["cache-control"]).toBe("no-store");
  expect(await invalidRedemption.json()).toEqual(invalidPairingBody);
});

test("shows real PostgreSQL pairing expiry without creating a WebSession", async ({
  page,
  request,
}) => {
  await resetAcceptanceState(request);
  await page.clock.install();
  await page.goto("/auth/pair");
  await page.getByRole("button", { name: "Iniciar sesión en el navegador" }).click();
  await expect(page.locator('[aria-label^="Código de vinculación "]')).toBeVisible();

  await page.clock.fastForward("10:01");

  await expect(page.getByText(invalidPairingBody.error.message, { exact: true })).toBeVisible();
  expect(await observeSession(request)).toEqual({ sessionCount: 0, revoked: false });
});

test("reviews in the fresh browser and delivers a paired PAT only to the initiating client", async ({
  page,
  request,
}) => {
  await resetAcceptanceState(request);
  await completePairing(page, request);
  const start = await request.post(`${apiOrigin}/pat-pairings`, {
    headers: anonymousSourceHeaders,
    data: { recipientLabel: "Cliente CLI", scopes: ["read", "dashboard"] },
  });
  expect(start.status()).toBe(successStatus);
  expect(start.headers()["cache-control"]).toContain("no-store");
  const started = Schema.decodeUnknownSync(StartedPATPairing)(await start.json());
  const privateDeviceCode = Redacted.value(started.privateDeviceCode);

  await page.goto("/settings/pats");
  await page.getByLabel("Código").fill(started.publicCode);
  await page.getByRole("button", { name: "Continuar" }).click();
  const reviewDetails = page.getByText("Permisos solicitados", { exact: true }).locator("..");
  await expect(reviewDetails.getByText("Cliente CLI", { exact: true })).toBeVisible();
  await expect(reviewDetails.getByText("Lectura", { exact: true })).toBeVisible();
  await expect(reviewDetails.getByText("Tablero", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Autorizar acceso" }).click();
  await expect(page.getByText("Acceso autorizado", { exact: true })).toBeVisible();

  await page.waitForTimeout(started.pollingIntervalSeconds * millisecondsPerSecond);
  const claim = await request.post(`${apiOrigin}/pat-pairings/claim`, {
    headers: anonymousSourceHeaders,
    data: { pairingId: started.pairingId, privateDeviceCode },
  });
  expect(claim.status()).toBe(successStatus);
  expect(claim.headers()["cache-control"]).toContain("no-store");
  const issued = Schema.decodeUnknownSync(ClaimedPATPairing)(await claim.json());
  const browserEvidence = [
    await page.content(),
    page.url(),
    await page.evaluate(browserStorageValues),
  ];
  expect(browserEvidence.join("\n")).not.toContain(privateDeviceCode);
  expect(browserEvidence.join("\n")).not.toContain(issued.bearer);

  const replay = await request.post(`${apiOrigin}/pat-pairings/claim`, {
    headers: anonymousSourceHeaders,
    data: { pairingId: started.pairingId, privateDeviceCode },
  });
  expect(replay.status()).toBe(invalidStatus);
});

test("creates, copies, and clears a manual PAT from a freshly paired browser", async ({
  context,
  page,
  request,
}) => {
  await resetAcceptanceState(request);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "https://127.0.0.1:4173",
  });
  await completePairing(page, request);

  await page.getByRole("link", { name: "Tokens" }).click();
  await expect(page).toHaveURL(/\/settings\/pats$/u);
  await page.getByLabel("Nombre").fill("  Automatización casa  ");
  await page.getByRole("checkbox", { name: /Lectura/iu }).click();
  await page.getByRole("checkbox", { name: /Tablero/iu }).click();
  await page.getByRole("button", { name: "Revisar token" }).click();
  await expect(page.getByRole("heading", { name: "Revisa el acceso" })).toBeVisible();
  await expect(page.getByText("90 días", { exact: true })).toBeVisible();

  const issueResponse = page.waitForResponse(
    (response) => response.url() === `${apiOrigin}/pats` && response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Confirmar y crear token" }).click();
  const response = await issueResponse;
  expect(response.status()).toBe(successStatus);
  expect(response.headers()["cache-control"]).toBe("no-store");
  const issuedBody = Schema.decodeUnknownSync(
    Schema.Struct({ data: Schema.Struct({ bearer: Schema.String }) })
  )(await response.json());
  const bearer = issuedBody.data.bearer;
  await expect(page.getByText(bearer)).toBeVisible();
  expect(page.url()).not.toContain(bearer);
  expect(await page.evaluate(browserStorageValues)).not.toContain(bearer);

  await page.getByRole("button", { name: "Copiar token" }).click();
  await expect(page.getByRole("button", { name: "Copiado" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(bearer);

  await revokeVisiblePAT(page, request, bearer);

  await page.getByRole("link", { name: "Transacciones" }).click();
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(/\/settings\/pats$/u);
  await expect(page.getByText(bearer)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("");
  await page.reload();
  await expect(page.getByText(bearer)).toHaveCount(0);
});

test("approves by verified email and creates the WebSession only on browser redemption", async ({
  context,
  page,
  request,
}) => {
  await resetAcceptanceState(request);
  await revokeAcceptanceConsent(request);
  await seedCurrentMonthTransaction(request);
  const identityBefore = await observeIdentity(request);
  await completePairingByEmail(page, request);
  expect(await observeSession(request)).toEqual({ sessionCount: 1, revoked: false });
  expect(await observeIdentity(request)).toEqual(identityBefore);
  const cookie = (await context.cookies(apiOrigin))
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const canonical = await request.get(`${apiOrigin}/transactions`, {
    headers: { cookie },
  });
  expect(canonical.status()).toBe(forbiddenStatus);
  expect(await canonical.json()).toMatchObject({ error: { code: "user_action_required" } });
});

test("establishes, retains, replays, and revokes a real PostgreSQL WebSession", async ({
  context,
  page,
  request,
}) => {
  await resetAcceptanceState(request);
  let redemptionPayload: unknown;
  page.on("request", (browserRequest) => {
    if (browserRequest.url() === `${apiOrigin}/web/pairings/redeem`) {
      redemptionPayload = browserRequest.postDataJSON();
    }
  });

  await completePairing(page, request);
  expect(redemptionPayload).toBeDefined();
  expect(await observeSession(request)).toEqual({ sessionCount: 1, revoked: false });
  await expect
    .poll(async () => (await context.cookies()).some(({ name }) => name === "__Host-fidy_session"))
    .toBe(true);
  expect(
    (await context.cookies()).find(({ name }) => name === "__Host-fidy_session")
  ).toMatchObject({
    domain: "127.0.0.1",
    httpOnly: true,
    path: "/",
    sameSite: "Strict",
    secure: true,
  });
  await assertReplayRefused(request, redemptionPayload);

  await page.reload();
  expect((await context.cookies()).map(({ name }) => name)).toContain("__Host-fidy_session");
  await revokeRetainedSession(page);
  await expect
    .poll(async () => (await context.cookies()).some(({ name }) => name === "__Host-fidy_session"))
    .toBe(false);
  expect(await observeSession(request)).toEqual({ sessionCount: 1, revoked: true });
  await assertUnknownWrongVerifierRefused(request);
});

test("renders authoritative PostgreSQL Subscription offers without starting payment", async ({
  page,
  request,
}) => {
  await resetAcceptanceState(request);
  await completePairing(page, request);
  const mutatingRequests: Array<string> = [];
  page.on("request", (browserRequest) => {
    if (browserRequest.url().startsWith(apiOrigin) && browserRequest.method() !== "GET") {
      mutatingRequests.push(`${browserRequest.method()} ${browserRequest.url()}`);
    }
  });

  const offersResponse = page.waitForResponse(
    (response) =>
      response.url() === `${apiOrigin}/subscription/offers` && response.request().method() === "GET"
  );
  await page.goto("/upgrade");
  const response = await offersResponse;
  expect(response.status()).toBe(successStatus);
  expect(await response.json()).toEqual(subscriptionOffersBody);

  await expect(page.getByText(/COP\s+9\.900\/semana$/u)).toBeVisible();
  await expect(page.getByText(/COP\s+28\.900\/mes$/u)).toBeVisible();
  await expect(page.getByText(/COP\s+289\.900\/año$/u)).toBeVisible();
  await expect(page.getByText(/Elige la frecuencia que prefieras/iu)).toHaveCount(0);
  const terms = page.getByRole("region", { name: "Condiciones de suscripción" });
  await expect(
    terms.getByText("Tu suscripción se renueva automáticamente al terminar cada período.")
  ).toBeVisible();
  await expect(
    terms.getByText(
      "Puedes cancelar renovaciones futuras y conservarás el acceso hasta terminar el período pagado."
    )
  ).toBeVisible();
  await expect(page.getByText(/no enviaremos un recordatorio/iu)).toHaveCount(0);
  await expect(page.getByText(/Precio final|No se cobra IVA/iu)).toHaveCount(0);
  await expect(page.getByText(/Colombia · Cobro/iu)).toHaveCount(0);
  await page.getByRole("button", { name: "Elegir mensual" }).click();
  await expect(page).toHaveURL(/\/upgrade$/u);
  const methods = page.getByRole("region", { name: "Métodos de pago" });
  await expect(
    methods.getByText("Elegiste la oferta mensual. La selección todavía no genera ningún cobro.")
  ).toBeVisible();
  await expect(methods.getByText("Tarjeta")).toBeVisible();
  await expect(methods.getByText("Nequi")).toBeVisible();
  await expect(methods.getByText("DaviPlata")).toBeVisible();
  expect(mutatingRequests).toEqual([]);
});

test("applies the same canonical Dashboard edit from the UI and a dashboard-scoped PAT", async ({
  page,
  request,
}) => {
  await resetAcceptanceState(request);
  await completePairing(page, request);
  const bearer = await issueDashboardPAT(page);

  await page.goto("/app/dashboard");
  await expect(page.getByRole("heading", { level: 1, name: "Tablero" })).toBeVisible();
  await page.getByRole("button", { name: "Personalizar" }).click();

  const patHeaders = { authorization: `Bearer ${bearer}` };
  const dragResponse = await dragRecentTransactionsToDashboardStart(page);
  expect(dragResponse.status()).toBe(successStatus);
  const dragEdit = Schema.decodeUnknownSync(DashboardEdit)(dragResponse.request().postDataJSON());
  if (dragEdit.op !== "add-widget") throw new Error("Expected the drag to compile an add edit");
  const uiDocument = Schema.decodeUnknownSync(DashboardDocumentResponse)(await dragResponse.json());
  const undo = await request.post(`${apiOrigin}/dashboard/edits`, {
    headers: patHeaders,
    data: { op: "remove-widget", widgetId: dragEdit.widget.id },
  });
  expect(undo.status()).toBe(successStatus);
  const agentDrag = await request.post(`${apiOrigin}/dashboard/edits`, {
    headers: patHeaders,
    data: dragEdit,
  });
  expect(agentDrag.status()).toBe(successStatus);
  const agentDocument = Schema.decodeUnknownSync(DashboardDocumentResponse)(await agentDrag.json());
  expect(agentDocument).toEqual(uiDocument);
});

test("moves a Dashboard Widget with the real keyboard sensor", async ({ page, request }) => {
  await resetAcceptanceState(request);
  await completePairing(page, request);
  await page.goto("/app/dashboard");
  await page.getByRole("button", { name: "Personalizar" }).click();

  expect((await moveBudgetWithKeyboard(page)).status()).toBe(successStatus);
});

test("renders real current-month PostgreSQL Transactions and Categories", async ({
  page,
  request,
}) => {
  await resetAcceptanceState(request);
  await completePairing(page, request);
  const seeded = await seedCurrentMonthTransaction(request);

  await page.reload();

  await expect(page.getByText("Exactitud S.A.").first()).toBeVisible();
  await expect(page.getByText(seeded.categoryLabel, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/USD\s+9\.007\.199\.254\.740\.993,12/u).first()).toBeVisible();
  await expect(page.getByText("Ingreso", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("America/Bogota", { exact: true })).toBeVisible();
});

test("drops Atom-owned User state when a real WebSession expires", async ({
  context,
  page,
  request,
}) => {
  await resetAcceptanceState(request);
  await completePairing(page, request);
  expect((await context.cookies()).map(({ name }) => name)).toContain("__Host-fidy_session");

  const expired = await request.post(`${controlOrigin}/expire-session`);
  expect(expired.status()).toBe(noContentStatus);
  await page.reload();

  await expect(
    page.getByText("Tu sesión venció. Inicia sesión de nuevo.", { exact: true })
  ).toBeVisible();
  await expect
    .poll(async () => (await context.cookies()).some(({ name }) => name === "__Host-fidy_session"))
    .toBe(false);
  await expect(page.getByRole("heading", { name: "Transacciones" })).not.toBeVisible();
});
