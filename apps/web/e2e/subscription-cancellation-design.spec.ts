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
    body: "html[data-cancellation-text-scale] .subscription-main :is(p, output, td, th), html[data-cancellation-text-scale] .subscription-workspace [data-slot='button'] { font-size: 32px; } html[data-cancellation-text-scale] .subscription-main h2 { font-size: 48px; }",
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
  yield* Effect.tryPromise(() => page.route("**/cancellation-text-scale.css", enlargeText));
  yield* Effect.tryPromise(() =>
    page.addStyleTag({ url: new URL("/cancellation-text-scale.css", page.url()).href })
  );
  yield* applyDisplay(page, display);
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
const displays: ReadonlyArray<Display> = (["light", "dark"] as const).flatMap((theme) => [
  ...[mobileWidth, intermediateWidth, betweenBreakpointsWidth, desktopWidth].map((width) => ({
    width,
    theme,
    enlarged: false,
  })),
  ...[mobileWidth, intermediateWidth].map((width) => ({ width, theme, enlarged: true })),
]);
const firstDisplay: Display = { width: mobileWidth, theme: "light", enlarged: false };
const applyDisplay = Effect.fnUntraced(function* (page: Page, display: Display) {
  yield* Effect.tryPromise(() => page.setViewportSize({ width: display.width, height: 960 }));
  yield* Effect.tryPromise(() =>
    page.emulateMedia({ colorScheme: display.theme, reducedMotion: "reduce" })
  );
  yield* Effect.tryPromise(() =>
    page.evaluate((enlarged) => {
      document.documentElement.toggleAttribute("data-cancellation-text-scale", enlarged);
    }, display.enlarged)
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("main")).toHaveCSS("color-scheme", display.theme)
  );
});
type DisplayGeometry = Readonly<{
  display: Display;
  bounds: Readonly<{ width: number; height: number }>;
}>;
const inspectReviewDesign = Effect.fnUntraced(function* (page: Page) {
  const confirm = page.getByRole("button", { name: "Confirmar cancelación", exact: true });
  const layouts: Array<DisplayGeometry> = [];
  for (const display of displays) {
    yield* applyDisplay(page, display);
    yield* captureState(page, display, "review");
    yield* Effect.tryPromise(() => confirm.focus());
    yield* Effect.tryPromise(() => expect(confirm).toHaveCSS("color", "rgb(23, 25, 22)"));
    const bounds = yield* Effect.tryPromise(() => confirm.evaluate(controlDimensions));
    layouts.push({ display, bounds });
  }
  return layouts;
});
const inspectPendingDesign = Effect.fnUntraced(function* (
  page: Page,
  layouts: ReadonlyArray<DisplayGeometry>
) {
  const pending = page.getByRole("button", { name: "Confirmar cancelación", exact: true });
  for (const { display, bounds } of layouts) {
    yield* applyDisplay(page, display);
    yield* Effect.tryPromise(() => expect(pending).toBeDisabled());
    yield* Effect.tryPromise(() =>
      expect(pending).toHaveCSS("background-color", "rgb(240, 180, 174)")
    );
    expect(yield* Effect.tryPromise(() => pending.evaluate(controlDimensions))).toEqual(bounds);
    yield* captureState(page, display, "submitting");
  }
});
const inspectResultDesign = Effect.fnUntraced(function* (page: Page) {
  const result = page.getByRole("region", { name: "Renovaciones canceladas", exact: true });
  for (const display of displays) {
    yield* applyDisplay(page, display);
    yield* Effect.tryPromise(() => expect(result).toContainText("sigue pendiente"));
    yield* Effect.tryPromise(() => expect(result.getByRole("status")).toBeFocused());
    yield* captureState(page, display, "provider-pending");
  }
});
const verifyDesign = Effect.fnUntraced(function* (page: Page) {
  const observed = yield* openDesign(page, firstDisplay);
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
    for (const display of displays) {
      yield* applyDisplay(page, display);
      yield* Effect.tryPromise(() =>
        expect(trigger).toHaveCSS("background-color", "rgb(240, 180, 174)")
      );
    }
    yield* applyDisplay(page, firstDisplay);
    yield* Effect.tryPromise(() => trigger.focus());
    yield* Effect.tryPromise(() => trigger.press("Enter"));
    const layouts = yield* inspectReviewDesign(page);
    yield* applyDisplay(page, firstDisplay);
    const confirm = page.getByRole("button", { name: "Confirmar cancelación", exact: true });
    yield* Effect.tryPromise(() => confirm.focus());
    yield* Effect.tryPromise(() => confirm.press("Enter"));
    yield* inspectPendingDesign(page, layouts);
    completion.resolve();
    yield* inspectResultDesign(page);
    expect(observed.unexpectedRequests).toEqual([]);
    expect(observed.providerCalls).toEqual([]);
  } finally {
    completion.resolve();
  }
});
test("Subscription cancellation design across viewports, themes and enlarged text", ({ page }) =>
  Effect.runPromise(verifyDesign(page)));
for (const theme of ["light", "dark"] as const) {
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
