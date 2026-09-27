import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { apiOrigin, response } from "./http-fixtures";

const patId = "24000000-0000-4000-8000-000000000245";
const pat = {
  _tag: "PAT",
  id: patId,
  shortId: "default1",
  recipientLabel: "Agente de casa",
  scopes: ["read"],
  lifetimeDays: 30,
  lastUsedAt: null,
  revokedAt: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  expiresAt: "2026-10-01T00:00:00.000Z",
  idleExpiresAt: "2026-10-01T00:00:00.000Z",
};
const bearer = "fin_default1_0123456789abcdefghijklmnopqrstuvwxyzABCD";
const code = "ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2";
const ok = 200;

const installActivePATs = async (page: Page): Promise<void> => {
  await page.route(`${apiOrigin}/pats`, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: ok,
      contentType: "application/json",
      body: response({ pats: [] }),
    });
  });
};

const showIssuedPATForRevocation = async (page: Page): Promise<void> => {
  await page.route(`${apiOrigin}/pats`, (route) =>
    route.fulfill({
      status: ok,
      contentType: "application/json",
      body: response({
        pats: [
          {
            shortId: pat.shortId,
            recipientLabel: pat.recipientLabel,
            scopes: pat.scopes,
            createdAt: pat.createdAt,
            lastUsedAt: null,
            expiresAt: pat.expiresAt,
          },
        ],
      }),
    })
  );
  await page.reload();
  await expect(page.getByRole("heading", { name: "Agente de casa" })).toBeVisible();
  expect(await page.locator("body").textContent()).not.toContain(bearer);
};

test("reviews, issues, discloses once, and revokes a manually created PAT", async ({ page }) => {
  await installActivePATs(page);
  let issued: unknown;
  let revoked = false;
  await page.route(`${apiOrigin}/pats`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    issued = route.request().postDataJSON();
    await route.fulfill({
      status: ok,
      contentType: "application/json",
      body: response({ pat, bearer }),
    });
  });
  await page.route(`${apiOrigin}/pats/default1`, async (route) => {
    revoked = true;
    await route.fulfill({
      status: ok,
      contentType: "application/json",
      body: response({ shortId: "default1" }),
    });
  });
  await page.goto("/settings/pats");
  await page.getByLabel("Nombre", { exact: true }).fill("Agente de casa");
  await page.getByRole("checkbox", { name: /^Lectura:/u }).check();
  await page.getByRole("button", { name: "30 días" }).click();
  await page.getByRole("button", { name: "Revisar token" }).click();
  await expect(page.getByRole("heading", { name: "Revisa el acceso" })).toBeVisible();
  expect(issued).toBeUndefined();
  await page.getByRole("button", { name: "Confirmar y crear token" }).click();
  await expect(page.getByText(bearer)).toBeVisible();
  expect(issued).toMatchObject({
    grant: { recipientLabel: "Agente de casa", scopes: ["read"], lifetimeDays: 30 },
  });
  expect(page.url()).not.toContain(bearer);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  await page.getByRole("button", { name: "Crear otro token" }).click();
  await expect(page.getByText(bearer)).toHaveCount(0);
  await showIssuedPATForRevocation(page);
  await page.getByRole("button", { name: "Desactivar", exact: true }).click();
  await page.getByRole("button", { name: "Sí, desactivar" }).click();
  await expect(page.getByText("Token desactivado. Dejó de funcionar de inmediato.")).toBeVisible();
  expect(revoked).toBe(true);
});

test("reviews a PATPairing before approval without receiving its private bearer", async ({
  page,
}) => {
  await installActivePATs(page);
  const pairingId = "24000000-0000-4000-8000-000000000246";
  let approved = false;
  await page.route(`${apiOrigin}/pats/pairings/inspect`, (route) => {
    expect(route.request().postDataJSON()).toEqual({ publicCode: "BCDF-GHJK" });
    return route.fulfill({
      status: ok,
      contentType: "application/json",
      body: response({
        pairingId,
        recipientLabel: "Agente de casa",
        scopes: ["read"],
        lifetimeDays: 30,
        claimBy: "2099-01-01T00:00:00.000Z",
      }),
    });
  });
  await page.route(`${apiOrigin}/pats/pairings/approve`, (route) => {
    expect(route.request().postDataJSON()).toEqual({ pairingId });
    approved = true;
    return route.fulfill({
      status: ok,
      contentType: "application/json",
      body: response({
        pairingId,
        patExpiresAt: "2099-02-01T00:00:00.000Z",
        claimBy: "2099-01-01T00:00:00.000Z",
      }),
    });
  });
  await page.goto("/settings/pats");
  await page.getByLabel("Código", { exact: true }).fill("bcdf-ghjk");
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByText("Agente de casa").first()).toBeVisible();
  expect(approved).toBe(false);
  await page.getByRole("button", { name: "Autorizar acceso" }).click();
  await expect(page.getByText("Acceso autorizado")).toBeVisible();
  expect(approved).toBe(true);
  expect(await page.locator("body").textContent()).not.toContain(bearer);
});

test("rotates a BackupRecoveryCode in a fresh session and drops the proof on navigation", async ({
  page,
}) => {
  let rotated = false;
  await page.route(`${apiOrigin}/recovery/backup-code/rotate`, (route) => {
    rotated = true;
    return route.fulfill({
      status: ok,
      contentType: "application/json",
      body: response({
        status: "rotated",
        backupRecoveryCode: code,
        rotatedAt: "2026-09-27T00:00:00.000Z",
      }),
    });
  });
  await page.goto("/settings/recovery");
  await page.getByRole("button", { name: "Crear un código nuevo" }).click();
  await expect(page.getByText(code)).toBeVisible();
  expect(rotated).toBe(true);
  expect(page.url()).not.toContain(code);
  await page.goto("/settings/pats");
  expect(await page.locator("body").textContent()).not.toContain(code);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});
