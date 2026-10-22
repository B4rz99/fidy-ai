import type { Page } from "@playwright/test";
import { Effect } from "effect";
import { apiOrigin } from "./http-fixtures";
import { playwright } from "./playwright-runtime";
import { signInRecurringThroughCore } from "./real-core-fixture";

const { expect, test } = playwright;
const quietWindowMilliseconds = 1000;

const observeRepeatedRead = (page: Page): Promise<boolean> =>
  page
    .waitForRequest(
      (incoming) =>
        incoming.method() === "GET" && incoming.url().startsWith(`${apiOrigin}/recurring-plans?`),
      { timeout: quietWindowMilliseconds }
    )
    .then(
      () => true,
      () => false
    );

test("settled recurring reads stay quiet after presentation and month changes", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInRecurringThroughCore({ page, request, identity: "recurringStableReads" })
      );
      yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-10"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Nuevo recurrente", exact: true })).toBeEnabled()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Todos los recurrentes", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Mensual", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Mes siguiente", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "noviembre de 2026", exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Nuevo recurrente", exact: true })).toBeEnabled()
      );
      const repeatedRead = yield* Effect.tryPromise(() => observeRepeatedRead(page));
      expect(repeatedRead).toBe(false);
    })
  ));
