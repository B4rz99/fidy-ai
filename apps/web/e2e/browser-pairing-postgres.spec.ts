import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { Option, Schema } from "effect";

const apiOrigin = "https://127.0.0.1:4174";
const controlOrigin = "https://127.0.0.1:4175";
const opaqueProofEncodedLength = 43;
const successStatus = 200;
const noContentStatus = 204;
const invalidStatus = 400;
const invalidPairingBody = {
  error: {
    code: "pairing_invalid",
    message: "Esta vinculación ya no es válida. Inicia de nuevo.",
  },
};

const SessionObservation = Schema.Struct({
  sessionCount: Schema.Int,
  revoked: Schema.Boolean,
});

type SessionObservation = typeof SessionObservation.Type;

const resetAcceptanceState = async (request: APIRequestContext): Promise<void> => {
  expect((await request.post(`${controlOrigin}/reset`)).status()).toBe(noContentStatus);
};

const approvePairing = async (request: APIRequestContext, publicCode: string): Promise<void> => {
  const response = await request.post(`${controlOrigin}/approve-pairing`, {
    data: { publicCode },
  });
  expect(response.status()).toBe(noContentStatus);
};

const observeSession = async (request: APIRequestContext): Promise<SessionObservation> => {
  const response = await request.get(`${controlOrigin}/session-observation`);
  expect(response.status()).toBe(successStatus);
  return Schema.decodeUnknownSync(SessionObservation)(await response.json());
};

const revokeRetainedSession = async (page: Page): Promise<void> => {
  await page.evaluate((origin) => {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = `${origin}/web/session/logout`;
    document.body.append(form);
    form.submit();
  }, apiOrigin);
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

  await page.goto("/auth/pair");
  const startResponse = page.waitForResponse(
    (response) =>
      response.url() === `${apiOrigin}/web/pairings` && response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Iniciar sesión en el navegador" }).click();
  expect((await startResponse).status()).toBe(successStatus);
  const codeNode = page.locator('[aria-label^="Código de vinculación "]');
  await expect(codeNode).toBeVisible();
  const publicCode = Option.getOrThrow(Option.fromNullishOr(await codeNode.textContent())).trim();
  expect(publicCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u);
  await approvePairing(request, publicCode);

  await expect(page.getByText("Sesión iniciada", { exact: true })).toBeVisible({ timeout: 10_000 });
  expect(redemptionPayload).toBeDefined();
  expect(await observeSession(request)).toEqual({ sessionCount: 1, revoked: false });
  await expect
    .poll(async () => (await context.cookies()).some(({ name }) => name === "__Host-fidy_session"))
    .toBe(true);
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
