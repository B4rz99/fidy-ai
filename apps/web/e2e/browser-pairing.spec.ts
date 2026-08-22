import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { Clock, DateTime, Effect } from "effect";

const opaqueProofEncodedLength = 43;
const minimumPollIntervalMilliseconds = 5_000;
const successStatus = 200;
const pendingStatus = 202;
const invalidStatus = 400;
const rateLimitedStatus = 429;
const pairingId = "24000000-0000-4000-8000-000000000240";
const privateVerifier = "v".repeat(opaqueProofEncodedLength);
const publicCode = "BCDF-GHJK";
const expiresAt = "2099-01-01T00:00:00.000Z";
const invalidPairingMessage = "Esta vinculación ya no es válida. Inicia de nuevo.";

type PairingApiFixture = {
  startCount: number;
  redeemCount: number;
  activeRedeems: number;
  maximumActiveRedeems: number;
  logoutCount: number;
  readonly redeemTimes: Array<number>;
};

const installStartAndLogoutRoutes = async (
  page: Page,
  fixture: PairingApiFixture
): Promise<void> => {
  await page.route("**/web/pairings", async (route) => {
    fixture.startCount += 1;
    await route.fulfill({
      contentType: "application/json",
      status: successStatus,
      body: JSON.stringify({
        pairingId,
        privateVerifier,
        publicCode,
        expiresAt,
        pollingIntervalSeconds: 5,
      }),
    });
  });
  await page.route("**/web/session/logout", async (route) => {
    fixture.logoutCount += 1;
    await route.fulfill({
      status: 204,
      headers: {
        "set-cookie": "__Host-fidy_session=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      },
    });
  });
};

const installPairingApiFixture = async (page: Page): Promise<PairingApiFixture> => {
  const fixture: PairingApiFixture = {
    startCount: 0,
    redeemCount: 0,
    activeRedeems: 0,
    maximumActiveRedeems: 0,
    logoutCount: 0,
    redeemTimes: [],
  };
  await installStartAndLogoutRoutes(page, fixture);
  await page.route("**/web/pairings/redeem", async (route) => {
    fixture.activeRedeems += 1;
    fixture.maximumActiveRedeems = Math.max(fixture.maximumActiveRedeems, fixture.activeRedeems);
    fixture.redeemCount += 1;
    fixture.redeemTimes.push(await Effect.runPromise(Clock.currentTimeMillis));
    expect(route.request().postDataJSON()).toEqual({ pairingId, privateVerifier });
    await Effect.runPromise(Effect.sleep("100 millis"));
    fixture.activeRedeems -= 1;

    const pending = fixture.redeemCount === 1;
    const responseHeaders: Record<string, string> = {
      "access-control-allow-origin": "https://127.0.0.1:4173",
      "access-control-allow-credentials": "true",
    };
    if (!pending) {
      responseHeaders["set-cookie"] =
        "__Host-fidy_session=session-test; Secure; HttpOnly; SameSite=Strict; Path=/";
    }
    await route.fulfill({
      contentType: "application/json",
      status: pending ? pendingStatus : successStatus,
      headers: responseHeaders,
      body: JSON.stringify(
        pending
          ? { status: "pending_approval", expiresAt, pollingIntervalSeconds: 5 }
          : { status: "authenticated" }
      ),
    });
  });
  return fixture;
};

const expectVerifierIsBrowserEphemeral = async (page: Page): Promise<void> => {
  expect(page.url()).not.toContain(pairingId);
  expect(page.url()).not.toContain(privateVerifier);
  expect(await page.locator("html").textContent()).not.toContain(pairingId);
  expect(await page.locator("html").textContent()).not.toContain(privateVerifier);
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))
  ).toEqual({ local: 0, session: 0 });
  expect(await page.evaluate(async () => await caches.keys())).toEqual([]);
  await expect(page.getByRole("link", { name: "Abrir WhatsApp" })).not.toHaveAttribute(
    "href",
    new RegExp(`${pairingId}|${privateVerifier}`, "u")
  );
};

test("keeps the verifier ephemeral, polls sequentially, retains the cookie, and logs out", async ({
  context,
  page,
}) => {
  const api = await installPairingApiFixture(page);
  await page.goto("/auth/pair");
  await expect(page.getByRole("button", { name: "Iniciar sesión en el navegador" })).toBeVisible();
  expect(api.startCount).toBe(0);

  await page.getByRole("button", { name: "Iniciar sesión en el navegador" }).click();
  await expect(page.getByText(publicCode, { exact: true })).toBeVisible();
  expect(api.startCount).toBe(1);
  await expectVerifierIsBrowserEphemeral(page);
  await expect(page.getByText("Sesión iniciada", { exact: true })).toBeVisible({ timeout: 15_000 });

  expect(api.redeemCount).toBe(2);
  expect(api.maximumActiveRedeems).toBe(1);
  const [firstPollAt = 0, secondPollAt = 0] = api.redeemTimes;
  expect(secondPollAt - firstPollAt).toBeGreaterThanOrEqual(minimumPollIntervalMilliseconds);
  expect(await context.cookies()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "__Host-fidy_session",
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
      }),
    ])
  );

  await page.reload();
  await expect(page.getByRole("button", { name: "Iniciar sesión en el navegador" })).toBeVisible();
  expect(api.startCount).toBe(1);
  expect(await context.cookies()).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "__Host-fidy_session" })])
  );

  await page.getByRole("button", { name: "Iniciar sesión en el navegador" }).click();
  await expect(page.getByText("Sesión iniciada", { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Cerrar sesión" }).click();
  await expect(page.getByRole("button", { name: "Iniciar sesión en el navegador" })).toBeVisible();
  expect(api.logoutCount).toBe(1);
  expect((await context.cookies()).some(({ name }) => name === "__Host-fidy_session")).toBe(false);
});

test("honors server slowdown before showing the generic terminal refusal", async ({ page }) => {
  let redeemCount = 0;
  await page.route("**/web/pairings", (route) =>
    route.fulfill({
      contentType: "application/json",
      status: successStatus,
      body: JSON.stringify({
        pairingId,
        privateVerifier,
        publicCode,
        expiresAt,
        pollingIntervalSeconds: 5,
      }),
    })
  );
  await page.route("**/web/pairings/redeem", async (route) => {
    redeemCount += 1;
    await route.fulfill(
      redeemCount === 1
        ? {
            contentType: "application/json",
            status: rateLimitedStatus,
            headers: { "retry-after": "10" },
            body: JSON.stringify({ error: { code: "rate_limited", retryAfterSeconds: 10 } }),
          }
        : {
            contentType: "application/json",
            status: invalidStatus,
            body: JSON.stringify({
              error: { code: "pairing_invalid", message: invalidPairingMessage },
            }),
          }
    );
  });

  await page.goto("/auth/pair");
  await page.getByRole("button", { name: "Iniciar sesión en el navegador" }).click();
  await expect(page.getByText(invalidPairingMessage)).toBeVisible({ timeout: 20_000 });
  expect(redeemCount).toBe(2);
});

test("stops at pairing expiry after a timed-out poll without creating a replacement", async ({
  page,
}) => {
  let startCount = 0;
  let redeemCount = 0;
  await page.route("**/web/pairings", async (route) => {
    startCount += 1;
    const shortExpiry = await Effect.runPromise(
      DateTime.now.pipe(
        Effect.map((now) => DateTime.add(now, { seconds: 6 })),
        Effect.map(DateTime.formatIso)
      )
    );
    await route.fulfill({
      contentType: "application/json",
      status: successStatus,
      body: JSON.stringify({
        pairingId,
        privateVerifier,
        publicCode,
        expiresAt: shortExpiry,
        pollingIntervalSeconds: 5,
      }),
    });
  });
  await page.route("**/web/pairings/redeem", async () => {
    redeemCount += 1;
  });

  await page.goto("/auth/pair");
  await page.getByRole("button", { name: "Iniciar sesión en el navegador" }).click();
  await expect(page.getByText(invalidPairingMessage)).toBeVisible({ timeout: 10_000 });
  expect(startCount).toBe(1);
  expect(redeemCount).toBe(1);
});
