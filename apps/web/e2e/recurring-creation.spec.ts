import type { Page, Route } from "@playwright/test";
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
      yield* Effect.tryPromise(() => selectSource(page, "Ingreso futuro"));
      yield* Effect.tryPromise(() => page.getByLabel("Importe", { exact: true }).fill("90000"));
      yield* Effect.tryPromise(() => chooseNovember(page));
      const firstMonth = /\/recurring-plans\?month=2026-11(?:&|$)/u;
      yield* Effect.tryPromise(() => page.route(firstMonth, unavailableRead));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Guardar", exact: true }).click()
      );
      const result = page.getByRole("dialog", { name: "Recurrente guardado", exact: true });
      yield* Effect.tryPromise(() =>
        expect(result).toContainText("El recurrente se guardó. Falta verificar")
      );
      yield* Effect.tryPromise(() =>
        expect(result).not.toContainText("La transacción solo se usó")
      );
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
        expect(result.getByRole("heading", { name: /Ingreso futuro/u })).toBeInViewport()
      );
      yield* Effect.tryPromise(() =>
        page.screenshot({ path: test.info().outputPath("creation-mobile.png") })
      );
    })
  );
