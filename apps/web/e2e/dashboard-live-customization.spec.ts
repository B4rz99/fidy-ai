import { Effect } from "effect";
import type { Page, Response } from "@playwright/test";
import { playwright } from "./playwright-runtime";
import { signInFirstDaviplataThroughCore } from "./real-core-fixture";

const { test, expect } = playwright;
const successStatus = 200;
const admittedEdit = (page: Page): Promise<Response> =>
  page.waitForResponse(
    (response) => response.url().endsWith("/dashboard/edits") && response.status() === successStatus
  );

test("persists Widget renaming and removal through the real Dashboard editor", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => signInFirstDaviplataThroughCore({ page, request }));
      yield* Effect.tryPromise(() => page.goto("/app/dashboard"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Personalizar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page
          .getByRole("button", { name: /^Renombrar /u })
          .first()
          .click()
      );
      const title = "Widget verificado en navegador";
      yield* Effect.tryPromise(() => page.getByLabel("Nuevo nombre del Widget").fill(title));
      const renamed = admittedEdit(page);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Guardar nombre del Widget" }).click()
      );
      expect((yield* Effect.tryPromise(() => renamed)).status()).toBe(successStatus);
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Guardar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Personalizar", exact: true }).click()
      );
      const removed = admittedEdit(page);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: `Eliminar ${title}`, exact: true }).click()
      );
      expect((yield* Effect.tryPromise(() => removed)).status()).toBe(successStatus);
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: title, exact: true })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Guardar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Personalizar", exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: title, exact: true })).toHaveCount(0)
      );
    })
  ));
