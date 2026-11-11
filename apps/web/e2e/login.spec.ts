import { Effect } from "effect";
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
