import type { Page } from "@playwright/test";
import { type Cause, Effect, type Schema } from "effect";
import { playwright } from "./playwright-runtime";

type Theme = "light" | "dark";
type Capture = (theme: Theme) => Effect.Effect<void, Cause.UnknownError | Schema.SchemaError>;
const { expect } = playwright;
const selectTheme = (page: Page, theme: Theme): Promise<void> =>
  page
    .emulateMedia({ colorScheme: theme })
    .then(() => {
      const root = expect(page.locator("html"));
      return theme === "dark"
        ? root.toHaveClass(/(?:^|\s)dark(?:\s|$)/u)
        : root.not.toHaveClass(/(?:^|\s)dark(?:\s|$)/u);
    })
    .then(() =>
      expect(
        page
          .getByRole("button", {
            name: theme === "dark" ? "Activar tema claro" : "Activar tema oscuro",
            exact: true,
          })
          .first()
      ).toBeVisible()
    );

/** Audit every theme on the same prepared state, restoring the workflow's initial light theme. */
export const captureInThemes = Effect.fnUntraced(function* (page: Page, capture: Capture) {
  for (const theme of ["light", "dark"] as const) {
    yield* Effect.tryPromise(() => selectTheme(page, theme));
    yield* capture(theme);
  }
  yield* Effect.tryPromise(() => selectTheme(page, "light"));
});
