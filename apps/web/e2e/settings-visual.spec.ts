import type { Locator, Page } from "@playwright/test";
import { DateTime, Effect, Schema } from "effect";
import { playwright } from "./playwright-runtime";
import { installSettingsReads } from "./settings-visual-fixture";

const { test, expect } = playwright;
const { AxeBuilder } = await import("@axe-core/playwright");
const desktop = { name: "desktop", width: 1467, height: 1072 };
const mobile = { name: "mobile", width: 390, height: 844 };
const viewports = [desktop, mobile];
const themes = ["light", "dark"] as const;
const destinations = [
  { path: "/settings/account", title: "Cuenta", filename: "cuenta" },
  { path: "/settings/privacy", title: "Privacidad", filename: "privacidad" },
  { path: "/settings/access", title: "Accesos", filename: "accesos" },
] as const;
type Destination = (typeof destinations)[number];
const captureViewports = [
  { viewport: desktop, destinations },
  { viewport: mobile, destinations },
  {
    viewport: { name: "landscape", width: 667, height: 390 },
    destinations: [destinations[2]],
  },
];
const captureDirectory = "test-results/settings-visual";

test.use({
  storageState: { cookies: [], origins: [] },
  deviceScaleFactor: 1,
});

test.afterEach(({ page }, information) =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (information.status === information.expectedStatus) return;
      const filename = information.title.replaceAll(/[^a-z0-9-]+/giu, "-");
      yield* Effect.tryPromise(() =>
        page.screenshot({
          path: `${captureDirectory}/failed-${filename}.png`,
          fullPage: true,
          animations: "disabled",
          caret: "hide",
          scale: "css",
        })
      );
    })
  )
);

const dimensions = (): Readonly<{ content: number; viewport: number }> => ({
  content: document.documentElement.scrollWidth,
  viewport: document.documentElement.clientWidth,
});

const prepareAccessForm = Effect.fnUntraced(function* (page: Page) {
  yield* Effect.tryPromise(() =>
    page.getByLabel("Nombre", { exact: true }).fill("Mi agente personal")
  );
  yield* Effect.tryPromise(() => page.getByRole("checkbox", { name: /^Lectura:/u }).check());
  yield* Effect.tryPromise(() => page.getByRole("button", { name: "Duración del token" }).click());
  yield* Effect.tryPromise(() =>
    page.getByRole("menuitemradio", { name: "30 días", exact: true }).click()
  );
});

const expectDestination = Effect.fnUntraced(function* (
  page: Page,
  destination: Destination,
  compact: boolean
) {
  yield* Effect.tryPromise(() =>
    expect(
      page.getByRole("heading", { name: destination.title, level: 1, exact: true })
    ).toBeVisible()
  );
  if (destination.title === "Cuenta") {
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Nuevo correo", { exact: true })).toBeVisible()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Crear un código nuevo", exact: true })).toBeVisible()
    );
  }
  if (destination.title === "Privacidad") {
    yield* Effect.tryPromise(() =>
      expect(
        page.getByRole("complementary", { name: "Solicitudes sobre tus datos", exact: true })
      ).toBeVisible()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Retirar autorización", exact: true })).toBeDisabled()
    );
    yield* Effect.tryPromise(() =>
      expect(
        page.getByRole("button", { name: "Solicitar eliminación", exact: true })
      ).toBeDisabled()
    );
  }
  if (destination.title === "Accesos") {
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("region", { name: "Crear token", exact: true })).toBeVisible()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole(compact ? "list" : "table", { name: "Tokens activos" })).toContainText(
        "Automatización"
      )
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole(compact ? "list" : "table", { name: "Conexiones MCP" })).toContainText(
        "Asistente de análisis"
      )
    );
  }
});

const waitForFonts = (): Promise<void> => document.fonts.ready.then(() => undefined);

const capturePage = Effect.fnUntraced(function* (page: Page, filename: string) {
  yield* Effect.tryPromise(() => page.evaluate(waitForFonts));
  yield* Effect.tryPromise(() =>
    page.screenshot({
      path: `${captureDirectory}/${filename}.png`,
      fullPage: true,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    })
  );
  const result = yield* Effect.tryPromise(() => new AxeBuilder({ page }).analyze());
  const report = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result);
  yield* Effect.tryPromise(() => Bun.write(`${captureDirectory}/${filename}.axe.json`, report));
  expect(result.violations).toEqual([]);
  const measured = yield* Effect.tryPromise(() => page.evaluate(dimensions));
  expect(measured.content).toBeLessThanOrEqual(measured.viewport);
});

const expectAlignedHeader = Effect.fnUntraced(function* (
  page: Page,
  title: string,
  controlName: string | RegExp
) {
  const heading = yield* Effect.tryPromise(() =>
    page.getByRole("heading", { name: title, level: 1, exact: true }).boundingBox()
  );
  const control = yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: controlName, exact: true }).boundingBox()
  );
  expect(heading).not.toBeNull();
  expect(control).not.toBeNull();
  if (heading === null || control === null) return;
  const alignmentTolerance = 16;
  expect(Math.abs(heading.y + heading.height / 2 - control.y - control.height / 2)).toBeLessThan(
    alignmentTolerance
  );
});

const expectHorizontalFit = Effect.fnUntraced(function* (elements: Locator, width: number) {
  const matches = yield* Effect.tryPromise(() => elements.all());
  expect(matches.length).toBeGreaterThan(0);
  for (const element of matches) {
    const bounds = yield* Effect.tryPromise(() => element.boundingBox());
    expect(bounds).not.toBeNull();
    if (bounds === null) continue;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  }
});

const expectCompactAccess = Effect.fnUntraced(function* (page: Page, width: number) {
  const tokenActions = page.getByRole("button", { name: "Desactivar", exact: true });
  const agentAction = page.getByRole("button", { name: "Revocar este agente", exact: true });
  yield* Effect.tryPromise(() => expect(tokenActions).toHaveCount(2));
  yield* Effect.tryPromise(() => expect(agentAction).toHaveCount(1));
  yield* expectHorizontalFit(tokenActions, width);
  yield* expectHorizontalFit(agentAction, width);
  for (const name of ["Tokens activos", "Conexiones MCP"]) {
    const list = page.getByRole("list", { name, exact: true });
    yield* Effect.tryPromise(() =>
      expect(list.getByRole("term").filter({ hasText: /^Vence$/u })).toHaveCount(
        name === "Tokens activos" ? 2 : 1
      )
    );
    yield* expectHorizontalFit(list.getByRole("heading"), width);
    yield* expectHorizontalFit(list.getByRole("definition"), width);
    yield* expectHorizontalFit(list.locator("time"), width);
  }
  yield* Effect.tryPromise(() => tokenActions.first().click());
  const confirmation = page.getByRole("button", { name: "Sí, desactivar", exact: true });
  yield* Effect.tryPromise(() => expect(confirmation).toBeVisible());
  yield* expectHorizontalFit(confirmation, width);
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Cancelar", exact: true }).click()
  );
  yield* Effect.tryPromise(() => expect(tokenActions).toHaveCount(2));
});

for (const { viewport, destinations: targets } of captureViewports) {
  const compact = viewport.name !== "desktop";
  for (const theme of themes) {
    for (const destination of targets) {
      test(`${destination.title} remains accessible without overflow in ${theme} ${viewport.name}`, ({
        page,
      }) =>
        Effect.runPromise(
          Effect.gen(function* () {
            yield* Effect.tryPromise(() => page.setViewportSize(viewport));
            yield* Effect.tryPromise(() => page.emulateMedia({ colorScheme: theme }));
            yield* Effect.tryPromise(() =>
              page.clock.setFixedTime(
                DateTime.toDateUtc(DateTime.makeUnsafe("2026-10-25T14:00:00Z"))
              )
            );
            const observed = yield* installSettingsReads(page);
            yield* Effect.tryPromise(() => page.goto(destination.path));
            yield* expectDestination(page, destination, compact);
            yield* Effect.tryPromise(() =>
              expect(
                page.getByRole("button", {
                  name: theme === "dark" ? "Activar tema claro" : "Activar tema oscuro",
                })
              ).toBeVisible()
            );
            if (destination.title === "Accesos") yield* prepareAccessForm(page);
            if (viewport.name === "desktop") {
              yield* expectAlignedHeader(page, destination.title, /Activar tema (claro|oscuro)/u);
            } else if (destination.title !== "Cuenta") {
              yield* expectAlignedHeader(
                page,
                destination.title,
                destination.title === "Privacidad" ? "Verificar autorización" : "Actualizar tokens"
              );
            }
            if (compact && destination.title === "Accesos") {
              yield* expectCompactAccess(page, viewport.width);
            }
            yield* capturePage(page, `${destination.filename}-${theme}-${viewport.name}`);
            expect(observed.mutations).toEqual([]);
            expect(observed.missingReads).toEqual([]);
          })
        ));
    }
  }
}

const followSettingsLink = Effect.fnUntraced(function* (
  page: Page,
  title: Destination["title"],
  compact: boolean
) {
  if (compact) {
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Menú de navegación" }).click()
    );
  }
  const link = page.getByRole("link", { name: title, exact: true });
  yield* Effect.tryPromise(() => link.focus());
  yield* Effect.tryPromise(() => expect(link).toBeFocused());
  yield* Effect.tryPromise(() => link.press("Enter"));
  if (compact) {
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("navigation", { name: "Aplicación" })).toBeHidden()
    );
  }
});

for (const viewport of viewports) {
  test(`Settings keyboard navigation and browser history discard unsubmitted security drafts on ${viewport.name}`, ({
    page,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() => page.setViewportSize(viewport));
        const observed = yield* installSettingsReads(page);
        yield* Effect.tryPromise(() => page.goto("/settings/account"));
        yield* Effect.tryPromise(() =>
          page.getByLabel("Nuevo correo", { exact: true }).fill("prueba@example.com")
        );
        yield* followSettingsLink(page, "Privacidad", viewport.name === "mobile");
        const withdrawal = page.getByRole("checkbox", { name: /Entiendo las consecuencias/u });
        yield* Effect.tryPromise(() => withdrawal.check());
        yield* Effect.tryPromise(() =>
          expect(
            page.getByRole("button", { name: "Retirar autorización", exact: true })
          ).toBeEnabled()
        );
        yield* followSettingsLink(page, "Accesos", viewport.name === "mobile");
        yield* prepareAccessForm(page);
        yield* Effect.tryPromise(() =>
          page.getByRole("button", { name: "Crear token", exact: true }).click()
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("region", { name: "Revisión del token" })).toBeVisible()
        );
        yield* Effect.tryPromise(() => page.goBack());
        yield* Effect.tryPromise(() => expect(withdrawal).not.toBeChecked());
        yield* Effect.tryPromise(() => page.goBack());
        yield* Effect.tryPromise(() =>
          expect(page.getByLabel("Nuevo correo", { exact: true })).toHaveValue("")
        );
        yield* Effect.tryPromise(() => page.goForward());
        yield* Effect.tryPromise(() => expect(withdrawal).not.toBeChecked());
        yield* Effect.tryPromise(() => page.goForward());
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("region", { name: "Revisión del token" })).toHaveCount(0)
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByLabel("Nombre", { exact: true })).toHaveValue("")
        );
        expect(observed.mutations).toEqual([]);
        expect(observed.missingReads).toEqual([]);
      })
    ));
}
