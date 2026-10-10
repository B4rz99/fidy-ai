import type { Page, Route } from "@playwright/test";
import { type Cause, Effect } from "effect";
import { apiOrigin, response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;

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
const installRoute = (
  page: Page,
  url: string,
  handler: (route: Route) => Promise<void>
): Effect.Effect<unknown, Cause.UnknownError> => Effect.tryPromise(() => page.route(url, handler));
const revokeIssuedPAT = (page: Page): Promise<void> =>
  showIssuedPATForRevocation(page)
    .then(() => page.getByRole("button", { name: "Desactivar", exact: true }).click())
    .then(() => page.getByRole("button", { name: "Sí, desactivar" }).click())
    .then(() =>
      expect(page.getByText("Token desactivado. Dejó de funcionar de inmediato.")).toBeVisible()
    );

const browserStorageLength = (page: Page): Promise<number> =>
  page.evaluate(() => localStorage.length + sessionStorage.length);

const installActivePATs = (page: Page): Promise<unknown> =>
  page.route(`${apiOrigin}/pats`, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: ok,
      contentType: "application/json",
      body: response({ pats: [] }),
    });
  });

const showIssuedPATForRevocation = (page: Page): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}/pats`, (route) =>
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
        )
      );
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Agente de casa", { exact: true })).toBeVisible()
      );
      expect(yield* Effect.tryPromise(() => page.locator("body").textContent())).not.toContain(
        bearer
      );
    })
  );

test("reviews, issues, discloses once, and revokes a manually created PAT", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installActivePATs(page));
      let issued: unknown;
      let revoked = false;
      yield* installRoute(page, `${apiOrigin}/pats`, (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        issued = route.request().postDataJSON();
        return route.fulfill({
          status: ok,
          contentType: "application/json",
          body: response({ pat, bearer }),
        });
      });
      yield* installRoute(page, `${apiOrigin}/pats/default1`, (route) => {
        revoked = true;
        return route.fulfill({
          status: ok,
          contentType: "application/json",
          body: response({ shortId: "default1" }),
        });
      });
      yield* Effect.tryPromise(() => page.goto("/settings/pats"));
      yield* Effect.tryPromise(() =>
        page.getByLabel("Nombre", { exact: true }).fill("Agente de casa")
      );
      yield* Effect.tryPromise(() => page.getByRole("checkbox", { name: /^Lectura:/u }).check());
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Duración del token" }).click()
      );
      yield* Effect.tryPromise(() => page.getByRole("menuitemradio", { name: "30 días" }).click());
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Crear token" }).click());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Revisa el acceso" })).toBeVisible()
      );
      expect(issued).toBeUndefined();
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Confirmar y crear token" }).click()
      );
      yield* Effect.tryPromise(() => expect(page.getByText(bearer)).toBeVisible());
      expect(issued).toMatchObject({
        grant: { recipientLabel: "Agente de casa", scopes: ["read"], lifetimeDays: 30 },
      });
      expect(page.url()).not.toContain(bearer);
      expect(yield* Effect.tryPromise(() => browserStorageLength(page))).toBe(0);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Crear otro token" }).click()
      );
      yield* Effect.tryPromise(() => expect(page.getByText(bearer)).toHaveCount(0));
      yield* Effect.tryPromise(() => revokeIssuedPAT(page));
      expect(revoked).toBe(true);
    })
  ));

test("reviews a PATPairing before approval without receiving its private bearer", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installActivePATs(page));
      const pairingId = "24000000-0000-4000-8000-000000000246";
      let approved = false;
      yield* installRoute(page, `${apiOrigin}/pats/pairings/inspect`, (route) => {
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
      yield* installRoute(page, `${apiOrigin}/pats/pairings/approve`, (route) => {
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
      yield* Effect.tryPromise(() => page.goto("/connect/cli?cliCode=BCDF-GHJK"));
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Agente de casa").first()).toBeVisible()
      );
      expect(approved).toBe(false);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Autorizar acceso" }).click()
      );
      yield* Effect.tryPromise(() => expect(page.getByText("Acceso autorizado")).toBeVisible());
      expect(approved).toBe(true);
      expect(yield* Effect.tryPromise(() => page.locator("body").textContent())).not.toContain(
        bearer
      );
    })
  ));

test("rotates a BackupRecoveryCode in a fresh session and drops the proof on navigation", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      let rotated = false;
      yield* installRoute(page, `${apiOrigin}/recovery/backup-code/rotate`, (route) => {
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
      yield* Effect.tryPromise(() => page.goto("/settings/recovery"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Crear un código nuevo" }).click()
      );
      yield* Effect.tryPromise(() => expect(page.getByText(code)).toBeVisible());
      expect(rotated).toBe(true);
      expect(page.url()).not.toContain(code);
      yield* Effect.tryPromise(() => page.goto("/settings/pats"));
      expect(yield* Effect.tryPromise(() => page.locator("body").textContent())).not.toContain(
        code
      );
      expect(yield* Effect.tryPromise(() => browserStorageLength(page))).toBe(0);
    })
  ));
