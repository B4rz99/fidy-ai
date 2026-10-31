import { expectSameLoadingFrame, measureLoadingFrame } from "./loading-geometry";
import type { Page, Route } from "@playwright/test";
import { Effect } from "effect";
import { apiOrigin, installUser, response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";
import {
  captureReport,
  installReportSession,
  unavailableReportHandler,
  visualReportHandler,
  visualReportPath,
} from "./recurring-report-visual-fixture";

const { expect, test } = playwright;

test.use({
  storageState: { cookies: [], origins: [] },
  deviceScaleFactor: 1,
  timezoneId: "Pacific/Honolulu",
});
const reportItemCount = 40;
const lastItem = reportItemCount - 1;
const confirmationOffset = 300;
const seriesOffset = 400;
const uuidSuffixLength = 12;
const unavailableStatus = 503;
const okStatus = 200;
const reportId = "24000000-0000-4000-8000-000000000260";
const reportPath = `/insights/recurring/${reportId}`;
const unsafeCounterparty = '<img src=x onerror="alert(1)">';
const report = {
  insightEventId: reportId,
  serviceMarket: "CO",
  locale: "es-CO",
  scheduledAt: "2026-10-08T14:00:00.000Z",
  expiresAt: "2026-10-08T15:00:00.000Z",
  payload: {
    confirmationDay: {
      localDate: "2026-10-07",
      timeZone: "America/Bogota",
      from: "2026-10-07T05:00:00.000Z",
      toExclusive: "2026-10-08T05:00:00.000Z",
    },
    items: Array.from({ length: reportItemCount }, (_, index) => ({
      confirmationId: `24000000-0000-4000-8000-${String(index + confirmationOffset).padStart(uuidSuffixLength, "0")}`,
      seriesId: `24000000-0000-4000-8000-${String(index + seriesOffset).padStart(uuidSuffixLength, "0")}`,
      counterparty:
        index === 0 ? unsafeCounterparty : `Proveedor ${String(index).padStart(2, "0")}`,
      money: {
        amount: index === lastItem ? "12.34" : "30000.25",
        currency: index === lastItem ? "USD" : "COP",
      },
      cadence: { kind: "monthly" },
      confirmedAt: "2026-10-07T12:00:00.000Z",
    })),
  },
};

test("a malformed report response refuses partial financial facts", ({ page }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}${reportPath}`, malformedReportHandler)
      );
      yield* Effect.tryPromise(() => page.goto(reportPath));
      yield* Effect.tryPromise(() => expect(page.getByText("Informe no disponible")).toBeVisible());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("list", { name: "Todos los patrones confirmados" })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("Invalid retained item")).toHaveCount(0)
      );
    })
  ));

const malformedReportHandler = (route: Route): Promise<void> =>
  route.fulfill({
    contentType: "application/json",
    body: response({
      ...report,
      payload: {
        ...report.payload,
        items: [...report.payload.items, { counterparty: "Invalid retained item" }],
      },
    }),
  });

const retryJourney = Effect.fnUntraced(function* (page: Page) {
  const initial = Promise.withResolvers<void>();
  const retry = Promise.withResolvers<void>();
  let calls = 0;
  yield* Effect.tryPromise(() => installUser(page));
  const handler = delayedReportHandler(initial.promise, retry.promise, () => {
    calls += 1;
    return calls === 1;
  });
  yield* Effect.tryPromise(() => page.route(`${apiOrigin}${reportPath}`, handler));
  yield* Effect.tryPromise(() => page.goto(reportPath));
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("status", { name: "Cargando informe", exact: true })).toHaveAttribute(
      "aria-busy",
      "true"
    )
  );
  const frameParts = [
    "recurring-report-columns",
    "recurring-report-main",
    "recurring-report-context",
    "recurring-report-labels",
  ].map((name) => ({ name, selector: `.${name}` }));
  const loadingFrame = yield* Effect.tryPromise(() => measureLoadingFrame(page, frameParts));
  initial.resolve();
  yield* Effect.tryPromise(() => expect(page.getByText("Informe no disponible")).toBeVisible());
  yield* Effect.tryPromise(() =>
    expect(page.getByText("private-storage-diagnostic")).toHaveCount(0)
  );
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Reintentar", exact: true }).click()
  );
  yield* Effect.tryPromise(() =>
    expect(page.getByRole("button", { name: "Reintentando…", exact: true })).toBeDisabled()
  );
  retry.resolve();
  yield* Effect.tryPromise(() =>
    expect(
      page.getByRole("list", { name: "Todos los patrones confirmados" }).getByRole("listitem")
    ).toHaveCount(reportItemCount)
  );
  const loadedFrame = yield* Effect.tryPromise(() => measureLoadingFrame(page, frameParts));
  expectSameLoadingFrame(loadingFrame, loadedFrame);
  expect(calls).toBe(2);
});

test("a failed report read explains the failure safely and explicit retry recovers all historical facts", ({
  page,
}) => Effect.runPromise(retryJourney(page)));

test("a malformed report link explains recovery without offering a retry that cannot work", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() => page.goto("/insights/recurring/invalid"));
      yield* Effect.tryPromise(() => expect(page.getByText("Enlace no válido")).toBeVisible());
      yield* Effect.tryPromise(() =>
        expect(
          page.getByText("Abre el enlace original del informe que recibiste de Fidy.")
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Reintentar", exact: true })).toHaveCount(0)
      );
    })
  ));

test("the complete historical report preserves every item, explicit currencies and escaped Counterparty text", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() => installUser(page));
      yield* Effect.tryPromise(() =>
        page.route(`${apiOrigin}${reportPath}`, completeReportHandler)
      );
      yield* Effect.tryPromise(() => page.goto(reportPath));
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("heading", { name: "Reporte de recurrentes", exact: true })
        ).toBeVisible()
      );
      const items = page
        .getByRole("list", { name: "Todos los patrones confirmados" })
        .getByRole("listitem");
      yield* Effect.tryPromise(() => expect(items).toHaveCount(reportItemCount));
      yield* Effect.tryPromise(() => expect(items.nth(0)).toContainText(unsafeCounterparty));
      yield* Effect.tryPromise(() => expect(items.nth(0)).toContainText("30.000,25 COP"));
      yield* Effect.tryPromise(() => expect(items.nth(lastItem)).toContainText("12,34 USD"));
      yield* Effect.tryPromise(() =>
        expect(
          page.getByText("Estos patrones no indican que los cargos sigan activos.", {
            exact: false,
          })
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() => expect(page.locator("img[src=x]")).toHaveCount(0));
      yield* Effect.tryPromise(() =>
        expect(page.locator('time[datetime="2026-10-07"]').first()).toContainText("7 oct 2026")
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByText("America/Bogota", { exact: true })).toBeVisible()
      );
    })
  ));

const completeReportHandler = (route: Route): Promise<void> =>
  route.fulfill({ contentType: "application/json", body: response(report) });

const delayedReportHandler =
  (initial: Promise<void>, retry: Promise<void>, isFirst: () => boolean) =>
  (route: Route): Promise<void> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const first = isFirst();
        yield* Effect.tryPromise(() => (first ? initial : retry));
        yield* Effect.tryPromise(() =>
          route.fulfill({
            status: first ? unavailableStatus : okStatus,
            contentType: "application/json",
            body: first
              ? '{"error":{"code":"unavailable","message":"private-storage-diagnostic"},"next":[]}'
              : response(report),
          })
        );
      })
    );

const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];
const themes = ["light", "dark"] as const;
const visualItemCount = 6;
const visualStates = ["report", "loading", "invalid", "unavailable"] as const;
type VisualState = (typeof visualStates)[number];

const prepareVisualReport = Effect.fnUntraced(function* (page: Page, state: VisualState) {
  yield* Effect.tryPromise(() => installReportSession(page));
  const pending = Promise.withResolvers<void>();
  const handler = (route: Route): Promise<void> => {
    if (state === "unavailable") return unavailableReportHandler(route);
    if (state === "loading") return pending.promise.then(() => visualReportHandler(route));
    return visualReportHandler(route);
  };
  yield* Effect.tryPromise(() => page.route(`${apiOrigin}${visualReportPath}`, handler));
  yield* Effect.tryPromise(() =>
    page.goto(state === "invalid" ? "/insights/recurring/invalid" : visualReportPath)
  );
  const ready = {
    report: "Patrones históricos",
    loading: "Cargando informe",
    invalid: "Enlace no válido",
    unavailable: "Informe no disponible",
  };
  yield* Effect.tryPromise(() =>
    expect(
      state === "loading"
        ? page.getByRole("status", { name: ready[state], exact: true })
        : page.getByText(ready[state], { exact: true })
    ).toBeVisible()
  );
  return pending.resolve;
});

const assertVisualReport = Effect.fnUntraced(function* (page: Page) {
  const items = page
    .getByRole("list", { name: "Todos los patrones confirmados" })
    .getByRole("listitem");
  yield* Effect.tryPromise(() => expect(items).toHaveCount(visualItemCount));
  yield* Effect.tryPromise(() => expect(items.first()).toContainText("119.900,00 COP"));
  yield* Effect.tryPromise(() => expect(items.last()).toContainText("20,00 USD"));
  yield* Effect.tryPromise(() =>
    expect(page.getByText("America/Bogota", { exact: true })).toBeVisible()
  );
  yield* Effect.tryPromise(() =>
    expect(page.locator('time[datetime="2026-10-26"]').first()).toContainText("26 oct 2026")
  );
});

for (const viewport of viewports) {
  for (const theme of themes) {
    for (const state of visualStates) {
      test(`historical report ${state} is accessible in ${theme} ${viewport.name}`, ({ page }) =>
        Effect.runPromise(
          Effect.gen(function* () {
            yield* Effect.tryPromise(() => page.setViewportSize(viewport));
            yield* Effect.tryPromise(() => page.emulateMedia({ colorScheme: theme }));
            const release = yield* prepareVisualReport(page, state);
            const filename = `${state}-${theme}-${viewport.name}`;
            if (viewport.name === "desktop") {
              yield* Effect.tryPromise(() =>
                expect(
                  page.getByRole("button", { name: "Cerrar sesión", exact: true })
                ).toBeVisible()
              );
            }
            if (state === "report") yield* assertVisualReport(page);
            yield* captureReport(page, filename);
            if (state === "report" && viewport.name === "mobile") {
              yield* Effect.tryPromise(() =>
                page
                  .getByText(
                    "El informe conserva los datos registrados cuando se confirmaron estos patrones.",
                    { exact: true }
                  )
                  .scrollIntoViewIfNeeded()
              );
              yield* Effect.tryPromise(() =>
                expect(page.getByText("Herramienta de trabajo", { exact: true })).toBeInViewport()
              );
              yield* captureReport(page, `${filename}-scroll-final`);
            }
            release();
            if (state === "loading") {
              yield* Effect.tryPromise(() =>
                expect(
                  page
                    .getByRole("list", { name: "Todos los patrones confirmados" })
                    .getByRole("listitem")
                ).toHaveCount(visualItemCount)
              );
            }
          })
        ));
    }
  }
}
