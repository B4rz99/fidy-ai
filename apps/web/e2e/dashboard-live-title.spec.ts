import { Effect } from "effect";
import { playwright } from "./playwright-runtime";
import { signInThroughCore } from "./real-core-fixture";

const { test, expect } = playwright;
const successStatus = 200;

test("persists the Dashboard title through the visible editor and browser reload", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => signInThroughCore({ page, request }));
      yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
      yield* Effect.tryPromise(() => expect(page.getByRole("heading", { level: 1 })).toBeVisible());
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Personalizar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Renombrar tablero" }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByLabel("Nuevo nombre del tablero").fill("  Mis finanzas verificadas  ")
      );
      const edited = page.waitForResponse(
        (response) =>
          response.url().endsWith("/dashboard/edits") && response.status() === successStatus
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Guardar nombre del tablero" }).click()
      );
      expect((yield* Effect.tryPromise(() => edited)).status()).toBe(successStatus);
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("heading", { level: 1, name: "Mis finanzas verificadas", exact: true })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("heading", { level: 1, name: "Mis finanzas verificadas", exact: true })
        ).toBeVisible()
      );
    })
  ));
