import { captureVisualEvidence } from "./visual-evidence";
import type { Locator, Page, Route } from "@playwright/test";
import { Effect } from "effect";
import { playwright } from "./playwright-runtime";
import { apiOrigin, response } from "./http-fixtures";
import { installSubscriptionFixture, paidStanding } from "./subscription-visual-fixture";
import { analyzeAccessibility } from "./accessibility";

const { test, expect } = playwright;
type Display = Readonly<{ width: number; theme: "light" | "dark"; enlarged: boolean }>;
const cancellation = {
  cancelledAt: "2026-11-02T15:00:00Z",
  paidThrough: "2026-11-25T14:00:00Z",
  sourceCancellation: "void-pending",
};
const management = (page: Page): Locator =>
  page.getByRole("region", { name: "Renovaciones de la suscripción", exact: true });
const controlDimensions = (element: Element): Readonly<{ width: number; height: number }> => {
  const { width, height } = element.getBoundingClientRect();
  return { width, height };
};
const contentFitsViewport = (): boolean =>
  document.documentElement.scrollWidth <= document.documentElement.clientWidth;
const controlsFit = (elements: ReadonlyArray<Element>): boolean =>
  elements.every((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = range.getBoundingClientRect();
    const control = element.getBoundingClientRect();
    return (
      text.left >= control.left &&
      text.right <= control.right &&
      text.top >= control.top &&
      text.bottom <= control.bottom
    );
  });
const enlargeText = (route: Route): Promise<void> =>
  route.fulfill({
    status: 200,
    contentType: "text/css",
    body: ".subscription-main :is(p, output, td, th), .subscription-workspace [data-slot='button'] { font-size: 32px; } .subscription-main h2 { font-size: 48px; }",
  });
const mobileWidth = 390;
const intermediateWidth = 715;
const betweenBreakpointsWidth = 1024;
const desktopWidth = 1440;
const openDesign = Effect.fnUntraced(function* (
  page: Page,
  display: Display,
  unavailable: boolean = false
) {
  yield* Effect.tryPromise(() => page.setViewportSize({ width: display.width, height: 960 }));
  yield* Effect.tryPromise(() =>
    page.emulateMedia({ colorScheme: display.theme, reducedMotion: "reduce" })
  );
  const observed = yield* installSubscriptionFixture(page, unavailable ? "unavailable" : "paid");
  yield* Effect.tryPromise((signal) => page.goto("/upgrade", { signal }));
  yield* Effect.tryPromise((signal) =>
    expect(page.getByRole("main")).toHaveCSS("color-scheme", display.theme, { signal })
  );
  if (display.enlarged) {
    yield* Effect.tryPromise(() => page.route("**/cancellation-text-scale.css", enlargeText));
    yield* Effect.tryPromise(() =>
      page.addStyleTag({ url: new URL("/cancellation-text-scale.css", page.url()).href })
    );
  }
  return observed;
});
const captureState = Effect.fnUntraced(function* (page: Page, display: Display, state: string) {
  const filename = `cancellation-${display.width}-${display.theme}-${display.enlarged ? "enlarged" : "standard"}-${state}`;
  yield* Effect.tryPromise((signal) =>
    captureVisualEvidence({
      target: page,
      options: {
        signal,
        path: new URL(`../test-results/${filename}.png`, import.meta.url).pathname,
        fullPage: true,
        animations: "disabled",
      },
    })
  );
  const accessibility = yield* Effect.tryPromise(() => analyzeAccessibility(page));
  expect(accessibility.violations).toEqual([]);
  expect(yield* Effect.tryPromise(() => page.evaluate(contentFitsViewport))).toBe(true);
  expect(
    yield* Effect.tryPromise(() => management(page).getByRole("button").evaluateAll(controlsFit))
  ).toBe(true);
});
const verifyDesign = Effect.fnUntraced(function* (page: Page, display: Display) {
  const observed = yield* openDesign(page, display);
  const completion = Promise.withResolvers<void>();
  const handle = (route: Route): Promise<void> =>
    completion.promise.then(() =>
      route.fulfill({ status: 200, contentType: "application/json", body: response(cancellation) })
    );
  yield* Effect.tryPromise(() => page.route(`${apiOrigin}/subscription/cancellation`, handle));
  try {
    const trigger = page.getByRole("button", {
      name: "Cancelar renovaciones futuras",
      exact: true,
    });
    yield* Effect.tryPromise((signal) =>
      expect(trigger).toHaveCSS("background-color", "rgb(240, 180, 174)", { signal })
    );
    yield* Effect.tryPromise((signal) => trigger.focus({ signal }));
    yield* Effect.tryPromise((signal) => trigger.press("Enter", { signal }));
    yield* captureState(page, display, "review");
    const confirm = page.getByRole("button", { name: "Confirmar cancelación", exact: true });
    yield* Effect.tryPromise((signal) => confirm.focus({ signal }));
    yield* Effect.tryPromise((signal) =>
      expect(confirm).toHaveCSS("color", "rgb(23, 25, 22)", { signal })
    );
    const idleGeometry = yield* Effect.tryPromise(() => confirm.evaluate(controlDimensions));
    yield* Effect.tryPromise((signal) => confirm.press("Enter", { signal }));
    const pending = confirm;
    yield* Effect.tryPromise((signal) => expect(pending).toBeDisabled({ signal }));
    yield* Effect.tryPromise((signal) =>
      expect(pending).toHaveCSS("background-color", "rgb(240, 180, 174)", { signal })
    );
    expect(yield* Effect.tryPromise(() => pending.evaluate(controlDimensions))).toEqual(
      idleGeometry
    );
    yield* captureState(page, display, "submitting");
    completion.resolve();
    const result = page.getByRole("region", { name: "Renovaciones canceladas", exact: true });
    yield* Effect.tryPromise((signal) =>
      expect(result).toContainText("sigue pendiente", { signal })
    );
    yield* Effect.tryPromise((signal) =>
      expect(result.getByRole("status")).toBeFocused({ signal })
    );
    yield* captureState(page, display, "provider-pending");
    expect(observed.unexpectedRequests).toEqual([]);
    expect(observed.providerCalls).toEqual([]);
  } finally {
    completion.resolve();
  }
});
for (const theme of ["light", "dark"] as const) {
  for (const width of [mobileWidth, intermediateWidth, betweenBreakpointsWidth, desktopWidth]) {
    test(`Subscription cancellation design at ${width}px in ${theme}`, ({ page }) =>
      Effect.runPromise(verifyDesign(page, { width, theme, enlarged: false })));
  }
  for (const width of [mobileWidth, intermediateWidth]) {
    test(`Subscription cancellation design with enlarged text at ${width}px in ${theme}`, ({
      page,
    }) => Effect.runPromise(verifyDesign(page, { width, theme, enlarged: true })));
  }
  test(`Subscription cancellation unavailable feedback in ${theme}`, ({ page }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const display = { width: intermediateWidth, theme, enlarged: false };
        yield* openDesign(page, display, true);
        yield* Effect.tryPromise((signal) =>
          expect(management(page)).toContainText("No podemos verificar", { signal })
        );
        yield* captureState(page, display, "unavailable");
      })
    ));
  test(`Subscription cancellation uncertain feedback in ${theme}`, ({ page }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const display = { width: intermediateWidth, theme, enlarged: false };
        yield* openDesign(page, display);
        yield* Effect.tryPromise(() =>
          page.route(`${apiOrigin}/subscription/cancellation`, abortCancellation)
        );
        yield* Effect.tryPromise((signal) =>
          page
            .getByRole("button", { name: "Cancelar renovaciones futuras", exact: true })
            .click({ signal })
        );
        yield* Effect.tryPromise((signal) =>
          page.getByRole("button", { name: "Confirmar cancelación", exact: true }).click({ signal })
        );
        yield* Effect.tryPromise((signal) =>
          expect(management(page).getByRole("alert")).toBeFocused({ signal })
        );
        yield* captureState(page, display, "uncertain");
      })
    ));
}
const abortCancellation = (route: Route): Promise<void> => route.abort("failed");

test("Subscription cancellation waits for actual standing without placeholders", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        page.setViewportSize({ width: intermediateWidth, height: 960 })
      );
      const observed = yield* installSubscriptionFixture(page, "paid");
      const completion = Promise.withResolvers<void>();
      const handle = (route: Route): Promise<void> =>
        completion.promise.then(() =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: response(paidStanding),
          })
        );
      yield* Effect.tryPromise(() => page.route(`${apiOrigin}/subscription/status`, handle));
      try {
        yield* Effect.tryPromise((signal) => page.goto("/upgrade", { signal }));
        yield* Effect.tryPromise((signal) =>
          expect(
            management(page).getByRole("status", { name: "Cargando renovaciones", exact: true })
          ).toBeVisible({ signal })
        );
        yield* Effect.tryPromise((signal) =>
          expect(
            management(page).getByText("Renovaciones no disponibles", { exact: true })
          ).toHaveCount(0, { signal })
        );
        yield* Effect.tryPromise(() =>
          expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
        );
        completion.resolve();
        yield* Effect.tryPromise((signal) =>
          expect(
            page.getByRole("button", { name: "Cancelar renovaciones futuras", exact: true })
          ).toBeEnabled({ signal })
        );
        expect(observed.unexpectedRequests).toEqual([]);
      } finally {
        completion.resolve();
      }
    })
  ));

test("Subscription status refresh during review does not announce cancellation", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* openDesign(page, { width: desktopWidth, theme: "light", enlarged: false });
      yield* Effect.tryPromise((signal) =>
        page
          .getByRole("button", { name: "Cancelar renovaciones futuras", exact: true })
          .click({ signal })
      );
      const completion = Promise.withResolvers<void>();
      const handle = (route: Route): Promise<void> =>
        completion.promise.then(() =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: response(paidStanding),
          })
        );
      yield* Effect.tryPromise(() => page.route(`${apiOrigin}/subscription/status`, handle));
      try {
        yield* Effect.tryPromise((signal) =>
          page.getByRole("button", { name: "Actualizar estado", exact: true }).click({ signal })
        );
        yield* Effect.tryPromise((signal) =>
          expect(
            page.getByRole("button", { name: "Confirmar cancelación", exact: true })
          ).toBeDisabled({ signal })
        );
        yield* Effect.tryPromise((signal) =>
          expect(management(page).getByRole("status")).toContainText("Actualizando estado", {
            signal,
          })
        );
        yield* Effect.tryPromise((signal) =>
          expect(
            management(page).getByText("Cancelando renovaciones…", { exact: true })
          ).toHaveCount(0, { signal })
        );
      } finally {
        completion.resolve();
      }
    })
  ));
