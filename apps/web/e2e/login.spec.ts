import { Effect } from "effect";
import { installUser } from "./http-fixtures";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;

test("keeps the pending task while choosing email and returning to login options", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const request = "24000000-0000-4000-8000-000000000123";
      const login = `/login?oauthRequest=${request}`;
      yield* Effect.tryPromise(() => page.goto(login));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Entra a tu Fidy" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Correo verificado", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Entra con tu correo" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page).toHaveURL(new RegExp(`${login.replace("?", "\\?")}$`, "u"))
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Opciones de inicio de sesión" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Continuar con Microsoft" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page).toHaveURL(new RegExp(`${login.replace("?", "\\?")}$`, "u"))
      );
    })
  ));

test("combines verified email and recovery settings under Account", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => page.goto("/settings/account"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Cuenta", exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Cambiar correo verificado" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("heading", { name: "Código de recuperación", exact: true })
        ).toBeVisible()
      );
    })
  ));

for (const route of [
  "/auth/google",
  "/auth/microsoft",
  "/auth/pair",
  "/settings/email",
  "/settings/recovery",
  "/settings/pats",
  "/settings/agents",
]) {
  test(`removes obsolete browser destination ${route}`, ({ page }) =>
    page
      .goto(route)
      .then(() =>
        expect(page.getByRole("heading", { name: "Página no encontrada" })).toBeVisible()
      ));
}
