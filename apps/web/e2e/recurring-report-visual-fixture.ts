import type { Page, Route } from "@playwright/test";
import { Effect, Schema } from "effect";
import { response } from "./http-fixtures";
import { playwright } from "./playwright-runtime";

const { expect } = playwright;
const { AxeBuilder } = await import("@axe-core/playwright");
const captureDirectory = "test-results/recurring-report-visual";
const uuidSuffixLength = 12;
const confirmationOffset = 600;
const seriesOffset = 700;
const unavailableStatus = 503;
export const visualReportPath = "/insights/recurring/24000000-0000-4000-8000-000000000560";
const examples = [
  { counterparty: "Adobe", amount: "119900.00", currency: "COP" },
  { counterparty: "Gimnasio", amount: "89900.00", currency: "COP" },
  { counterparty: "Netflix", amount: "44900.00", currency: "COP" },
  { counterparty: "Spotify", amount: "16900.00", currency: "COP" },
  { counterparty: "Almacenamiento", amount: "2.99", currency: "USD" },
  { counterparty: "Herramienta de trabajo", amount: "20.00", currency: "USD" },
];
const visualReport = {
  insightEventId: "24000000-0000-4000-8000-000000000560",
  serviceMarket: "CO",
  locale: "es-CO",
  scheduledAt: "2026-10-27T14:00:00.000Z",
  expiresAt: "2026-10-27T15:00:00.000Z",
  payload: {
    confirmationDay: {
      localDate: "2026-10-26",
      timeZone: "America/Bogota",
      from: "2026-10-26T05:00:00.000Z",
      toExclusive: "2026-10-27T05:00:00.000Z",
    },
    items: examples.map(({ counterparty, amount, currency }, index) => ({
      confirmationId: `24000000-0000-4000-8000-${String(index + confirmationOffset).padStart(uuidSuffixLength, "0")}`,
      seriesId: `24000000-0000-4000-8000-${String(index + seriesOffset).padStart(uuidSuffixLength, "0")}`,
      counterparty,
      money: { amount, currency },
      cadence: { kind: "monthly" },
      confirmedAt: "2026-10-26T12:00:00.000Z",
    })),
  },
};

export const visualReportHandler = (route: Route): Promise<void> =>
  route.fulfill({ contentType: "application/json", body: response(visualReport) });

export const unavailableReportHandler = (route: Route): Promise<void> =>
  route.fulfill({
    status: unavailableStatus,
    contentType: "application/json",
    body: '{"error":{"code":"unavailable","message":"private-storage-diagnostic"},"next":[]}',
  });

const waitForFonts = (): Promise<void> => document.fonts.ready.then(() => undefined);
const dimensions = (): Readonly<{ content: number; viewport: number }> => ({
  content: document.documentElement.scrollWidth,
  viewport: document.documentElement.clientWidth,
});

export const captureReport = Effect.fnUntraced(function* (page: Page, filename: string) {
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
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result);
  yield* Effect.tryPromise(() => Bun.write(`${captureDirectory}/${filename}.axe.json`, encoded));
  expect(result.violations).toEqual([]);
  const measured = yield* Effect.tryPromise(() => page.evaluate(dimensions));
  expect(measured.content).toBeLessThanOrEqual(measured.viewport);
});
