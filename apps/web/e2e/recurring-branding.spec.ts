import type { Page } from "@playwright/test";
import { type Cause, Effect } from "effect";
import { signInRecurringThroughCore } from "./real-core-fixture";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;
const desktopWidth = 1506;
const mobileWidth = 390;
const viewportHeight = 900;
const checkPanelBoundary = (page: Page): Promise<void> =>
  page
    .locator('[data-recurring-slot="context-panel"]')
    .evaluate((panel) => {
      const header = document.querySelector('[data-recurring-slot="page-header"]');
      if (header === null) return false;
      return panel.getBoundingClientRect().top >= header.getBoundingClientRect().bottom;
    })
    .then((belowHeader) => {
      expect(belowHeader).toBe(true);
    });

const desktopEditor = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const create = page.getByRole("button", { name: "Nuevo recurrente", exact: true });
    yield* Effect.tryPromise(() => create.click());
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("dialog", { name: "Nuevo recurrente" })).toBeVisible()
    );
    yield* Effect.tryPromise(() => checkPanelBoundary(page));
    yield* Effect.tryPromise(() =>
      page.getByLabel("Nombre", { exact: true }).fill("Borrador no guardado")
    );
    yield* Effect.tryPromise(() => page.keyboard.press("Tab"));
    yield* Effect.tryPromise(() => page.keyboard.press("Shift+Tab"));
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Nombre", { exact: true })).toBeFocused()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Nombre", { exact: true })).not.toHaveCSS("box-shadow", "none")
    );
    yield* Effect.tryPromise(() => page.getByRole("button", { name: /Activar tema/u }).click());
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Nombre", { exact: true })).toHaveValue("Borrador no guardado")
    );
    yield* Effect.tryPromise(() => page.getByRole("button", { name: /Activar tema/u }).click());
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Cancelar", exact: true }).click()
    );
    yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toHaveCount(0));
    yield* Effect.tryPromise(() => expect(create).toBeFocused());
    yield* Effect.tryPromise(() => create.click());
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Nombre", { exact: true })).toHaveValue("")
    );
    yield* Effect.tryPromise(() => page.keyboard.press("Escape"));
    yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toHaveCount(0));
  });

test("recurring editor stays below the global header and closes without saving in both themes and mobile", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        page.setViewportSize({ width: desktopWidth, height: viewportHeight })
      );
      yield* Effect.tryPromise(() =>
        signInRecurringThroughCore({ page, request, identity: "recurring" })
      );
      yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-10"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("heading", { name: /^octubre de 2026$/iu })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Hoy", exact: true })).toHaveCount(0)
      );
      yield* desktopEditor(page);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Activar tema oscuro", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(page.locator("html")).toHaveClass(/dark/u));
      yield* desktopEditor(page);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Nuevo recurrente", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByLabel("Nombre", { exact: true }).fill("Borrador adaptable")
      );
      yield* Effect.tryPromise(() =>
        page.setViewportSize({ width: mobileWidth, height: viewportHeight })
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Nombre", { exact: true })).toHaveValue("Borrador adaptable")
      );
      const panel = page.getByRole("dialog", { name: "Nuevo recurrente" });
      yield* Effect.tryPromise(() => expect(panel).toHaveCSS("width", `${mobileWidth}px`));
      yield* Effect.tryPromise(() =>
        panel.getByRole("button", { name: "Activar tema claro", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(page.locator("html")).not.toHaveClass(/dark/u));
      yield* Effect.tryPromise(() =>
        panel.getByRole("button", { name: "Cerrar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(panel).toBeHidden());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Nuevo recurrente", exact: true })).toBeFocused()
      );
    })
  ));
