import { type Cause, Effect } from "effect";
import { apiOrigin, makeUser, response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;

const wait = <A>(promise: Promise<A>): Effect.Effect<A, Cause.UnknownError> =>
  Effect.tryPromise(() => promise);
// Browser-level HTTP fixtures exercise the built app and generated client; platform authority is
// covered separately by the public-ingress integration tests, not simulated in this suite.
test("loads empty Transactions through canonical queries on the separate API origin", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const requests: Array<string> = [];
      yield* wait(
        page.route(`${apiOrigin}/user`, (route) => {
          requests.push(route.request().url());
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: response(makeUser()),
          });
        })
      );
      yield* wait(
        page.route(`${apiOrigin}/categories`, (route) => {
          requests.push(route.request().url());
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: response([]),
          });
        })
      );
      yield* wait(
        page.route(new RegExp(`^${apiOrigin}/transactions\\?`, "u"), (route) => {
          requests.push(route.request().url());
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: response([]),
          });
        })
      );
      yield* wait(page.goto("/app/transactions"));
      yield* wait(expect(page.getByText("No hay transacciones para mostrar")).toBeVisible());
      expect(requests).toHaveLength(3);
      expect(requests.every((url) => url.startsWith(apiOrigin))).toBe(true);
    })
  ));
test("replaces verified email through two canonical operations without putting the proof in a URL", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const email = "nuevo@example.com";
      const code = "ABCD-EFGH-JKLM-NPQR-STUV-WXYZ";
      const calls: Array<string> = [];
      yield* wait(
        page.route(`${apiOrigin}/email/replacement`, (route) => {
          calls.push(route.request().url());
          expect(route.request().postDataJSON()).toEqual({ candidateEmail: email });
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: response({ status: "pending" }),
          });
        })
      );
      yield* wait(
        page.route(`${apiOrigin}/web/email/replacement/verify`, (route) => {
          calls.push(route.request().url());
          expect(route.request().postDataJSON()).toEqual({ combinedCode: code });
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: response({ status: "replaced" }),
          });
        })
      );
      yield* wait(page.goto("/settings/email"));
      yield* wait(page.getByLabel("Nuevo correo").fill(email));
      yield* wait(page.getByRole("button", { name: "Enviar código" }).click());
      yield* wait(expect(page.getByText(`Enviamos un código a ${email}.`)).toBeVisible());
      yield* wait(page.getByLabel("Código de verificación").fill(code));
      yield* wait(page.getByRole("button", { name: "Cambiar correo" }).click());
      yield* wait(
        expect(page.getByText("Tu nuevo correo verificado ya está activo.")).toBeVisible()
      );
      expect(calls).toEqual([
        `${apiOrigin}/email/replacement`,
        `${apiOrigin}/web/email/replacement/verify`,
      ]);
      expect(page.url()).not.toContain(code);
      expect(yield* wait(page.evaluate(() => localStorage.length + sessionStorage.length))).toBe(0);
    })
  ));
test("an under-scoped Transactions query displays only generic failure copy", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const secret = "other-user-financial-content";
      yield* wait(
        page.route(`${apiOrigin}/user`, (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: response(makeUser()),
          })
        )
      );
      yield* wait(
        page.route(`${apiOrigin}/categories`, (route) =>
          route.fulfill({ status: 200, contentType: "application/json", body: response([]) })
        )
      );
      yield* wait(
        page.route(new RegExp(`^${apiOrigin}/transactions\\?`, "u"), (route) =>
          route.fulfill({
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "scope_missing", message: secret }, next: [] }),
          })
        )
      );
      yield* wait(page.goto("/app/transactions"));
      yield* wait(expect(page.getByText("No pudimos cargar tus transacciones")).toBeVisible());
      expect(yield* wait(page.locator("body").textContent())).not.toContain(secret);
    })
  ));
test("revoked session hides Transactions without showing an internal response body", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const secret = "internal-session-diagnostics";
      yield* wait(
        page.route(`${apiOrigin}/user`, (route) =>
          route.fulfill({
            status: 401,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "unauthenticated", message: secret }, next: [] }),
          })
        )
      );
      yield* wait(page.goto("/app/transactions"));
      yield* wait(
        expect(page.getByText("Tu sesión venció. Inicia sesión de nuevo.")).toBeVisible()
      );
      yield* wait(expect(page.getByText("No hay transacciones para mostrar")).toHaveCount(0));
      expect(yield* wait(page.locator("body").textContent())).not.toContain(secret);
    })
  ));
