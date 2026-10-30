import { expectSameLoadingFrame, measureLoadingFrame } from "./loading-geometry";
import type { Page } from "@playwright/test";
import { DateTime, Effect, Schema } from "effect";
import { playwright } from "./playwright-runtime";
import { type ConsentState, installOAuthReview, reviewReference } from "./oauth-visual-fixture";

const { test, expect } = playwright;
const { AxeBuilder } = await import("@axe-core/playwright");
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];
const themes = ["light", "dark"] as const;
const destinations = [
  {
    name: "connection",
    path: `/oauth/review/${reviewReference}`,
    title: "Conectar con Fidy",
    action: "Conectar",
  },
];
const captureDirectory = "test-results/oauth-visual";
test.use({ storageState: { cookies: [], origins: [] }, deviceScaleFactor: 1 });
test.afterEach(({ page }, information) =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (information.status === information.expectedStatus) return;
      const filename = information.title.replaceAll(/[^a-z0-9-]+/giu, "-");
      yield* Effect.tryPromise((signal) =>
        page.screenshot({
          signal,
          path: `${captureDirectory}/failed-${filename}.png`,
          fullPage: false,
          animations: "disabled",
          caret: "hide",
          scale: "css",
        })
      );
    })
  )
);

const waitForFonts = (): Promise<void> => document.fonts.ready.then(() => undefined);
const scrollToTop = (): void => window.scrollTo(0, 0);
const dimensions = (): Readonly<{ content: number; viewport: number }> => ({
  content: document.documentElement.scrollWidth,
  viewport: document.documentElement.clientWidth,
});
const capture = Effect.fnUntraced(function* (page: Page, filename: string) {
  yield* Effect.tryPromise(() => page.evaluate(waitForFonts));
  yield* Effect.tryPromise((signal) =>
    page.screenshot({
      signal,
      path: `${captureDirectory}/${filename}.png`,
      fullPage: false,
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
const prepare = Effect.fnUntraced(function* (
  page: Page,
  viewport: (typeof viewports)[number],
  theme: (typeof themes)[number]
) {
  yield* Effect.tryPromise(() => page.setViewportSize(viewport));
  yield* Effect.tryPromise(() => page.emulateMedia({ colorScheme: theme }));
  yield* Effect.tryPromise(() =>
    page.clock.setFixedTime(DateTime.toDateUtc(DateTime.makeUnsafe("2026-10-27T13:00:00Z")))
  );
});

const captureMobile = Effect.fnUntraced(function* (
  page: Page,
  destination: (typeof destinations)[number],
  theme: (typeof themes)[number]
) {
  yield* Effect.tryPromise((signal) =>
    page
      .getByRole("button", { name: destination.action, exact: true })
      .scrollIntoViewIfNeeded({ signal })
  );
  yield* capture(page, `${destination.name}-${theme}-mobile-actions`);
  yield* Effect.tryPromise(() => page.evaluate(scrollToTop));
  yield* Effect.tryPromise((signal) =>
    page.getByRole("button", { name: "Menú de navegación" }).click({ signal })
  );
  yield* Effect.tryPromise((signal) =>
    expect(
      page
        .getByRole("navigation", { name: "Aplicación" })
        .getByRole("link", { name: "Tablero", exact: true })
    ).toBeVisible({ signal })
  );
  yield* capture(page, `${destination.name}-${theme}-mobile-menu`);
});

for (const viewport of viewports) {
  for (const theme of themes) {
    for (const destination of destinations) {
      test(`OAuth ${destination.name} retains the application navigation and readable exact review in ${theme} ${viewport.name}`, ({
        page,
      }) =>
        Effect.runPromise(
          Effect.gen(function* () {
            yield* prepare(page, viewport, theme);
            const observed = yield* installOAuthReview(page);
            yield* Effect.tryPromise((signal) => page.goto(destination.path, { signal }));
            yield* Effect.tryPromise((signal) =>
              expect(
                page.getByRole("heading", { name: destination.title, exact: true })
              ).toBeVisible({ signal })
            );
            yield* Effect.tryPromise((signal) =>
              expect(
                page.getByRole("button", { name: destination.action, exact: true })
              ).toBeEnabled({ signal })
            );
            yield* Effect.tryPromise((signal) =>
              expect(
                page.getByText("Nombre declarado por el cliente; Fidy no verifica su identidad.", {
                  exact: true,
                })
              ).toBeVisible({ signal })
            );
            yield* Effect.tryPromise((signal) =>
              expect(
                page.getByRole("button", { name: "Abrir agente Fidy", exact: true })
              ).toBeVisible({ signal })
            );
            yield* Effect.tryPromise((signal) =>
              expect(page.getByRole("main").locator("time").first()).toHaveText(
                "25 ene 2027 · 8:00 a. m.",
                { signal }
              )
            );
            if (viewport.name === "desktop") {
              yield* Effect.tryPromise((signal) =>
                expect(
                  page
                    .getByRole("navigation", { name: "Aplicación" })
                    .getByRole("link", { name: "Tablero", exact: true })
                ).toBeVisible({ signal })
              );
            }
            yield* capture(page, `${destination.name}-${theme}-${viewport.name}`);
            if (viewport.name === "mobile") yield* captureMobile(page, destination, theme);
            expect(observed.unexpected).toEqual([]);
            expect(observed.mutations).toEqual([]);
          })
        ));
    }
  }
}

for (const viewport of viewports) {
  for (const theme of themes) {
    for (const destination of destinations) {
      test(`OAuth ${destination.name} keeps unavailable login continuity inside the shell in ${theme} ${viewport.name}`, ({
        page,
      }) =>
        Effect.runPromise(
          Effect.gen(function* () {
            yield* prepare(page, viewport, theme);
            const observed = yield* installOAuthReview(page, {
              review: "unavailable",
              consent: "signed-out",
              mutation: "success",
            });
            yield* Effect.tryPromise((signal) => page.goto(destination.path, { signal }));
            const login = page
              .getByRole("main")
              .getByRole("link", { name: "Iniciar sesión", exact: true });
            yield* Effect.tryPromise((signal) => expect(login).toBeVisible({ signal }));
            const parameter = "oauthRequest";
            const reference = reviewReference;
            yield* Effect.tryPromise((signal) =>
              expect(login).toHaveAttribute("href", `/login?${parameter}=${reference}`, { signal })
            );
            yield* Effect.tryPromise((signal) =>
              expect(
                page.getByRole("button", { name: destination.action, exact: true })
              ).toHaveCount(0, { signal })
            );
            yield* capture(page, `${destination.name}-unavailable-${theme}-${viewport.name}`);
            expect(observed.unexpected).toEqual([]);
            expect(observed.mutations).toEqual([]);
          })
        ));
    }
  }
}

const unavailableConsent: ReadonlyArray<ConsentState> = [
  "loading",
  "unavailable",
  "revoked",
  "signed-out",
];
for (const consent of unavailableConsent) {
  test(`OAuth review does not infer hosted or product authority while Consent is ${consent}`, ({
    page,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const observed = yield* installOAuthReview(page, {
          review: "ready",
          consent,
          mutation: "success",
        });
        yield* Effect.tryPromise((signal) =>
          page.goto(`/oauth/review/${reviewReference}`, { signal })
        );
        yield* Effect.tryPromise((signal) =>
          expect(page.getByRole("button", { name: "Conectar", exact: true })).toBeEnabled({
            signal,
          })
        );
        yield* Effect.tryPromise((signal) =>
          expect(page.getByRole("button", { name: "Abrir agente Fidy", exact: true })).toHaveCount(
            0,
            { signal }
          )
        );
        expect(observed.unexpected).toEqual([]);
        expect(observed.mutations).toEqual([]);
        observed.release();
      })
    ));
}

for (const destination of destinations) {
  test(`OAuth ${destination.name} loading neither leaks product reads nor exposes an approval`, ({
    page,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const observed = yield* installOAuthReview(page, {
          review: "loading",
          consent: "signed-out",
          mutation: "success",
        });
        yield* Effect.tryPromise((signal) => page.goto(destination.path, { signal }));
        yield* Effect.tryPromise((signal) =>
          expect(page.getByRole("status")).toContainText("Cargando", { signal })
        );
        yield* Effect.tryPromise((signal) =>
          expect(page.getByRole("button", { name: destination.action, exact: true })).toHaveCount(
            0,
            { signal }
          )
        );
        yield* capture(page, `${destination.name}-loading`);
        const frameParts = [
          "settings-columns",
          "settings-main",
          "settings-panel",
          "oauth-client",
        ].map((name) => ({ name, selector: `.${name}` }));
        const loadingFrame = yield* Effect.tryPromise(() => measureLoadingFrame(page, frameParts));
        observed.release();
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("button", { name: destination.action, exact: true })).toBeVisible()
        );
        const loadedFrame = yield* Effect.tryPromise(() => measureLoadingFrame(page, frameParts));
        expectSameLoadingFrame(loadingFrame, loadedFrame);
        expect(observed.unexpected).toEqual([]);
        expect(observed.mutations).toEqual([]);
      })
    ));
}

test("OAuth keyboard review submits only the selected permissions and duration, then locks an unknown outcome", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const observed = yield* installOAuthReview(page);
      yield* Effect.tryPromise((signal) =>
        page.goto(`/oauth/review/${reviewReference}`, { signal })
      );
      const choices = page.getByRole("checkbox");
      yield* Effect.tryPromise((signal) => expect(choices).toHaveCount(3, { signal }));
      for (const choice of yield* Effect.tryPromise(() => choices.all())) {
        yield* Effect.tryPromise((signal) => choice.press("Space", { signal }));
      }
      const connect = page.getByRole("button", { name: "Conectar", exact: true });
      yield* Effect.tryPromise((signal) => expect(connect).toBeDisabled({ signal }));
      yield* Effect.tryPromise((signal) =>
        page.getByRole("checkbox", { name: /Consultar tus datos/u }).press("Space", { signal })
      );
      yield* Effect.tryPromise((signal) =>
        page.getByRole("button", { name: "30 días", exact: true }).press("Enter", { signal })
      );
      yield* Effect.tryPromise((signal) => connect.press("Enter", { signal }));
      yield* Effect.tryPromise((signal) =>
        expect(page.getByRole("alert")).toContainText("No pudimos confirmar el resultado", {
          signal,
        })
      );
      yield* Effect.tryPromise((signal) =>
        expect(page.getByRole("button", { name: /Conectar|Conectando/u })).toHaveCount(0, {
          signal,
        })
      );
      yield* Effect.tryPromise((signal) =>
        expect(page.getByRole("button", { name: "Cancelar", exact: true })).toHaveCount(0, {
          signal,
        })
      );
      expect(observed.mutations).toHaveLength(1);
      const submitted = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({ scopes: Schema.Array(Schema.String), lifetimeDays: Schema.Finite })
        )
      )(observed.mutations[0]?.body);
      expect(submitted).toEqual({ scopes: ["read"], lifetimeDays: 30 });
      yield* capture(page, "connection-unknown");
      expect(observed.unexpected).toEqual([]);
    })
  ));

test("OAuth connection cancellation cannot be repeated after its acknowledgement", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const observed = yield* installOAuthReview(page);
      yield* Effect.tryPromise((signal) =>
        page.goto(`/oauth/review/${reviewReference}`, { signal })
      );
      yield* Effect.tryPromise((signal) =>
        page.getByRole("button", { name: "Cancelar", exact: true }).click({ signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(page.getByRole("status")).toContainText("No se autorizó ningún acceso", { signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(page.getByRole("button", { name: "Conectar", exact: true })).toHaveCount(0, {
          signal,
        })
      );
      yield* capture(page, "connection-cancelled");
      expect(observed.mutations).toHaveLength(1);
      expect(observed.unexpected).toEqual([]);
    })
  ));

const terminalStates = [
  {
    name: "connection-cancelled",
    path: `/oauth/review/${reviewReference}`,
    button: "Cancelar",
    mutation: "success",
    message: "No se autorizó ningún acceso",
  },
  {
    name: "connection-unknown",
    path: `/oauth/review/${reviewReference}`,
    button: "Conectar",
    mutation: "unknown",
    message: "No pudimos confirmar el resultado",
  },
] as const;
for (const viewport of viewports) {
  for (const theme of themes) {
    test(`OAuth terminal outcomes remain truthful and readable in ${theme} ${viewport.name}`, ({
      page,
    }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* prepare(page, viewport, theme);
          for (const state of terminalStates) {
            const observed = yield* installOAuthReview(page, {
              review: "ready",
              consent: "granted",
              mutation: state.mutation,
            });
            yield* Effect.tryPromise((signal) => page.goto(state.path, { signal }));
            yield* Effect.tryPromise((signal) =>
              page.getByRole("button", { name: state.button, exact: true }).click({ signal })
            );
            const result = page.getByRole(state.mutation === "unknown" ? "alert" : "status");
            yield* Effect.tryPromise((signal) =>
              expect(result).toContainText(state.message, { signal })
            );
            if (viewport.name === "mobile") {
              yield* Effect.tryPromise((signal) =>
                expect(page.getByRole("button", { name: "Menú de navegación" })).toBeInViewport({
                  signal,
                })
              );
            }
            yield* capture(page, `${state.name}-${theme}-${viewport.name}`);
            expect(observed.unexpected).toEqual([]);
            expect(observed.mutations).toHaveLength(1);
          }
        })
      ));
  }
}

for (const viewport of viewports) {
  test(`OAuth cancellation failure retains a readable review and explicit retry in ${viewport.name}`, ({
    page,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* prepare(page, viewport, "light");
        const failed = yield* installOAuthReview(page, {
          review: "ready",
          consent: "granted",
          mutation: "unknown",
        });
        yield* Effect.tryPromise((signal) =>
          page.goto(`/oauth/review/${reviewReference}`, { signal })
        );
        const cancel = page.getByRole("button", { name: "Cancelar", exact: true });
        yield* Effect.tryPromise((signal) => cancel.click({ signal }));
        yield* Effect.tryPromise((signal) =>
          expect(page.getByRole("alert")).toContainText("No pudimos cancelar", { signal })
        );
        yield* Effect.tryPromise((signal) => expect(cancel).toBeEnabled({ signal }));
        yield* Effect.tryPromise((signal) =>
          expect(page.getByRole("heading", { name: "Agente de ejemplo", exact: true })).toBeVisible(
            { signal }
          )
        );
        if (viewport.name === "desktop") {
          yield* Effect.tryPromise((signal) =>
            expect(
              page.getByRole("heading", { name: "Agente de ejemplo", exact: true })
            ).toBeInViewport({ signal })
          );
        }
        yield* Effect.tryPromise(() => page.evaluate(scrollToTop));
        yield* capture(page, `connection-cancel-failed-light-${viewport.name}`);
        const retried = yield* installOAuthReview(page);
        yield* Effect.tryPromise((signal) => cancel.click({ signal }));
        yield* Effect.tryPromise((signal) =>
          expect(page.getByRole("status")).toContainText("No se autorizó ningún acceso", { signal })
        );
        expect(failed.mutations).toHaveLength(1);
        expect(retried.mutations).toHaveLength(1);
        expect(failed.unexpected).toEqual([]);
        expect(retried.unexpected).toEqual([]);
        yield* Effect.tryPromise((signal) => expect(cancel).toHaveCount(0, { signal }));
      })
    ));
}
