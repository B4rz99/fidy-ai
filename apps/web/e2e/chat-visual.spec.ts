import type { Page } from "@playwright/test";
import { DateTime, Effect, Schema } from "effect";
import { playwright } from "./playwright-runtime";
import {
  type ChatScenario,
  confirmationCommand,
  installChatScenario,
  recurringReview,
} from "./chat-visual-fixture";

const { test, expect } = playwright;
const { AxeBuilder } = await import("@axe-core/playwright");
const desktop = { name: "desktop", width: 1467, height: 1072 };
const mobile = { name: "mobile", width: 390, height: 844 };
const landscape = { name: "landscape", width: 667, height: 390 };
const themes = ["light", "dark"] as const;
const captureDirectory = "test-results/chat-visual";
const progressIntervalMilliseconds = 5000;
const cases: ReadonlyArray<
  Readonly<{ viewport: typeof desktop; scenarios: ReadonlyArray<ChatScenario> }>
> = [
  {
    viewport: desktop,
    scenarios: ["start", "conversation", "waiting", "uncertain", "receipt", "quota"],
  },
  { viewport: mobile, scenarios: ["start", "confirmation"] },
  { viewport: landscape, scenarios: ["confirmation"] },
];

test.use({ storageState: { cookies: [], origins: [] }, deviceScaleFactor: 1 });

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

const send = Effect.fnUntraced(function* (page: Page, text: string) {
  yield* Effect.tryPromise(() => page.getByLabel("Mensaje", { exact: true }).fill(text));
  yield* Effect.tryPromise(() => page.getByRole("button", { name: "Enviar", exact: true }).click());
});
const expectPending = Effect.fnUntraced(function* (page: Page, scenario: "waiting" | "uncertain") {
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Mensaje", { exact: true })).toHaveValue("")
  );
  if (scenario === "uncertain") {
    yield* Effect.tryPromise(() => page.clock.fastForward(progressIntervalMilliseconds));
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Consultar estado", exact: true })).toBeVisible()
    );
  } else {
    yield* Effect.tryPromise(() =>
      expect(page.getByText("Esperando respuesta…", { exact: true })).toBeVisible()
    );
  }
  yield* Effect.tryPromise(() =>
    expect(page.getByLabel("Mensaje", { exact: true })).toBeDisabled()
  );
});
const prepare = Effect.fnUntraced(function* (page: Page, scenario: ChatScenario) {
  yield* Effect.tryPromise(() => page.goto("/settings/account"));
  yield* Effect.tryPromise(() =>
    page.getByRole("button", { name: "Abrir agente Fidy", exact: true }).click()
  );
  if (scenario === "start") return;
  yield* send(
    page,
    scenario === "confirmation"
      ? "Quiero pausar Netflix en mis recurrentes."
      : "¿Cuánto gasté en restaurantes este mes?"
  );
  if (scenario === "confirmation") {
    yield* Effect.tryPromise(() =>
      expect(page.getByText(recurringReview, { exact: true })).toBeVisible()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Confirmar cambio", exact: true })).toBeEnabled()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByText(confirmationCommand, { exact: false })).toHaveCount(0)
    );
  } else if (scenario === "conversation") {
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Mensaje", { exact: true })).toBeEnabled()
    );
    yield* send(page, "¿Y el mes anterior?");
    yield* Effect.tryPromise(() =>
      expect(
        page.getByText("El mes anterior registraste $210.000.", { exact: false })
      ).toBeVisible()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Mensaje", { exact: true })).toBeEnabled()
    );
  } else if (scenario === "waiting" || scenario === "uncertain") {
    yield* expectPending(page, scenario);
  } else if (scenario === "receipt") {
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Reintentar conexión", exact: true })).toBeVisible()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Mensaje", { exact: true })).toBeDisabled()
    );
  } else {
    yield* Effect.tryPromise(() =>
      expect(page.getByText("El agente alcanzó su límite diario.", { exact: false })).toBeVisible()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Mensaje", { exact: true })).toHaveValue(
        "¿Cuánto gasté en restaurantes este mes?"
      )
    );
  }
});

const frameCompactConfirmation = Effect.fnUntraced(function* (page: Page) {
  const summary = page.getByText(recurringReview, { exact: true });
  const pending = page.getByText("Confirmación pendiente", { exact: true });
  const confirm = page.getByRole("button", { name: "Confirmar cambio", exact: true });
  yield* Effect.tryPromise(() => confirm.scrollIntoViewIfNeeded());
  yield* Effect.tryPromise(() => expect(confirm).toBeInViewport({ ratio: 1 }));
  yield* Effect.tryPromise(() => pending.scrollIntoViewIfNeeded());
  yield* Effect.tryPromise(() =>
    summary.evaluate((element) => element.scrollIntoView({ block: "start" }))
  );
  yield* Effect.tryPromise(() => expect(summary).toBeInViewport({ ratio: 1 }));
  yield* Effect.tryPromise(() => expect(pending).toBeInViewport({ ratio: 1 }));
});

const waitForFonts = (): Promise<void> => document.fonts.ready.then(() => undefined);
const dimensions = (): Readonly<{ content: number; viewport: number }> => ({
  content: document.documentElement.scrollWidth,
  viewport: document.documentElement.clientWidth,
});
const capture = Effect.fnUntraced(function* (page: Page, filename: string) {
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
  for (const locator of [
    page.getByLabel("Mensaje", { exact: true }),
    page.getByRole("button", { name: "Cerrar chat", exact: true }),
    page.getByRole("button", { name: "Enviar", exact: true }),
  ]) {
    yield* Effect.tryPromise(() => expect(locator).toBeInViewport());
  }
});

for (const { viewport, scenarios } of cases) {
  for (const theme of themes) {
    for (const scenario of scenarios) {
      test(`chat ${scenario} is accessible and keeps its composer visible in ${theme} ${viewport.name}`, ({
        page,
      }) =>
        Effect.runPromise(
          Effect.gen(function* () {
            yield* Effect.tryPromise(() => page.setViewportSize(viewport));
            yield* Effect.tryPromise(() => page.emulateMedia({ colorScheme: theme }));
            yield* Effect.tryPromise(() =>
              page.clock.install({
                time: DateTime.toDateUtc(DateTime.makeUnsafe("2026-10-25T14:00:00Z")),
              })
            );
            const observed = yield* installChatScenario(page, scenario);
            yield* prepare(page, scenario);
            if (viewport.name === "landscape" && scenario === "confirmation") {
              yield* frameCompactConfirmation(page);
            }
            yield* capture(page, `${scenario}-${theme}-${viewport.name}`);
            expect(observed.mutations).toEqual([]);
            expect(observed.missingReads).toEqual([]);
            if (scenario === "confirmation") {
              yield* Effect.tryPromise(() =>
                page.getByRole("button", { name: "Confirmar cambio", exact: true }).click()
              );
              yield* Effect.tryPromise(() =>
                expect(page.getByText("Cambio confirmado.", { exact: true })).toBeVisible()
              );
              expect(observed.submissions).toEqual([
                { text: "Quiero pausar Netflix en mis recurrentes." },
                { text: confirmationCommand },
              ]);
            }
          })
        ));
    }
  }
}

test("chat suggestions remain drafts across dismissal and theme changes until explicitly sent", ({
  page,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const observed = yield* installChatScenario(page, "start");
      yield* prepare(page, "start");
      for (const suggestion of [
        "Revisar mis gastos",
        "Ver mis presupuestos",
        "Consultar recurrentes",
      ]) {
        yield* Effect.tryPromise(() =>
          page.getByRole("button", { name: suggestion, exact: true }).click()
        );
        yield* Effect.tryPromise(() =>
          expect(page.getByLabel("Mensaje", { exact: true })).toHaveValue(suggestion)
        );
        expect(observed.submissions).toEqual([]);
      }
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Cerrar chat", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Abrir agente Fidy", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Mensaje", { exact: true })).toHaveValue("Consultar recurrentes")
      );
      const panel = page.getByRole("dialog", { name: "Agente Fidy", exact: true });
      yield* Effect.tryPromise(() =>
        panel.getByRole("button", { name: /Activar tema (claro|oscuro)/u }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Mensaje", { exact: true })).toHaveValue("Consultar recurrentes")
      );
      expect(observed.submissions).toEqual([]);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Enviar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Mensaje", { exact: true })).toHaveValue("")
      );
      expect(observed.submissions).toEqual([{ text: "Consultar recurrentes" }]);
      expect(observed.mutations).toEqual([]);
    })
  ));
