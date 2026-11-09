import { retainedSecretCount } from "./browser-storage-fixture";
import type { Page, Route } from "@playwright/test";
import { type Cause, Deferred, Effect, Schema } from "effect";
import { ApprovePATPairingPayload, PATPairingPublicCodeInput } from "@fidy/server/client";
import { apiOrigin, response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;
const runJourney = <A, E>(work: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(work);

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

const browserStorageLength = (page: Page): Promise<number> => page.evaluate(retainedSecretCount);

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
        expect(
          page
            .getByRole("table", { name: "Tokens activos" })
            .getByText("Agente de casa", { exact: true })
        ).toBeVisible()
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
      yield* Effect.tryPromise(() => page.goto("/settings/access"));
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

const settlePairingApproval = ({
  route,
  release,
  approved,
  originalId,
}: Readonly<{
  route: Route;
  release: Deferred.Deferred<void>;
  approved: Array<string>;
  originalId: string;
}>): Promise<void> =>
  runJourney(
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ApprovePATPairingPayload)
      )(route.request().postData());
      approved.push(input.pairingId);
      if (input.pairingId === originalId) yield* Deferred.await(release);
      yield* Effect.tryPromise(() =>
        route.fulfill({
          status: ok,
          contentType: "application/json",
          body: response({
            pairingId: input.pairingId,
            patExpiresAt: "2099-01-08T00:00:00.000Z",
            claimBy: "2099-01-01T00:00:00.000Z",
          }),
        })
      );
    })
  );
test("abandoning an approval keeps its late response from completing a replacement review", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const originalId = "24000000-0000-4000-8000-000000000246";
      const replacementId = "24000000-0000-4000-8000-000000000247";
      const release = yield* Deferred.make<void>();
      const approved: Array<string> = [];
      yield* installRoute(page, `${apiOrigin}/pats/pairings/inspect`, (route) => {
        const input = Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.Struct({ publicCode: PATPairingPublicCodeInput }))
        )(route.request().postData());
        const replacement = input.publicCode === "JKLM-NPQR";
        return route.fulfill({
          status: ok,
          contentType: "application/json",
          body: response({
            pairingId: replacement ? replacementId : originalId,
            recipientLabel: replacement ? "Agente nuevo" : "Agente anterior",
            scopes: ["read"],
            lifetimeDays: 7,
            claimBy: "2099-01-01T00:00:00.000Z",
          }),
        });
      });
      yield* installRoute(page, `${apiOrigin}/pats/pairings/approve`, (route) =>
        settlePairingApproval({ route, release, approved, originalId })
      );
      yield* Effect.tryPromise(() => page.goto("/connect/cli?cliCode=BCDF-GHJK"));
      yield* Effect.tryPromise(() => expect(page.getByText("Agente anterior")).toBeVisible());
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Autorizar acceso" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Autorizando…" })).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Cerrar revisión" }).click());
      yield* Effect.tryPromise(() => page.getByLabel("Código", { exact: true }).fill("JKLM-NPQR"));
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Continuar" }).click());
      yield* Effect.tryPromise(() => expect(page.getByText("Agente nuevo")).toBeVisible());
      const settled = page.waitForResponse(`${apiOrigin}/pats/pairings/approve`);
      yield* Deferred.succeed(release, undefined);
      yield* Effect.tryPromise(() => settled);
      yield* Effect.tryPromise(() => expect(page.getByText("Acceso autorizado")).toHaveCount(0));
      yield* Effect.tryPromise(() => expect(page.getByText("Agente nuevo")).toBeVisible());
      expect(approved).toEqual([originalId]);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Autorizar acceso" }).click()
      );
      yield* Effect.tryPromise(() => expect(page.getByText("Acceso autorizado")).toBeVisible());
      expect(approved).toEqual([originalId, replacementId]);
    })
  ));

test("a lost PAT approval response stays uncertain without replaying or claiming login", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      let approvals = 0;
      yield* installRoute(page, `${apiOrigin}/pats/pairings/inspect`, (route) =>
        route.fulfill({
          status: ok,
          contentType: "application/json",
          body: response({
            pairingId: "24000000-0000-4000-8000-000000000246",
            recipientLabel: "Agente incierto",
            scopes: ["read"],
            lifetimeDays: 7,
            claimBy: "2099-01-01T00:00:00.000Z",
          }),
        })
      );
      yield* installRoute(page, `${apiOrigin}/pats/pairings/approve`, (route) => {
        approvals += 1;
        return route.abort("failed");
      });
      yield* Effect.tryPromise(() => page.goto("/connect/cli?cliCode=BCDF-GHJK"));
      yield* Effect.tryPromise(() => expect(page.getByText("Agente incierto")).toBeVisible());
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Autorizar acceso" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("No pudimos confirmar la autorización")).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Revisar accesos" })).toHaveAttribute(
          "href",
          "/settings/access"
        )
      );
      yield* Effect.tryPromise(() => expect(page.getByText("Acceso autorizado")).toHaveCount(0));
      yield* Effect.tryPromise(() =>
        expect(page.getByText("No encontramos ese código")).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Autorizar acceso" })).toHaveCount(0)
      );
      expect(approvals).toBe(1);
    })
  ));
