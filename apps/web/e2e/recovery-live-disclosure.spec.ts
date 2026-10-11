import { Effect } from "effect";
import { playwright } from "./playwright-runtime";
import { signInWithVerifiedEmailThroughCore } from "./real-core-fixture";

const { test, expect } = playwright;
const browserStorageSize = (): number => localStorage.length + sessionStorage.length;

test("discloses a real rotated recovery code only in its mounted settings view", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInWithVerifiedEmailThroughCore({
          page,
          request,
          email: "recovery-disclosure@example.com",
        })
      );
      yield* Effect.tryPromise(() => page.goto("/settings/recovery"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Crear un código nuevo" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Guárdalo ahora", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.locator("code")).toHaveText(/^[A-Z2-9]{5}(?:-[A-Z2-9]{5}){4}$/u)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Copiar código" })).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.goto("/app/transactions"));
      yield* Effect.tryPromise(() => page.goto("/settings/recovery"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Crear un código nuevo" })).toBeVisible()
      );
      yield* Effect.tryPromise(() => expect(page.locator("code")).toHaveCount(0));
      expect(yield* Effect.tryPromise(() => page.evaluate(browserStorageSize))).toBe(0);
    })
  ));
