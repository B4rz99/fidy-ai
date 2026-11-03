import type { APIRequestContext, Page, Route } from "@playwright/test";
import { Effect } from "effect";
import { apiOrigin } from "./http-fixtures";
import {
  boundSessionRequests,
  probeCanonicalRequest,
  signInRecurringThroughCore,
} from "./real-core-fixture";
import { playwright } from "./playwright-runtime";

const { test } = playwright;
const expect = playwright.expect.configure({ timeout: 20000 });
const createdStatus = 201;
const unavailableStatus = 503;
const maximumNameLength = 120;
const futurePlanName = "X".repeat(maximumNameLength);
const focusDelayMilliseconds = 6000;
const mobileViewport = { width: 390, height: 844 };
test("explains source fulfillment and lets a separate pending plan start next month", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInRecurringThroughCore({
          page,
          request,
          identity: "recurringCreation",
          deferFreshEntry: true,
        })
      );
      yield* Effect.tryPromise(() => captureIncome(page));
      yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-10"));
      yield* Effect.tryPromise(() => selectSource(page, "Ingreso original"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("dialog")).toContainText(
          "Seleccionar una transacción copia sus datos"
        )
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Guardar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("dialog")).toContainText(
          "La transacción seleccionada completa la primera ocurrencia"
        )
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Listo", exact: true }).click()
      );
      yield* Effect.tryPromise(() => selectSource(page, "Ingreso separado"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Guardar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => inspectPendingPlan(page));
      yield* Effect.tryPromise(() => changeFirstDate(page));
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("region", { name: "Ingresos", exact: true })).toContainText(
          "80.000,00"
        )
      );
      const history = yield* probeCanonicalRequest({
        request: page.request,
        send: () => boundSessionRequests(page.request).get(`${apiOrigin}/transactions`),
      });
      expect(yield* Effect.tryPromise(() => history.json())).toMatchObject({
        data: [expect.objectContaining({ money: { amount: "80000", currency: "COP" } })],
      });
    })
  ));

test("verifies edited source values in their first month after a failed read", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInRecurringThroughCore({
          page,
          request,
          identity: "recurringCreationReview",
          deferFreshEntry: true,
        })
      );
      yield* Effect.tryPromise(() => page.setViewportSize(mobileViewport));
      yield* Effect.tryPromise(() => captureIncome(page));
      yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-10"));
      yield* Effect.tryPromise(() => selectSource(page, futurePlanName));
      yield* Effect.tryPromise(() => page.getByLabel("Importe", { exact: true }).fill("90000"));
      yield* Effect.tryPromise(() => chooseNovember(page));
      const firstMonth = /\/recurring-plans\?month=2026-11(?:&|$)/u;
      yield* Effect.tryPromise(() => page.route(firstMonth, unavailableRead));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Guardar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => inspectUnverifiedPlan(page));
      yield* Effect.tryPromise(() => page.unroute(firstMonth, unavailableRead));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Verificar vínculo", exact: true }).click()
      );
      yield* Effect.tryPromise(() => inspectFuturePlan(page));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Listo", exact: true }).click()
      );
      yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-11"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("region", { name: "Ingresos", exact: true })).toContainText(
          "90.000,00"
        )
      );
    })
  ));

const unavailableRead = (route: Route): Promise<void> =>
  route.fulfill({ status: unavailableStatus, contentType: "application/json", body: "{}" });
const chooseNovember = (page: Page): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: /^Primera fecha:/u }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Ir al mes siguiente", exact: true }).click()
      );
      yield* Effect.tryPromise(() => page.locator('[data-day="2026-11-15"] button').click());
    })
  );

test("keeps a dismissed creation closed when its completion read arrives", ({ page, request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        startCreation({ page, request, identity: "recurringCreationClosed", name: "Ingreso lento" })
      );
      const delayed = yield* Effect.tryPromise(() => holdWorkspace(page));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Guardar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => delayed.started);
      yield* Effect.tryPromise(() =>
        page.getByRole("dialog").getByRole("button", { name: "Cerrar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => delayed.finish());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Nuevo recurrente", exact: true })).toBeEnabled()
      );
      yield* Effect.tryPromise(() => page.evaluate(settleDisplay));
      yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toHaveCount(0));
    })
  ));

test("preserves an unsaved first-date correction during background verification", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        startCreation({
          page,
          request,
          identity: "recurringCreationDraft",
          name: "Ingreso por ajustar",
        })
      );
      yield* Effect.tryPromise(() => page.getByLabel("Importe", { exact: true }).fill("90000"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Guardar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => inspectDraftRefresh(page));
    })
  ));

test("reviews the first generated occurrence when twice-monthly days start next month", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        startCreation({
          page,
          request,
          identity: "recurringCreationSchedule",
          name: "Ingreso quincenal",
        })
      );
      yield* Effect.tryPromise(() => page.getByRole("button", { name: /^Frecuencia:/u }).click());
      yield* Effect.tryPromise(() =>
        page.getByRole("menuitemradio", { name: "Dos veces al mes", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByLabel("Primer día del mes", { exact: true }).fill("1")
      );
      yield* Effect.tryPromise(() =>
        page.getByLabel("Segundo día (o último)", { exact: true }).fill("10")
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Guardar", exact: true }).click()
      );
      const result = page.getByRole("dialog", { name: "Recurrente guardado", exact: true });
      yield* Effect.tryPromise(() =>
        expect(result).toContainText("La transacción solo se usó para copiar los datos")
      );
      yield* Effect.tryPromise(() =>
        expect(result).toContainText("COP 80.000,00 adicionales para 2026-11-01")
      );
      yield* Effect.tryPromise(() =>
        expect(
          result.getByRole("button", { name: "Cambiar primera fecha", exact: true })
        ).toBeEnabled()
      );
      yield* Effect.tryPromise(() => inspectDraftRefresh(page));
    })
  ));

type CreationStart = Readonly<{
  page: Page;
  request: APIRequestContext;
  name: string;
  identity: "recurringCreationClosed" | "recurringCreationDraft" | "recurringCreationSchedule";
}>;
const startCreation = ({ page, request, identity, name }: CreationStart): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInRecurringThroughCore({ page, request, identity, deferFreshEntry: true })
      );
      yield* Effect.tryPromise(() => captureIncome(page));
      yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-10"));
      yield* Effect.tryPromise(() => selectSource(page, name));
    })
  );
type WorkspaceDelay = Readonly<{ started: Promise<void>; finish: () => Promise<void> }>;
const holdWorkspace = (page: Page): Promise<WorkspaceDelay> => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const pattern = "**/recurring-plans?**";
  const pending: Array<Promise<void>> = [];
  const hold = (route: Route): Promise<void> => {
    const completion = route.fetch().then((response) => {
      started.resolve();
      return release.promise.then(() => route.fulfill({ response }));
    });
    pending.push(completion);
    return completion;
  };
  return page.route(pattern, hold).then(() => ({
    started: started.promise,
    finish: (): Promise<void> => {
      release.resolve();
      return Promise.all(pending).then(() => page.unroute(pattern, hold));
    },
  }));
};
const settleDisplay = (): Promise<void> => {
  const settled = Promise.withResolvers<void>();
  requestAnimationFrame(() => requestAnimationFrame(() => settled.resolve()));
  return settled.promise;
};

const selectSource = (page: Page, name: string): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Nuevo recurrente", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByText("Crear desde una transacción", { exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: /Ingreso de prueba/u }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Usar esta transacción", exact: true }).click()
      );
      yield* Effect.tryPromise(() => page.getByLabel("Nombre", { exact: true }).fill(name));
    })
  );

const captureIncome = (page: Page): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const bound = boundSessionRequests(page.request);
      const captured = yield* probeCanonicalRequest({
        request: page.request,
        send: () =>
          bound.post(`${apiOrigin}/transactions`, {
            data: {
              money: { amount: "80000", currency: "COP" },
              direction: "inflow",
              counterparty: "Ingreso de prueba",
              categoryId: "10000000-0000-4000-8000-000000000001",
              occurredAt: "2026-10-15T12:00:00.000Z",
            },
          }),
      });
      expect(captured.status()).toBe(createdStatus);
    })
  );

const changeFirstDate = (page: Page): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Cambiar primera fecha", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: /^Primera fecha:/u }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Ir al mes siguiente", exact: true }).click()
      );
      yield* Effect.tryPromise(() => page.locator('[data-day="2026-11-15"] button').click());
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Guardar", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toHaveCount(0));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("region", { name: "Ingresos", exact: true })).not.toContainText(
          "160.000,00"
        )
      );
    })
  );

const inspectPendingPlan = (page: Page): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const result = page.getByRole("dialog");
      yield* Effect.tryPromise(() =>
        expect(
          result.getByRole("heading", { name: "Recurrente guardado", exact: true })
        ).toBeInViewport()
      );
      yield* Effect.tryPromise(() =>
        expect(result).toContainText("La transacción solo se usó para copiar los datos")
      );
      yield* Effect.tryPromise(() => expect(result).toContainText("Ingreso original · 2026-10-15"));
      yield* Effect.tryPromise(() => expect(result).toContainText("COP 80.000,00 adicionales"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("region", { name: "Ingresos", exact: true })).toContainText(
          "160.000,00"
        )
      );
      yield* Effect.tryPromise(() =>
        expect(result.getByRole("heading", { name: /Ingreso separado/u })).toBeInViewport()
      );
      yield* Effect.tryPromise(() =>
        page.screenshot({ path: test.info().outputPath("creation-pending.png") })
      );
    })
  );

const inspectFuturePlan = (page: Page): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const result = page.getByRole("dialog", { name: "Recurrente guardado", exact: true });
      yield* Effect.tryPromise(() =>
        expect(result).toContainText("La transacción solo se usó para copiar los datos")
      );
      yield* Effect.tryPromise(() =>
        expect(result).toContainText("No se encontró una coincidencia automática única")
      );
      yield* Effect.tryPromise(() =>
        expect(result).toContainText("COP 90.000,00 adicionales para 2026-11-15")
      );
      yield* Effect.tryPromise(() =>
        expect(
          result.getByRole("heading", { name: `${futurePlanName} · 2026-11-15`, exact: true })
        ).toBeInViewport()
      );
      yield* Effect.tryPromise(() =>
        expect(
          result.evaluate((element) => element.scrollWidth <= element.clientWidth)
        ).resolves.toBe(true)
      );
      yield* Effect.tryPromise(() =>
        page.screenshot({ path: test.info().outputPath("creation-mobile.png") })
      );
    })
  );

const inspectUnverifiedPlan = (page: Page): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const result = page.getByRole("dialog", { name: "Recurrente guardado", exact: true });
      yield* Effect.tryPromise(() =>
        expect(result).toContainText("El recurrente se guardó. Falta verificar")
      );
      yield* Effect.tryPromise(() =>
        expect(result).not.toContainText("La transacción solo se usó")
      );
      yield* Effect.tryPromise(() =>
        expect(result.getByText(/El recurrente se guardó. Falta verificar/u)).toBeFocused()
      );
    })
  );

const focusWorkspace = (): boolean => window.dispatchEvent(new Event("visibilitychange"));

const inspectDraftRefresh = (page: Page): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Cambiar primera fecha", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByLabel("Nombre", { exact: true }).fill("Mi corrección pendiente")
      );
      const delayed = yield* Effect.tryPromise(() => holdWorkspace(page));
      yield* Effect.tryPromise(() => page.clock.fastForward(focusDelayMilliseconds));
      yield* Effect.tryPromise(() => page.evaluate(focusWorkspace));
      yield* Effect.tryPromise(() => delayed.started);
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Nombre", { exact: true })).toHaveValue("Mi corrección pendiente")
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Guardar", exact: true })).toBeDisabled()
      );
      yield* Effect.tryPromise(() => delayed.finish());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Guardar", exact: true })).toBeEnabled()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByLabel("Nombre", { exact: true })).toHaveValue("Mi corrección pendiente")
      );
    })
  );
