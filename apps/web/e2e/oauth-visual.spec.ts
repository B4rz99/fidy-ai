import type { Page } from "@playwright/test";
import { DateTime, Effect, Schema } from "effect";
import { playwright } from "./playwright-runtime";
import {
  type ConsentState,
  installOAuthReview,
  operationInput,
  operationReference,
  reviewReference,
} from "./oauth-visual-fixture";

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
  {
    name: "operation",
    path: `/oauth/operation/${operationReference}`,
    title: "Revisar operación",
    action: "Aprobar operación",
  },
];
const captureDirectory = "test-results/oauth-visual";
test.use({ storageState: { cookies: [], origins: [] }, deviceScaleFactor: 1 });
test.afterEach(({ page }, information) =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (information.status === information.expectedStatus) return;
      const filename = information.title.replaceAll(/[^a-z0-9-]+/giu, "-");
      yield* Effect.tryPromise(() =>
        page.screenshot({
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

const expectOneMutation = (mutations: ReadonlyArray<unknown>): Promise<void> =>
  expect.poll(() => mutations.length).toBe(1);
const waitForFonts = (): Promise<void> => document.fonts.ready.then(() => undefined);
const scrollToTop = (): void => window.scrollTo(0, 0);
const dimensions = (): Readonly<{ content: number; viewport: number }> => ({
  content: document.documentElement.scrollWidth,
  viewport: document.documentElement.clientWidth,
});
const capture = Effect.fnUntraced(function* (page: Page, filename: string) {
  yield* Effect.tryPromise(() => page.evaluate(waitForFonts));
  yield* Effect.tryPromise(() =>
    page.screenshot({
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
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: destination.action, exact: true }).scrollIntoViewIfNeeded()
  );
  yield* capture(page, `${destination.name}-${theme}-mobile-actions`);
  yield* Effect.tryPromise(() => page.evaluate(scrollToTop));
  yield* Effect.tryPromise(() => page.getByRole("button", { name: "Menú de navegación" }).click());
  yield* Effect.tryPromise(() =>
    expect(
      page
        .getByRole("navigation", { name: "Aplicación" })
        .getByRole("link", { name: "Tablero", exact: true })
    ).toBeVisible()
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
            yield* Effect.tryPromise(() => page.goto(destination.path));
            yield* Effect.tryPromise(() =>
              expect(
                page.getByRole("heading", { name: destination.title, exact: true })
              ).toBeVisible()
            );
            yield* Effect.tryPromise(() =>
              expect(
                page.getByRole("button", { name: destination.action, exact: true })
              ).toBeEnabled()
            );
            yield* Effect.tryPromise(() =>
              expect(
                page.getByText("Nombre declarado por el cliente; Fidy no verifica su identidad.", {
                  exact: true,
                })
              ).toBeVisible()
            );
            yield* Effect.tryPromise(() =>
              expect(
                page.getByRole("button", { name: "Abrir agente Fidy", exact: true })
              ).toBeVisible()
            );
            if (destination.name === "operation") {
              yield* Effect.tryPromise(() =>
                expect(page.getByRole("main").locator("pre")).toHaveText(operationInput)
              );
            }
            if (viewport.name === "desktop") {
              yield* Effect.tryPromise(() =>
                expect(
                  page
                    .getByRole("navigation", { name: "Aplicación" })
                    .getByRole("link", { name: "Tablero", exact: true })
                ).toBeVisible()
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
            yield* Effect.tryPromise(() => page.goto(destination.path));
            const login = page
              .getByRole("main")
              .getByRole("link", { name: "Iniciar sesión", exact: true });
            yield* Effect.tryPromise(() => expect(login).toBeVisible());
            const parameter = destination.name === "connection" ? "oauthRequest" : "oauthOperation";
            const reference =
              destination.name === "connection" ? reviewReference : operationReference;
            yield* Effect.tryPromise(() =>
              expect(login).toHaveAttribute("href", `/login?${parameter}=${reference}`)
            );
            yield* Effect.tryPromise(() =>
              expect(
                page.getByRole("button", { name: destination.action, exact: true })
              ).toHaveCount(0)
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
        yield* Effect.tryPromise(() => page.goto(`/oauth/review/${reviewReference}`));
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("button", { name: "Conectar", exact: true })).toBeEnabled()
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("button", { name: "Abrir agente Fidy", exact: true })).toHaveCount(
            0
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
        yield* Effect.tryPromise(() => page.goto(destination.path));
        yield* Effect.tryPromise(() => expect(page.getByRole("status")).toContainText("Cargando"));
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("button", { name: destination.action, exact: true })).toHaveCount(0)
        );
        yield* capture(page, `${destination.name}-loading`);
        expect(observed.unexpected).toEqual([]);
        expect(observed.mutations).toEqual([]);
        observed.release();
      })
    ));
}

test("OAuth connection submits only the selected permissions and duration, then locks an unknown outcome", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const observed = yield* installOAuthReview(page);
      yield* Effect.tryPromise(() => page.goto(`/oauth/review/${reviewReference}`));
      const choices = page.getByRole("checkbox");
      yield* Effect.tryPromise(() => expect(choices).toHaveCount(3));
      for (const choice of yield* Effect.tryPromise(() => choices.all())) {
        yield* Effect.tryPromise(() => choice.uncheck());
      }
      const connect = page.getByRole("button", { name: "Conectar", exact: true });
      yield* Effect.tryPromise(() => expect(connect).toBeDisabled());
      yield* Effect.tryPromise(() =>
        page.getByRole("checkbox", { name: /Consultar tus datos/u }).check()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "30 días", exact: true }).click()
      );
      yield* Effect.tryPromise(() => connect.click());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toContainText("No pudimos confirmar el resultado")
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: /Conectar|Conectando/u })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Cancelar", exact: true })).toHaveCount(0)
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

for (const decision of ["approve", "cancel"] as const) {
  test(`OAuth operation ${decision} stays single-shot while pending and preserves its exact binding`, ({
    page,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const observed = yield* installOAuthReview(page, {
          review: "ready",
          consent: "granted",
          mutation: "pending",
        });
        yield* Effect.tryPromise(() => page.goto(`/oauth/operation/${operationReference}`));
        const approve = page.getByRole("button", { name: "Aprobar operación", exact: true });
        const cancel = page.getByRole("button", { name: "Cancelar operación", exact: true });
        yield* Effect.tryPromise(() => (decision === "approve" ? approve : cancel).click());
        yield* Effect.tryPromise(() => expect(approve).toBeDisabled());
        yield* Effect.tryPromise(() => expect(cancel).toBeDisabled());
        yield* Effect.tryPromise(() => expectOneMutation(observed.mutations));
        const submitted = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
          observed.mutations[0]?.body
        );
        expect(submitted).toEqual({
          reference: operationReference,
          inputDigest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          disclosureRevision: "budget-deletion-v1",
          decision,
        });
        observed.release();
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("status")).toContainText(
            decision === "approve"
              ? "La operación aún no se ha ejecutado"
              : "No se ejecutó ningún cambio"
          )
        );
        yield* Effect.tryPromise(() => expect(approve).toHaveCount(0));
        yield* capture(page, `operation-${decision}`);
        expect(observed.unexpected).toEqual([]);
      })
    ));
}

test("OAuth operation uncertain delivery removes both decisions without executing or retrying", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const observed = yield* installOAuthReview(page, {
        review: "ready",
        consent: "granted",
        mutation: "unknown",
      });
      yield* Effect.tryPromise(() => page.goto(`/oauth/operation/${operationReference}`));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Aprobar operación", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toContainText("No pudimos confirmar el resultado")
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("button", { name: /Aprobar operación|Cancelar operación/u })
        ).toHaveCount(0)
      );
      yield* capture(page, "operation-unknown");
      expect(observed.mutations).toHaveLength(1);
      expect(observed.unexpected).toEqual([]);
    })
  ));

test("OAuth connection cancellation cannot be repeated after its acknowledgement", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const observed = yield* installOAuthReview(page);
      yield* Effect.tryPromise(() => page.goto(`/oauth/review/${reviewReference}`));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Cancelar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("status")).toContainText("No se autorizó ningún acceso")
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Conectar", exact: true })).toHaveCount(0)
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
  {
    name: "operation-approved",
    path: `/oauth/operation/${operationReference}`,
    button: "Aprobar operación",
    mutation: "success",
    message: "La operación aún no se ha ejecutado",
  },
  {
    name: "operation-cancelled",
    path: `/oauth/operation/${operationReference}`,
    button: "Cancelar operación",
    mutation: "success",
    message: "No se ejecutó ningún cambio",
  },
  {
    name: "operation-unknown",
    path: `/oauth/operation/${operationReference}`,
    button: "Aprobar operación",
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
            yield* Effect.tryPromise(() => page.goto(state.path));
            yield* Effect.tryPromise(() =>
              page.getByRole("button", { name: state.button, exact: true }).click()
            );
            const result = page.getByRole(state.mutation === "unknown" ? "alert" : "status");
            yield* Effect.tryPromise(() => expect(result).toContainText(state.message));
            if (viewport.name === "mobile") {
              yield* Effect.tryPromise(() =>
                expect(page.getByRole("button", { name: "Menú de navegación" })).toBeInViewport()
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

const captureReference = Effect.fnUntraced(function* (page: Page, filename: string) {
  const reference = page.getByRole("region", { name: "Resultado por confirmar", exact: true });
  const result = yield* Effect.tryPromise(() =>
    new AxeBuilder({ page }).include("#oauth").analyze()
  );
  expect(result.violations).toEqual([]);
  yield* Effect.tryPromise(() => reference.scrollIntoViewIfNeeded());
  yield* Effect.tryPromise(() =>
    page.screenshot({
      path: `${captureDirectory}/${filename}.png`,
      fullPage: false,
      animations: "disabled",
    })
  );
});

for (const viewport of viewports) {
  for (const theme of themes) {
    test(`OAuth shared reference supports keyboard controls in ${theme} ${viewport.name}`, ({
      page,
    }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* prepare(page, viewport, theme);
          yield* Effect.tryPromise(() => page.goto("/ui-reference.html#oauth"));
          const reference = page.getByRole("region", {
            name: "Autorizaciones de ejemplo",
            exact: true,
          });
          const permission = reference.getByRole("checkbox");
          yield* Effect.tryPromise(() => permission.focus());
          yield* Effect.tryPromise(() => page.keyboard.press("Space"));
          yield* Effect.tryPromise(() => expect(permission).not.toBeChecked());
          yield* Effect.tryPromise(() => page.keyboard.press("Space"));
          yield* Effect.tryPromise(() => expect(permission).toBeChecked());
          const duration = reference.getByRole("button", { name: "30 días", exact: true });
          yield* Effect.tryPromise(() => duration.focus());
          yield* Effect.tryPromise(() => page.keyboard.press("Enter"));
          yield* Effect.tryPromise(() => expect(duration).toHaveAttribute("aria-pressed", "true"));
          yield* Effect.tryPromise(() =>
            reference.getByRole("button", { name: "Simular aprobación" }).click()
          );
          yield* Effect.tryPromise(() =>
            expect(reference.getByRole("status")).toContainText("No se ejecutó ninguna operación")
          );
          yield* Effect.tryPromise(() =>
            reference.getByRole("button", { name: "Reiniciar ejemplo" }).click()
          );
          yield* Effect.tryPromise(() =>
            reference.getByRole("button", { name: "Simular cancelación" }).click()
          );
          yield* Effect.tryPromise(() =>
            expect(reference.getByRole("status")).toContainText("no se ejecutó ningún cambio")
          );
          yield* Effect.tryPromise(() =>
            reference.getByRole("button", { name: "Reiniciar ejemplo" }).click()
          );
          yield* Effect.tryPromise(() =>
            reference.getByRole("button", { name: "Simular resultado incierto" }).click()
          );
          yield* Effect.tryPromise(() =>
            expect(reference.getByRole("region", { name: "Resultado por confirmar" })).toBeVisible()
          );
          yield* captureReference(page, `reference-${theme}-${viewport.name}`);
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
        yield* Effect.tryPromise(() => page.goto(`/oauth/review/${reviewReference}`));
        const cancel = page.getByRole("button", { name: "Cancelar", exact: true });
        yield* Effect.tryPromise(() => cancel.click());
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("alert")).toContainText("No pudimos cancelar")
        );
        yield* Effect.tryPromise(() => expect(cancel).toBeEnabled());
        yield* Effect.tryPromise(() =>
          expect(
            page.getByRole("heading", { name: "Agente de ejemplo", exact: true })
          ).toBeVisible()
        );
        if (viewport.name === "desktop") {
          yield* Effect.tryPromise(() =>
            expect(
              page.getByRole("heading", { name: "Agente de ejemplo", exact: true })
            ).toBeInViewport()
          );
        }
        yield* Effect.tryPromise(() => page.evaluate(scrollToTop));
        yield* capture(page, `connection-cancel-failed-light-${viewport.name}`);
        const retried = yield* installOAuthReview(page);
        yield* Effect.tryPromise(() => cancel.click());
        yield* Effect.tryPromise(() =>
          expect(page.getByRole("status")).toContainText("No se autorizó ningún acceso")
        );
        expect(failed.mutations).toHaveLength(1);
        expect(retried.mutations).toHaveLength(1);
        expect(failed.unexpected).toEqual([]);
        expect(retried.unexpected).toEqual([]);
        yield* Effect.tryPromise(() => expect(cancel).toHaveCount(0));
      })
    ));
}
