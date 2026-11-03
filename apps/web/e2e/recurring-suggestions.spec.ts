import type { Page, Route, TestInfo } from "@playwright/test";
import { Effect } from "effect";
import { analyzeAccessibility } from "./accessibility";
import { apiOrigin, response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";
import { signInRecurringThroughCore } from "./real-core-fixture";
import { captureInThemes } from "./themed-capture";

const { expect, test } = playwright;
test.use({ reducedMotion: "reduce" });
const mobileWidth = 390;
const intermediateWidth = 715;
const desktopWidth = 1440;
const pattern = {
  id: "71000000-0000-4000-8000-000000001659",
  counterparty: "Patrón de prueba",
  money: { amount: "30000", currency: "COP" },
  cadence: { kind: "monthly" },
  firstOccurredAt: "2026-07-15T12:00:00.000Z",
  lastOccurredAt: "2026-09-15T12:00:00.000Z",
  confirmedAt: "2026-10-15T12:00:00.000Z",
  announcement: { kind: "suppressed", reason: "cold-start" },
};
type Outcome = "updating" | "current" | "unavailable";
const servePatterns = (route: Route, outcome: Outcome): Promise<void> => {
  if (outcome === "unavailable") {
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"error":{"code":"unavailable","message":"private-pattern-diagnostic"},"next":[]}',
    });
  }
  return route.fulfill({
    contentType: "application/json",
    body: response({
      series: [pattern],
      evaluation:
        outcome === "current"
          ? { kind: "current", asOf: "2026-10-15T12:00:00.000Z" }
          : { kind: "updating" },
    }),
  });
};

test("incomplete pattern analysis explains automatic detection and an explicit status check reveals completion", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInRecurringThroughCore({
          page,
          request,
          deferFreshEntry: true,
          identity: "recurringSuggestionsPending",
        })
      );
      let complete = false;
      const handler = (route: Route): Promise<void> =>
        route.fulfill({
          contentType: "application/json",
          body: response({
            series: [],
            evaluation: complete
              ? { kind: "current", asOf: "2026-10-15T12:00:00.000Z" }
              : { kind: "not-evaluated" },
          }),
        });
      yield* Effect.tryPromise(() => page.route(`${apiOrigin}/recurring-series*`, handler));
      yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-10"));
      yield* Effect.tryPromise(() =>
        page.getByText("Patrones detectados", { exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Aún no hay un análisis completo", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText(/Fidy analiza tus transacciones automáticamente/u)).toBeVisible()
      );
      yield* Effect.tryPromise(() => expect(page.getByText(/Ver estado/u)).toHaveCount(0));
      yield* Effect.tryPromise(() =>
        expect(
          page.getByText(/Las sugerencias son patrones de tu historial, no próximos pagos/u)
        ).toBeVisible()
      );
      complete = true;
      const refresh = page.getByRole("button", { name: "Actualizar estado", exact: true });
      yield* Effect.tryPromise(() => refresh.focus());
      yield* Effect.tryPromise(() => page.keyboard.press("Enter"));
      yield* Effect.tryPromise(() =>
        expect(page.getByText("No hay patrones nuevos para revisar en esta página.")).toBeVisible()
      );
      yield* Effect.tryPromise(() => expect(refresh).toBeFocused());
      yield* Effect.tryPromise(() => expect(refresh).toBeEnabled());
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Aún no hay un análisis completo", { exact: true })).toHaveCount(0)
      );
    })
  ));

const capturePresentation = Effect.fnUntraced(function* (
  page: Page,
  testInfo: TestInfo,
  display: Readonly<{ width: number; theme: string }>
) {
  const overflow = yield* Effect.tryPromise(() =>
    page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  );
  expect(overflow).toBe(false);
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("button", { name: "Actualizar estado", exact: true })).toBeVisible()
  );
  const audit = yield* Effect.tryPromise(() => analyzeAccessibility(page));
  expect(audit.violations).toEqual([]);
  yield* Effect.tryPromise(() =>
    page.screenshot({
      path: testInfo.outputPath(`patterns-${display.theme}-${display.width}.png`),
      fullPage: true,
    })
  );
});
const inspectPresentation = Effect.fnUntraced(function* (page: Page, testInfo: TestInfo) {
  for (const width of [mobileWidth, intermediateWidth, desktopWidth]) {
    yield* Effect.tryPromise(() => page.setViewportSize({ width, height: 1100 }));
    yield* captureInThemes(page, (theme) => capturePresentation(page, testInfo, { width, theme }));
  }
  yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 1100 }));
  yield* Effect.tryPromise(() =>
    page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    })
  );
  const overflow = yield* Effect.tryPromise(() =>
    page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  );
  expect(overflow).toBe(false);
  yield* Effect.tryPromise(() =>
    page.screenshot({ path: testInfo.outputPath("patterns-enlarged-text.png"), fullPage: true })
  );
});

const inspectFailedRefresh = Effect.fnUntraced(function* (page: Page, release: () => void) {
  const refresh = page.getByRole("button", { name: "Actualizar estado", exact: true });
  const create = page.getByRole("button", { name: "Crear recurrente", exact: true });
  yield* Effect.tryPromise(() => refresh.click());
  yield* Effect.tryPromise(() =>
    expect(page.getByText("Consultando el estado…", { exact: true })).toBeVisible()
  );
  yield* Effect.tryPromise(() => expect(refresh).toBeDisabled());
  yield* Effect.tryPromise(() => expect(create).toBeDisabled());
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("heading", { name: pattern.counterparty, exact: true })).toBeVisible()
  );
  release();
  yield* Effect.tryPromise(() =>
    expect(page.getByText(/No pudimos actualizar el estado/u)).toBeVisible()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByText("Aún no hay un análisis completo", { exact: true })).toHaveCount(0)
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByText("private-pattern-diagnostic")).toHaveCount(0)
  );
  yield* Effect.tryPromise(() => expect(create).toBeDisabled());
});

test("updating patterns stay visible and unavailable for decisions until a successful status refresh", ({
  page,
  request,
}, testInfo) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInRecurringThroughCore({
          page,
          request,
          deferFreshEntry: true,
          identity: "recurringSuggestionsUpdating",
        })
      );
      let outcome: Outcome = "updating";
      let hold = false;
      const gate = Promise.withResolvers<void>();
      const handler = (route: Route): Promise<void> =>
        hold
          ? gate.promise.then(() => servePatterns(route, outcome))
          : servePatterns(route, outcome);
      yield* Effect.tryPromise(() => page.route(`${apiOrigin}/recurring-series*`, handler));
      yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-10"));
      yield* Effect.tryPromise(() =>
        page.getByText("Patrones detectados", { exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("heading", { name: "El análisis está actualizándose", exact: true })
        ).toBeVisible()
      );
      const create = page.getByRole("button", { name: "Crear recurrente", exact: true });
      const refresh = page.getByRole("button", { name: "Actualizar estado", exact: true });
      yield* Effect.tryPromise(() => expect(create).toBeDisabled());
      yield* inspectPresentation(page, testInfo);
      outcome = "current";
      yield* Effect.tryPromise(() => refresh.click());
      yield* Effect.tryPromise(() => expect(create).toBeEnabled());
      outcome = "unavailable";
      hold = true;
      yield* inspectFailedRefresh(page, gate.resolve);
      outcome = "current";
      hold = false;
      yield* Effect.tryPromise(() => refresh.click());
      yield* Effect.tryPromise(() => expect(create).toBeEnabled());
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("heading", { name: "El análisis está al día", exact: true })
        ).toBeVisible()
      );
    })
  ));
