import { Effect, Option } from "effect";
import type { Page, Route } from "@playwright/test";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;
const runningAnimations = (): number =>
  document.getAnimations().filter((animation) => animation.playState === "running").length;

const releaseSignupDisclosure = (pending: () => Option.Option<Route>): Promise<void> =>
  expect
    .poll(() => Option.isSome(pending()))
    .toBe(true)
    .then(() => Option.getOrThrow(pending()))
    .then((route) => route.fetch().then((response) => route.fulfill({ response })));
const holdSignupDisclosure = (page: Page): Promise<Readonly<{ release: () => Promise<void> }>> => {
  let pending = Option.none<Route>();
  return page
    .route("**/web/providers/disclosure", (route) => {
      pending = Option.some(route);
    })
    .then(() => ({ release: () => releaseSignupDisclosure(() => pending) }));
};
const expectProvidersAvailable = (page: Page, available: boolean): Promise<void[]> =>
  Promise.all(
    ["Google", "Microsoft"].map((provider) => {
      const button = page.getByRole("button", { name: `Continuar con ${provider}` });
      return available ? expect(button).toBeEnabled() : expect(button).toBeDisabled();
    })
  );

test("signup waits for Consent and clears acceptance when returning to login", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const disclosure = yield* Effect.tryPromise(() => holdSignupDisclosure(page));
      yield* Effect.tryPromise(() => page.goto("/login"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Crea tu cuenta", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("status", { name: "Cargando información de Consentimiento", exact: true })
        ).toHaveAttribute("aria-busy", "true")
      );
      yield* Effect.tryPromise(() => expectProvidersAvailable(page, false));
      yield* Effect.tryPromise(disclosure.release);
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Elige cómo crear tu cuenta.", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByText("Fidy usa tus datos para proteger tu cuenta y organizar tus finanzas.")
        ).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("link", { name: "Política de privacidad" })).toHaveAttribute(
          "href",
          "https://app.fidyapp.com/politica"
        )
      );
      const acceptance = page.getByRole("checkbox", {
        name: "Acepto el tratamiento de datos descrito en la Política de privacidad.",
      });
      for (const visit of [0, 1]) {
        yield* Effect.tryPromise(() => expect(acceptance).not.toBeChecked());
        yield* Effect.tryPromise(() => acceptance.check());
        yield* Effect.tryPromise(() => expectProvidersAvailable(page, true));
        yield* Effect.tryPromise(() => acceptance.uncheck());
        yield* Effect.tryPromise(() => expectProvidersAvailable(page, false));
        yield* Effect.tryPromise(() => acceptance.check());
        yield* Effect.tryPromise(() =>
          page.getByRole("button", { name: "Iniciar sesión", exact: true }).click()
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("heading", { name: "Entra a tu Fidy", exact: true })).toBeVisible()
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("button", { name: "Correo verificado", exact: true })).toBeVisible()
        );
        if (visit === 0) {
          yield* Effect.tryPromise(() =>
            page.getByRole("button", { name: "Crea tu cuenta", exact: true }).click()
          );
        }
      }
    })
  ));

test("offers independent mailbox and WhatsApp methods and remembers a manual theme", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => page.emulateMedia({ colorScheme: "dark" }));
      yield* Effect.tryPromise(() => page.goto("/login"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Activar tema claro" })).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.emulateMedia({ colorScheme: "light" }));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Activar tema oscuro" })).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.emulateMedia({ colorScheme: "dark" }));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Activar tema claro" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Activar tema claro" }).click()
      );
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Activar tema oscuro" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Correo verificado", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Entra con tu correo" })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Opciones de inicio de sesión" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "WhatsApp", exact: true })).toBeVisible()
      );
    })
  ));

test("supports keyboard access and reduced motion while history discards the email draft", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => page.emulateMedia({ reducedMotion: "reduce" }));
      yield* Effect.tryPromise(() => page.goto("/login"));
      const principal = page.getByRole("heading", { name: "Entra a tu Fidy", exact: true });
      yield* Effect.tryPromise(() => expect(principal).toBeFocused());
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Correo verificado", exact: true }).press("Enter")
      );
      const email = page.getByRole("heading", { name: "Entra con tu correo", exact: true });
      yield* Effect.tryPromise(() => expect(email).toBeFocused());
      yield* Effect.tryPromise(() => page.keyboard.press("Tab"));
      yield* Effect.tryPromise(() => expect(page.getByLabel("Correo verificado")).toBeFocused());
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Opciones de inicio de sesión" }).press("Enter")
      );
      yield* Effect.tryPromise(() => expect(principal).toBeFocused());
      expect(yield* Effect.tryPromise(() => page.evaluate(runningAnimations))).toBe(0);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Correo verificado", exact: true }).press("Enter")
      );
      yield* Effect.tryPromise(() =>
        page.getByLabel("Correo verificado").fill("borrador@example.com")
      );
      yield* Effect.tryPromise(() => page.goto("/missing-login-history"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Página no encontrada" })).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.goBack());
      yield* Effect.tryPromise(() => expect(page).toHaveURL(/\/login$/u));
      yield* Effect.tryPromise(() => expect(principal).toBeFocused());
      yield* Effect.tryPromise(() => page.goForward());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: "Página no encontrada" })).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.goBack());
      yield* Effect.tryPromise(() => expect(principal).toBeFocused());
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Correo verificado", exact: true }).press("Enter")
      );
      yield* Effect.tryPromise(() => expect(email).toBeFocused());
      yield* Effect.tryPromise(() => expect(page.getByLabel("Correo verificado")).toHaveValue(""));
    })
  ));

const backHoverCoverage = (
  element: Element
): Readonly<{ contained: boolean; background: string }> => {
  const bounds = element.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(element);
  const content = range.getBoundingClientRect();
  return {
    contained: content.left >= bounds.left && content.right <= bounds.right,
    background: getComputedStyle(element).backgroundColor,
  };
};

for (const colorScheme of ["light", "dark"] as const) {
  test(`back hover contains its complete label in ${colorScheme}`, ({ page }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() => page.emulateMedia({ colorScheme }));
        yield* Effect.tryPromise(() => page.goto("/login"));
        yield* Effect.tryPromise(() =>
          page.getByRole("button", { name: "Correo verificado", exact: true }).click()
        );
        const back = page.getByRole("button", { name: "Opciones de inicio de sesión" });
        yield* Effect.tryPromise(() => back.hover());
        yield* Effect.tryPromise(() =>
          expect(back).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
        );
        const coverage = yield* Effect.tryPromise(() => back.evaluate(backHoverCoverage));
        expect(coverage.contained).toBe(true);
        expect(coverage.background).not.toBe("rgba(0, 0, 0, 0)");
      })
    ));
}
