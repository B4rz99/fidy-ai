import { Effect } from "effect";
import { installUser } from "./http-fixtures";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;

test("chooses either provider or browser pairing in one login view without losing the pending task", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const request = "24000000-0000-4000-8000-000000000123";
      const login = `/login?oauthRequest=${request}`;
      yield* Effect.tryPromise(() => page.goto(login));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Continuar con Google" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Continuar con Microsoft" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "WhatsApp o correo verificado" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Iniciar sesión en el navegador" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page).toHaveURL(new RegExp(`${login.replace("?", "\\?")}$`, "u"))
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Google o Microsoft" }).click()
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
