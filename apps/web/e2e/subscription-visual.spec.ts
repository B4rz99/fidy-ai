import { acceptSubscriptionContracts } from "./subscription-interactions";
import type { Page } from "@playwright/test";
import { DateTime, Effect, Schema } from "effect";
import { playwright } from "./playwright-runtime";
import { apiOrigin } from "./http-fixtures";
import {
  type SubscriptionFixtureState,
  installSubscriptionFixture,
} from "./subscription-visual-fixture";

const { test, expect } = playwright;
const { AxeBuilder } = await import("@axe-core/playwright");
const captureDirectory = "test-results/subscription-visual";
const desktop = { name: "desktop", width: 1467, height: 1072 };
const mobile = { name: "mobile", width: 390, height: 844 };
const themes = ["light", "dark"] as const;
type Theme = (typeof themes)[number];
type MethodLabel = "tarjeta" | "Nequi" | "DaviPlata";

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
          fullPage: true,
          animations: "disabled",
          caret: "hide",
          scale: "css",
        })
      );
    })
  )
);
const waitForFonts = (): Promise<void> => document.fonts.ready.then(() => undefined);
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
const expectSubscriptionShell = Effect.fnUntraced(function* (
  page: Page,
  display: Readonly<{ viewport: typeof desktop; theme: Theme }>
) {
  yield* Effect.tryPromise((signal) =>
    expect(page.getByRole("img", { name: "Fidy", exact: true })).toBeVisible({ signal })
  );
  yield* Effect.tryPromise((signal) =>
    expect(
      page.getByRole("button", {
        name: display.theme === "dark" ? "Activar tema claro" : "Activar tema oscuro",
        exact: true,
      })
    ).toBeVisible({ signal })
  );
  yield* Effect.tryPromise((signal) =>
    expect(page.getByRole("main")).toHaveCSS("color-scheme", display.theme, { signal })
  );
  const compact = display.viewport.name === "mobile";
  if (compact) {
    yield* Effect.tryPromise((signal) =>
      page.getByRole("button", { name: "Menú de navegación", exact: true }).click({ signal })
    );
  }
  const navigation = page.getByRole("navigation", { name: "Aplicación", exact: true });
  yield* Effect.tryPromise((signal) => expect(navigation).toBeVisible({ signal }));
  const current = navigation.getByRole("link", { name: "Suscripción", exact: true });
  yield* Effect.tryPromise((signal) =>
    expect(current).toHaveAttribute("aria-current", "page", { signal })
  );
  if (compact) {
    yield* Effect.tryPromise((signal) => current.click({ signal }));
    yield* Effect.tryPromise((signal) => expect(navigation).toBeHidden({ signal }));
  }
});
const openSubscription = Effect.fnUntraced(function* (
  page: Page,
  display: Readonly<{ viewport: typeof desktop; theme: Theme }>,
  state: SubscriptionFixtureState = "form"
) {
  yield* Effect.tryPromise(() => page.setViewportSize(display.viewport));
  yield* Effect.tryPromise(() => page.emulateMedia({ colorScheme: display.theme }));
  yield* Effect.tryPromise(() =>
    page.clock.setFixedTime(DateTime.toDateUtc(DateTime.makeUnsafe("2026-10-25T15:00:00Z")))
  );
  const observed = yield* installSubscriptionFixture(page, state);
  yield* Effect.tryPromise((signal) => page.goto("/upgrade", { signal }));
  yield* Effect.tryPromise((signal) =>
    expect(page.getByRole("heading", { name: "Suscripción y pagos", exact: true })).toBeVisible({
      signal,
    })
  );
  yield* expectSubscriptionShell(page, display);
  return observed;
});
const chooseMonthly = Effect.fnUntraced(function* (page: Page) {
  yield* Effect.tryPromise((signal) =>
    page.getByRole("button", { name: /^mensual\b/iu }).click({ signal })
  );
});
const continueWith = Effect.fnUntraced(function* (page: Page, method: MethodLabel) {
  if (method !== "tarjeta") {
    yield* Effect.tryPromise((signal) =>
      page.getByRole("button", { name: method, exact: true }).click({ signal })
    );
  }
  yield* Effect.tryPromise((signal) =>
    page.getByRole("button", { name: `Continuar con ${method}`, exact: true }).click({ signal })
  );
});

const fillBillingEmail = Effect.fnUntraced(function* (page: Page) {
  yield* Effect.tryPromise((signal) =>
    page.getByLabel("Correo de facturación", { exact: true }).fill("prueba@example.com", { signal })
  );
});
const expectSeparateConsents = Effect.fnUntraced(function* (page: Page) {
  yield* Effect.tryPromise((signal) =>
    expect(page.getByRole("checkbox", { name: /Acepto el reglamento/iu })).not.toBeChecked({
      signal,
    })
  );
  yield* Effect.tryPromise((signal) =>
    expect(page.getByRole("checkbox", { name: /Autorizo el tratamiento/iu })).not.toBeChecked({
      signal,
    })
  );
  yield* Effect.tryPromise((signal) =>
    expect(page.getByRole("link", { name: /reglamento/u })).toHaveAttribute(
      "href",
      "https://wompi.co/end-user-policy",
      { signal }
    )
  );
  yield* Effect.tryPromise((signal) =>
    expect(page.getByRole("link", { name: /tratamiento de datos personales/u })).toHaveAttribute(
      "href",
      "https://wompi.co/personal-data-authorization",
      { signal }
    )
  );
  yield* Effect.tryPromise((signal) =>
    expect(page.getByText(/Fidy conservará este correo/u)).toHaveCount(0, { signal })
  );
});

for (const viewport of [desktop, mobile]) {
  for (const theme of themes) {
    test(`Subscription selection and card review remain accessible in ${theme} ${viewport.name}`, ({
      page,
    }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const observed = yield* openSubscription(page, { viewport, theme });
          for (const period of [/^semanal\b/iu, /^mensual\b/iu, /^anual\b/iu]) {
            yield* Effect.tryPromise((signal) =>
              expect(page.getByRole("button", { name: period })).toHaveAttribute(
                "aria-pressed",
                "false",
                { signal }
              )
            );
          }
          yield* Effect.tryPromise((signal) =>
            expect(
              page.getByRole("button", { name: "Continuar con tarjeta", exact: true })
            ).toBeDisabled({ signal })
          );
          expect(observed.preparations).toEqual([]);
          yield* chooseMonthly(page);
          expect(observed.preparations).toEqual([]);
          yield* capture(page, `overview-${theme}-${viewport.name}`);
          yield* continueWith(page, "tarjeta");
          yield* Effect.tryPromise((signal) =>
            expect(page.getByLabel("Número de tarjeta", { exact: true })).toBeVisible({ signal })
          );
          yield* expectSeparateConsents(page);
          yield* Effect.tryPromise((signal) =>
            expect(page.getByRole("button", { name: "Activar Pro", exact: true })).toBeDisabled({
              signal,
            })
          );
          yield* capture(page, `card-${theme}-${viewport.name}`);
          expect(observed.preparations).toEqual(["card"]);
          expect(observed.submissions).toEqual([]);
          expect(observed.providerCalls).toEqual([]);
          expect(observed.unexpectedRequests).toEqual([]);
        })
      ));
  }
}

const beginDaviplata = Effect.fnUntraced(function* (page: Page) {
  yield* Effect.tryPromise((signal) =>
    page.getByLabel("Número de cédula", { exact: true }).fill("1122233", { signal })
  );
  yield* Effect.tryPromise((signal) =>
    page.getByLabel("Número de DaviPlata", { exact: true }).fill("3991111111", { signal })
  );
  yield* fillBillingEmail(page);
  yield* acceptSubscriptionContracts(page);
  yield* Effect.tryPromise((signal) =>
    page.getByRole("button", { name: "Autorizar con DaviPlata", exact: true }).click({ signal })
  );
  yield* Effect.tryPromise((signal) =>
    expect(page.getByLabel("Código de verificación", { exact: true })).toBeVisible({ signal })
  );
  yield* Effect.tryPromise((signal) =>
    expect(page.getByLabel("Número de cédula", { exact: true })).toHaveCount(0, { signal })
  );
});
for (const theme of themes) {
  test(`Nequi authorization shows only its active stage in ${theme}`, ({ page }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const observed = yield* openSubscription(page, { viewport: desktop, theme });
        yield* chooseMonthly(page);
        yield* continueWith(page, "Nequi");
        yield* expectSeparateConsents(page);
        yield* capture(page, `nequi-form-${theme}-desktop`);
        yield* Effect.tryPromise((signal) =>
          page.getByLabel("Número de Nequi", { exact: true }).fill("3991111111", { signal })
        );
        yield* fillBillingEmail(page);
        yield* acceptSubscriptionContracts(page);
        yield* Effect.tryPromise((signal) =>
          page.getByRole("button", { name: "Autorizar con Nequi", exact: true }).click({ signal })
        );
        yield* Effect.tryPromise((signal) =>
          expect(page.getByText(/Aprueba la suscripción en Nequi/u)).toBeVisible({ signal })
        );
        yield* Effect.tryPromise((signal) =>
          expect(page.getByLabel("Número de Nequi", { exact: true })).toHaveCount(0, { signal })
        );
        yield* capture(page, `nequi-waiting-${theme}-desktop`);
        expect(observed.submissions).toEqual([]);
        expect(observed.unexpectedRequests).toEqual([]);
      })
    ));
  test(`DaviPlata entry and one-time code are alternative accessible views in ${theme}`, ({
    page,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const observed = yield* openSubscription(page, { viewport: desktop, theme });
        yield* chooseMonthly(page);
        yield* continueWith(page, "DaviPlata");
        yield* expectSeparateConsents(page);
        yield* Effect.tryPromise((signal) =>
          expect(page.getByText(/Por ahora solo admitimos CC/u)).toHaveCount(0, { signal })
        );
        yield* capture(page, `daviplata-form-${theme}-desktop`);
        yield* beginDaviplata(page);
        yield* capture(page, `daviplata-otp-${theme}-desktop`);
        yield* Effect.tryPromise((signal) =>
          page.getByRole("button", { name: "Cancelar autorización", exact: true }).click({ signal })
        );
        yield* Effect.tryPromise((signal) =>
          expect(page.getByLabel("Código de verificación", { exact: true })).toHaveCount(0, {
            signal,
          })
        );
        expect(observed.submissions).toEqual([]);
        expect(observed.providerCalls).toEqual(["/v1/tokens/daviplata", "RESEND_OTP"]);
        expect(observed.unexpectedRequests).toEqual([]);
      })
    ));
}

const paymentStates = [
  { state: "pending", copy: "Estamos esperando la confirmación del pago." },
  { state: "approved", copy: "Tu pago fue realizado y tu suscripción está activa." },
  { state: "declined", copy: "Wompi rechazó el pago. Puedes intentarlo de nuevo." },
  { state: "source-verifying", copy: "Estamos verificando tu fuente de pago." },
] as const;
for (const { state, copy } of paymentStates) {
  test(`Subscription ${state} does not confuse source authorization with settled payment`, ({
    page,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const observed = yield* openSubscription(
          page,
          { viewport: desktop, theme: "light" },
          state
        );
        yield* chooseMonthly(page);
        yield* continueWith(page, "tarjeta");
        yield* fillBillingEmail(page);
        yield* acceptSubscriptionContracts(page);
        yield* Effect.tryPromise((signal) =>
          page.getByRole("button", { name: "Activar Pro", exact: true }).click({ signal })
        );
        yield* Effect.tryPromise((signal) =>
          expect(page.getByText(copy, { exact: false })).toBeVisible({ signal })
        );
        if (state !== "approved") {
          yield* Effect.tryPromise((signal) =>
            expect(
              page.getByText("Tu pago fue realizado y tu suscripción está activa.")
            ).toHaveCount(0, { signal })
          );
        }
        if (state === "declined") {
          yield* Effect.tryPromise((signal) =>
            expect(
              page.getByRole("button", { name: "Volver a intentar", exact: true })
            ).toBeEnabled({ signal })
          );
          yield* Effect.tryPromise((signal) =>
            expect(
              page.getByRole("button", { name: "Usar otra tarjeta", exact: true })
            ).toBeEnabled({ signal })
          );
        } else {
          yield* Effect.tryPromise((signal) =>
            expect(
              page.getByRole("button", { name: "Volver a intentar", exact: true })
            ).toHaveCount(0, { signal })
          );
        }
        yield* capture(page, `${state}-light-desktop`);
        if (state === "pending") {
          yield* Effect.tryPromise((signal) =>
            page.getByRole("button", { name: "Consultar estado", exact: true }).click({ signal })
          );
          yield* Effect.tryPromise((signal) =>
            expect(page.getByText(copy, { exact: false })).toBeVisible({ signal })
          );
          expect(observed.submissions).toHaveLength(1);
        }
        expect(observed.unexpectedRequests).toEqual([]);
      })
    ));
}
const sourceStates = [
  {
    state: "source-available",
    copy: "Tu fuente de pago quedó disponible para cobros recurrentes.",
  },
  { state: "expired", copy: "La inscripción venció." },
  { state: "refused", copy: "No pudimos inscribir la fuente de pago." },
] as const;
for (const { state, copy } of sourceStates) {
  test(`Subscription ${state} preserves enrollment evidence without claiming a payment`, ({
    page,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const observed = yield* openSubscription(
          page,
          { viewport: desktop, theme: "light" },
          state
        );
        yield* chooseMonthly(page);
        yield* continueWith(page, "tarjeta");
        yield* Effect.tryPromise((signal) =>
          expect(page.getByText(copy, { exact: false })).toBeVisible({ signal })
        );
        if (state === "source-available") {
          yield* Effect.tryPromise((signal) =>
            expect(
              page.getByText("Esto todavía no confirma que el pago esté aprobado.", { exact: true })
            ).toBeVisible({ signal })
          );
        }
        yield* Effect.tryPromise((signal) =>
          expect(page.getByText("Tu pago fue realizado y tu suscripción está activa.")).toHaveCount(
            0,
            { signal }
          )
        );
        yield* capture(page, `${state}-light-desktop`);
        expect(observed.submissions).toEqual([]);
        expect(observed.unexpectedRequests).toEqual([]);
      })
    ));
}
test("Uncertain DaviPlata confirmation does not offer a fresh authorization or imply rejection", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const observed = yield* openSubscription(
        page,
        { viewport: desktop, theme: "light" },
        "uncertain"
      );
      yield* chooseMonthly(page);
      yield* continueWith(page, "DaviPlata");
      yield* beginDaviplata(page);
      yield* Effect.tryPromise((signal) =>
        page.getByLabel("Código de verificación", { exact: true }).fill("574829", { signal })
      );
      yield* Effect.tryPromise((signal) =>
        page.getByRole("button", { name: "Confirmar código", exact: true }).click({ signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(
          page.getByText(
            /No pudimos confirmar el resultado. No vuelvas a iniciar la autorización./u
          )
        ).toBeVisible({ signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(
          page.getByRole("button", { name: "Autorizar con DaviPlata", exact: true })
        ).toHaveCount(0, { signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(page.getByLabel("Código de verificación", { exact: true })).toHaveCount(0, {
          signal,
        })
      );
      yield* capture(page, "uncertain-light-desktop");
      expect(observed.submissions).toEqual([]);
      expect(observed.providerCalls).toEqual([
        "/v1/tokens/daviplata",
        "RESEND_OTP",
        "VALIDATE_OTP_API",
      ]);
      expect(observed.unexpectedRequests).toEqual([]);
    })
  ));

for (const theme of themes) {
  for (const viewport of [desktop, mobile]) {
    test(`Paid access and recent attempts remain distinct in ${theme} ${viewport.name}`, ({
      page,
    }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const observed = yield* openSubscription(page, { viewport, theme }, "paid");
          yield* Effect.tryPromise((signal) =>
            expect(page.getByText(/Último período pagado/u)).toBeVisible({ signal })
          );
          yield* Effect.tryPromise((signal) =>
            expect(
              page.getByRole("heading", { name: "Intentos de cobro recientes", exact: true })
            ).toBeVisible({ signal })
          );
          yield* Effect.tryPromise((signal) =>
            expect(page.getByText(/Precio cobrado:/u)).toContainText("28.900", { signal })
          );
          yield* capture(page, `paid-${theme}-${viewport.name}`);
          expect(observed.preparations).toEqual([]);
          expect(observed.submissions).toEqual([]);
          expect(observed.unexpectedRequests).toEqual([]);
        })
      ));
  }
}
test("Unavailable subscription standing retains a retry without blocking historical data", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const observed = yield* openSubscription(
        page,
        { viewport: desktop, theme: "light" },
        "unavailable"
      );
      yield* Effect.tryPromise((signal) =>
        expect(page.getByText("Estado no disponible", { exact: true })).toBeVisible({ signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(page.getByRole("button", { name: "Reintentar", exact: true })).toBeEnabled({
          signal,
        })
      );
      yield* capture(page, "unavailable-light-desktop");
      expect(observed.submissions).toEqual([]);
      expect(observed.unexpectedRequests).toEqual([]);
    })
  ));

const fillCardDraft = Effect.fnUntraced(function* (page: Page) {
  yield* Effect.tryPromise((signal) =>
    page.getByLabel("Número de tarjeta", { exact: true }).fill("4111111111111111", { signal })
  );
  yield* Effect.tryPromise((signal) =>
    page.getByLabel("Vencimiento", { exact: true }).fill("122028", { signal })
  );
  yield* Effect.tryPromise((signal) =>
    page.getByLabel("CVC", { exact: true }).fill("123", { signal })
  );
  yield* Effect.tryPromise((signal) =>
    page.getByLabel("Nombre en la tarjeta", { exact: true }).fill("Usuario Prueba", { signal })
  );
  yield* fillBillingEmail(page);
});
const expectDiscardedCardDraft = Effect.fnUntraced(function* (page: Page) {
  yield* Effect.tryPromise((signal) =>
    expect(page.getByLabel("Número de tarjeta", { exact: true })).toHaveValue("", { signal })
  );
  yield* Effect.tryPromise((signal) =>
    expect(page.getByLabel("CVC", { exact: true })).toHaveValue("", { signal })
  );
  yield* expectSeparateConsents(page);
});
const keyboardContinue = Effect.fnUntraced(function* (page: Page) {
  const choice = page.getByRole("button", { name: /^mensual\b/iu });
  yield* Effect.tryPromise((signal) => choice.focus({ signal }));
  yield* Effect.tryPromise((signal) => expect(choice).toBeFocused({ signal }));
  yield* Effect.tryPromise((signal) => choice.press("Enter", { signal }));
  const next = page.getByRole("button", { name: "Continuar con tarjeta", exact: true });
  yield* Effect.tryPromise((signal) => next.focus({ signal }));
  yield* Effect.tryPromise((signal) => expect(next).toBeFocused({ signal }));
  yield* Effect.tryPromise((signal) => next.press("Enter", { signal }));
});
const changeSelection = Effect.fnUntraced(function* (page: Page) {
  yield* Effect.tryPromise((signal) =>
    page.getByRole("button", { name: "Cambiar selección", exact: true }).click({ signal })
  );
});
for (const viewport of [desktop, mobile]) {
  test(`Changing method and browser history discard unsubmitted payment drafts on ${viewport.name}`, ({
    page,
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const observed = yield* openSubscription(page, { viewport, theme: "light" });
        yield* keyboardContinue(page);
        yield* fillCardDraft(page);
        yield* Effect.tryPromise((signal) =>
          page.getByRole("checkbox", { name: /Acepto el reglamento/iu }).check({ signal })
        );
        yield* Effect.tryPromise((signal) =>
          expect(page.getByRole("button", { name: "Activar Pro", exact: true })).toBeDisabled({
            signal,
          })
        );
        yield* Effect.tryPromise((signal) =>
          page.getByRole("checkbox", { name: /Autorizo el tratamiento/iu }).check({ signal })
        );
        yield* Effect.tryPromise((signal) =>
          expect(page.getByRole("button", { name: "Activar Pro", exact: true })).toBeEnabled({
            signal,
          })
        );
        yield* changeSelection(page);
        yield* continueWith(page, "Nequi");
        yield* expectSeparateConsents(page);
        yield* changeSelection(page);
        yield* Effect.tryPromise((signal) =>
          page.getByRole("button", { name: "Tarjeta", exact: true }).click({ signal })
        );
        yield* continueWith(page, "tarjeta");
        yield* expectDiscardedCardDraft(page);
        yield* fillCardDraft(page);
        const privacy = page.getByRole("heading", { name: "Privacidad", exact: true });
        yield* Effect.tryPromise((signal) => page.goto("/settings/privacy", { signal }));
        yield* Effect.tryPromise((signal) => expect(privacy).toBeVisible({ signal }));
        yield* Effect.tryPromise((signal) => page.goBack({ signal }));
        yield* keyboardContinue(page);
        yield* expectDiscardedCardDraft(page);
        yield* Effect.tryPromise((signal) => page.goForward({ signal }));
        yield* Effect.tryPromise((signal) => expect(privacy).toBeVisible({ signal }));
        yield* Effect.tryPromise((signal) => page.goBack({ signal }));
        yield* Effect.tryPromise((signal) =>
          expect(page.getByRole("button", { name: /^mensual\b/iu })).toHaveAttribute(
            "aria-pressed",
            "false",
            { signal }
          )
        );
        expect(observed.submissions).toEqual([]);
        expect(observed.providerCalls).toEqual([]);
        expect(observed.unexpectedRequests).toEqual([]);
      })
    ));
}
test("Only backend-enabled payment methods can be selected", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const observed = yield* installSubscriptionFixture(page, "form", ["nequi"]);
      yield* Effect.tryPromise((signal) => page.goto("/upgrade", { signal }));
      yield* chooseMonthly(page);
      yield* Effect.tryPromise((signal) =>
        expect(page.getByRole("button", { name: "Tarjeta", exact: true })).toHaveCount(0, {
          signal,
        })
      );
      yield* Effect.tryPromise((signal) =>
        expect(page.getByRole("button", { name: "DaviPlata", exact: true })).toHaveCount(0, {
          signal,
        })
      );
      yield* continueWith(page, "Nequi");
      yield* Effect.tryPromise((signal) =>
        expect(page.getByLabel("Número de Nequi", { exact: true })).toBeVisible({ signal })
      );
      expect(observed.preparations).toEqual(["nequi"]);
      expect(observed.submissions).toEqual([]);
      expect(observed.unexpectedRequests).toEqual([]);
    })
  ));

test("No payment can start when the backend enables no methods", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const observed = yield* installSubscriptionFixture(page, "form", []);
      yield* Effect.tryPromise((signal) => page.goto("/upgrade", { signal }));
      yield* chooseMonthly(page);
      for (const method of ["Tarjeta", "Nequi", "DaviPlata"]) {
        yield* Effect.tryPromise((signal) =>
          expect(page.getByRole("button", { name: method, exact: true })).toHaveCount(0, { signal })
        );
      }
      yield* Effect.tryPromise((signal) =>
        expect(
          page.getByRole("button", { name: "Continuar con tarjeta", exact: true })
        ).toBeDisabled({ signal })
      );
      expect(observed.preparations).toEqual([]);
      expect(observed.submissions).toEqual([]);
      expect(observed.unexpectedRequests).toEqual([]);
    })
  ));

test("Paid access and billing history remain available when the offer catalog fails", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const observed = yield* openSubscription(
        page,
        { viewport: desktop, theme: "light" },
        "offers-unavailable"
      );
      yield* Effect.tryPromise((signal) =>
        expect(page.getByText(/Último período pagado/u)).toBeVisible({ signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(
          page.getByRole("heading", { name: "Intentos de cobro recientes", exact: true })
        ).toBeVisible({ signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(page.getByRole("button", { name: "Reintentar carga", exact: true })).toBeEnabled({
          signal,
        })
      );
      yield* capture(page, "catalog-unavailable-light-desktop");
      expect(observed.preparations).toEqual([]);
      expect(observed.submissions).toEqual([]);
      expect(observed.unexpectedRequests).toEqual([]);
    })
  ));

const installUnavailableMethods = Effect.fnUntraced(function* (page: Page) {
  let unavailable = true;
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/web/subscription/payment-enrollments/availability`, (route) =>
      unavailable
        ? route.fulfill({ status: 503, contentType: "application/json", body: "{}" })
        : route.fallback()
    )
  );
  return (): void => {
    unavailable = false;
  };
});

test("Unavailable payment methods are not presented as an empty successful result and can be retried", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const observed = yield* installSubscriptionFixture(page);
      const restoreMethods = yield* installUnavailableMethods(page);
      yield* Effect.tryPromise((signal) => page.goto("/upgrade", { signal }));
      yield* chooseMonthly(page);
      yield* Effect.tryPromise((signal) =>
        expect(
          page.getByText("No pudimos consultar los métodos de pago. Intenta de nuevo.", {
            exact: true,
          })
        ).toBeVisible({ signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(
          page.getByText("No hay métodos de pago disponibles en este momento.", { exact: true })
        ).toHaveCount(0, { signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(
          page.getByRole("button", { name: "Continuar con tarjeta", exact: true })
        ).toBeDisabled({ signal })
      );
      restoreMethods();
      yield* Effect.tryPromise((signal) =>
        page.getByRole("button", { name: "Actualizar métodos", exact: true }).click({ signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(page.getByRole("button", { name: "Tarjeta", exact: true })).toBeVisible({ signal })
      );
      yield* Effect.tryPromise((signal) =>
        expect(
          page.getByRole("button", { name: "Continuar con tarjeta", exact: true })
        ).toBeEnabled({ signal })
      );
      expect(observed.preparations).toEqual([]);
      expect(observed.submissions).toEqual([]);
      expect(observed.unexpectedRequests).toEqual([]);
    })
  ));

for (const viewport of [desktop, mobile]) {
  test(`Subscription theme control persists the chosen palette on ${viewport.name}`, ({ page }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const observed = yield* openSubscription(page, { viewport, theme: "light" });
        yield* Effect.tryPromise((signal) =>
          page.getByRole("button", { name: "Activar tema oscuro", exact: true }).click({ signal })
        );
        yield* expectSubscriptionShell(page, { viewport, theme: "dark" });
        yield* Effect.tryPromise((signal) => page.reload({ signal }));
        yield* expectSubscriptionShell(page, { viewport, theme: "dark" });
        expect(observed.preparations).toEqual([]);
        expect(observed.submissions).toEqual([]);
        expect(observed.unexpectedRequests).toEqual([]);
      })
    ));
}

const unavailableConsentStatus = 503;
const availableConsentStatus = 200;
const installUnresolvedConsent = Effect.fnUntraced(function* (
  page: Page,
  consent: "unknown" | "revoked"
) {
  const blocked: string[] = [];
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/web/consent`, (route) =>
      route.fulfill({
        status: consent === "unknown" ? unavailableConsentStatus : availableConsentStatus,
        contentType: "application/json",
        body: JSON.stringify(
          consent === "unknown"
            ? {}
            : {
                status: "Revoked",
                withdrawal: {
                  reference: "15520000-0000-4000-8000-000000000006",
                  occurredAtMs: 1000,
                },
              }
        ),
      })
    )
  );
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/web/consent" || path === "/web/session/binding") return route.fallback();
      blocked.push(`${route.request().method()} ${path}`);
      return route.abort("blockedbyclient");
    })
  );
  return blocked;
});
for (const path of ["/UPGRADE", "/upgrade/"]) {
  for (const consent of ["unknown", "revoked"] as const) {
    test(`Upgrade shell makes no product requests with ${consent} Consent at ${path}`, ({ page }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.tryPromise(() => page.setViewportSize(desktop));
          const observed = yield* installSubscriptionFixture(page);
          const blocked = yield* installUnresolvedConsent(page, consent);
          yield* Effect.tryPromise((signal) => page.goto(path, { signal }));
          yield* Effect.tryPromise((signal) =>
            expect(page.getByRole("alert")).toContainText(
              consent === "unknown"
                ? "No pudimos verificar tu autorización"
                : "Tu autorización está retirada",
              { signal }
            )
          );
          yield* Effect.tryPromise((signal) =>
            expect(page.getByRole("button", { name: "Cerrar sesión", exact: true })).toBeVisible({
              signal,
            })
          );
          yield* Effect.tryPromise((signal) => page.waitForLoadState("networkidle", { signal }));
          yield* Effect.tryPromise((signal) =>
            expect(page.getByRole("button", { name: /^mensual\b/iu })).toHaveCount(0, { signal })
          );
          expect(blocked).toEqual([]);
          expect(observed.preparations).toEqual([]);
          expect(observed.submissions).toEqual([]);
          expect(observed.providerCalls).toEqual([]);
          expect(observed.unexpectedRequests).toEqual([]);
        })
      ));
  }
}
