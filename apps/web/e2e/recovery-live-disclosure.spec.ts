import { retainedSecretCount } from "./browser-storage-fixture";
import { Effect } from "effect";
import { playwright } from "./playwright-runtime";
import { signInWithVerifiedEmailThroughCore } from "./real-core-fixture";

const { test, expect } = playwright;
const confirmTwice = (button: HTMLButtonElement): void => {
  button.click();
  button.click();
};

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
      yield* Effect.tryPromise(() => page.goto("/settings/account"));
      let rotations = 0;
      page.on("request", (outgoing) => {
        if (outgoing.url().endsWith("/recovery/backup-code/rotate")) rotations += 1;
      });
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Crear un código nuevo" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Confirmar código nuevo" })).toBeVisible()
      );
      expect(rotations).toBe(0);
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Cancelar" }).click());
      expect(rotations).toBe(0);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Crear un código nuevo" }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Confirmar código nuevo" }).evaluate(confirmTwice)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Guárdalo ahora", { exact: true })).toBeVisible()
      );
      expect(rotations).toBe(1);
      yield* Effect.tryPromise(() =>
        expect(page.locator("code")).toHaveText(/^[A-Z2-9]{5}(?:-[A-Z2-9]{5}){4}$/u)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Copiar código" })).toBeVisible()
      );
      const code = yield* Effect.tryPromise(() => page.locator("code").textContent());
      expect(code).not.toBeNull();
      expect(page.url()).not.toContain(code);
      yield* Effect.tryPromise(() => page.goto("/app/transactions"));
      yield* Effect.tryPromise(() => page.goto("/settings/account"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Crear un código nuevo" })).toBeVisible()
      );
      yield* Effect.tryPromise(() => expect(page.locator("code")).toHaveCount(0));
      expect(yield* Effect.tryPromise(() => page.evaluate(retainedSecretCount))).toBe(0);
    })
  ));
