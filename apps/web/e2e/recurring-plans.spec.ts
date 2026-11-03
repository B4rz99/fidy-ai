import { analyzeAccessibility } from "./accessibility";
import type { APIRequestContext, Page, Route } from "@playwright/test";
import { type Cause, DateTime, Effect } from "effect";
import {
  boundSessionRequests,
  probeCanonicalRequest,
  signInRecurringThroughCore,
} from "./real-core-fixture";
import { apiOrigin } from "./http-fixtures";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;
const successStatus = 200;
const createdStatus = 201;
const invalidStatus = 400;
const paymentJourneyMilliseconds = 60000;
const paymentAssertionMilliseconds = 20000;
const expectPayment = expect.configure({ timeout: paymentAssertionMilliseconds });
test.describe.configure({ mode: "parallel", timeout: paymentJourneyMilliseconds });
const rateLimitedStatus = 429;
const monthsPerYear = 12;
const desktopLifecycleWidth = 1506;
const mobileLifecycleWidth = 390;
const searchPageSize = 20;
const maximumSearchDraftLength = 80;
test("recurring plans persist through the real canonical API and share monthly list/calendar items", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInRecurringThroughCore({ page, deferFreshEntry: true, request, identity: "recurring" })
      );
      yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-10"));
      yield* createPlan({
        page,
        name: "Arriendo de prueba",
        kind: "expense",
        currency: "COP",
        amount: "1000000",
      });
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Calendario", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: /Arriendo de prueba/u }).first()).toBeVisible()
      );
      yield* expectCalendarItemFits(page);
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        recurringItem(page, /Arriendo de prueba/u)
          .first()
          .click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("dialog")).toContainText(
          "No crea una transacción ni modifica tus gastos o presupuestos."
        )
      );
      yield* Effect.tryPromise(() =>
        page.getByLabel("Importe real", { exact: true }).fill("400000")
      );
      yield* Effect.tryPromise(() => chooseDate(page, "Fecha real", "2026-10-30"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Marcar solo en recurrentes", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(recurringItem(page, /Arriendo de prueba.*Parcial/u).first()).toBeVisible()
      );
      yield* inspectTrackingNotice(page);
      yield* inspectEditorSelection(page);
      yield* inspectMobile(page);
    })
  ));

const inspectTrackingNotice = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      recurringItem(page, /Arriendo de prueba/u)
        .first()
        .click()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("dialog")).toContainText("Sin transacción vinculada")
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Cerrar", exact: true }).click()
    );
    yield* Effect.tryPromise(() => page.reload());
    yield* Effect.tryPromise(() =>
      expect(recurringItem(page, /Arriendo de prueba.*Parcial/u).first()).toBeVisible()
    );
  });

type PlanDraft = Readonly<{
  page: Page;
  name: string;
  kind: string;
  currency: string;
  amount: string;
}>;
const inspectEditorSelection = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => page.setViewportSize({ width: 1506, height: 900 }));
    yield* createPlan({
      page,
      name: "Segundo plan de prueba",
      kind: "expense",
      currency: "COP",
      amount: "200",
    });
    yield* Effect.tryPromise(() =>
      recurringItem(page, /Arriendo de prueba/u)
        .first()
        .click()
    );
    yield* Effect.tryPromise(() => page.getByLabel("Importe real", { exact: true }).fill("9"));
    yield* Effect.tryPromise(() =>
      recurringItem(page, /Segundo plan de prueba/u)
        .first()
        .click()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Importe real", { exact: true })).toHaveValue("200")
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Cerrar", exact: true }).click()
    );
    yield* inspectPlanSelection(page);
  });

const inspectPlanSelection = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Administrar", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Editar Arriendo de prueba", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      page.getByLabel("Nombre", { exact: true }).fill("Borrador anterior")
    );
    yield* Effect.tryPromise(() => page.getByLabel("Importe", { exact: true }).fill("9"));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Editar Segundo plan de prueba", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Nombre", { exact: true })).toHaveValue("Segundo plan de prueba")
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Importe", { exact: true })).toHaveValue("200")
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Guardar", exact: true }).click()
    );
    yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toHaveCount(0));
    yield* Effect.tryPromise(() => page.reload());
    yield* Effect.tryPromise(() =>
      expect(recurringItem(page, /Segundo plan de prueba/u)).toContainText("200,00")
    );
    yield* Effect.tryPromise(() =>
      expect(recurringItem(page, /Arriendo de prueba/u)).toContainText("1.000.000,00")
    );
  });

const createPlan = (
  { page, name, kind, currency, amount }: PlanDraft,
  schedule: Readonly<{ frequency: string; firstDate: string }> = {
    frequency: "Cada mes",
    firstDate: "2026-10-31",
  }
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => page.getByRole("button", { name: "Nuevo recurrente" }).click());
    yield* Effect.tryPromise(() => page.getByLabel("Nombre", { exact: true }).fill(name));
    yield* Effect.tryPromise(() => chooseDate(page, "Primera fecha", schedule.firstDate));
    yield* Effect.tryPromise(() => chooseOption(page, "Frecuencia", schedule.frequency));
    yield* Effect.tryPromise(() =>
      chooseOption(
        page,
        "Tipo",
        { income: "Ingresos", transfer: "Transferencias", expense: "Gastos" }[kind] ?? "Gastos"
      )
    );
    yield* Effect.tryPromise(() => chooseCurrency(page, currency));
    if (amount !== "") {
      yield* Effect.tryPromise(() => chooseOption(page, "Tipo de importe", "Fijo"));
      yield* Effect.tryPromise(() => page.getByLabel("Importe", { exact: true }).fill(amount));
    }
    yield* Effect.tryPromise(() => page.getByRole("button", { name: "Guardar" }).click());
    yield* Effect.tryPromise(() =>
      expectPayment(recurringItem(page, new RegExp(name, "u")).first()).toBeVisible()
    );
  });
const checkUnknownTotals = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("region", { name: "Gastos", exact: true })).toContainText(
        "1 por confirmar"
      )
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("region", { name: "Gastos", exact: true })).not.toContainText(
        "previstos"
      )
    );
    yield* createPlan({
      page,
      name: "Gasto conocido",
      kind: "expense",
      currency: "COP",
      amount: "50",
    });
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("region", { name: "Gastos", exact: true })).toContainText(
        "1 por confirmar"
      )
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("region", { name: "Gastos", exact: true })).not.toContainText(
        "previstos"
      )
    );
  });

test("keeps income, transfers, unknown expenses and filtered summaries separate", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInRecurringThroughCore({
          page,
          deferFreshEntry: true,
          request,
          identity: "recurringSummary",
        })
      );
      yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-10"));
      yield* createPlan({
        page,
        name: "Honorarios",
        kind: "income",
        currency: "USD",
        amount: "20",
      });
      yield* createPlan({
        page,
        name: "Pago de tarjeta",
        kind: "transfer",
        currency: "COP",
        amount: "100",
      });
      yield* createPlan({
        page,
        name: "Internet variable",
        kind: "expense",
        currency: "COP",
        amount: "",
      });
      yield* checkUnknownTotals(page);
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("region", { name: "Transferencias", exact: true })).toContainText(
          "100,00"
        )
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("region", { name: "Ingresos", exact: true })).toContainText("USD")
      );
      yield* filterUsd(page);
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("region", { name: "Transferencias", exact: true })).toContainText(
          "Sin recurrentes"
        )
      );
      yield* Effect.tryPromise(() =>
        expect(recurringItem(page, /Pago de tarjeta/u)).toHaveCount(0)
      );
    })
  ));

const inspectMobile = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      page.screenshot({
        path: "/tmp/fidy-recurring-desktop.png",
        fullPage: true,
        animations: "disabled",
      })
    );
    yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
    yield* Effect.tryPromise(() =>
      recurringItem(page, /Arriendo de prueba.*Parcial/u)
        .first()
        .click()
    );
    yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toBeVisible());
    yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toHaveCSS("width", "390px"));
    yield* Effect.tryPromise(() =>
      page.screenshot({
        path: "/tmp/fidy-recurring-mobile.png",
        fullPage: true,
        animations: "disabled",
      })
    );
  });

test("keeps an uncertain save blocked across navigation until an explicit reread succeeds", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInRecurringThroughCore({
          page,
          deferFreshEntry: true,
          request,
          identity: "recurringEditing",
        })
      );
      yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-10"));
      yield* Effect.tryPromise(() => page.route("**/recurring-plans/edits", loseAcknowledgement));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Nuevo recurrente" }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByLabel("Nombre", { exact: true }).fill("Guardado sin respuesta")
      );
      yield* Effect.tryPromise(() => chooseDate(page, "Primera fecha", "2026-10-31"));
      yield* Effect.tryPromise(() => chooseCurrency(page, "USD"));
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Guardar" }).click());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toContainText("No pudimos confirmar si se guardó")
      );
      yield* Effect.tryPromise(() => page.keyboard.press("Escape"));
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Nuevo recurrente" })).toBeDisabled()
      );
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Mes siguiente" }).click());
      yield* Effect.tryPromise(() => expect(page).toHaveURL(/month=2026-11/u));
      yield* Effect.tryPromise(() =>
        expect(recurringItem(page, /Guardado sin respuesta/u)).toHaveCount(1)
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Nuevo recurrente" })).toBeDisabled()
      );
      yield* filterUsd(page);
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toContainText("No pudimos confirmar si se guardó")
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Nuevo recurrente" })).toBeDisabled()
      );
      yield* recoverUncertainSave(page);
    })
  ));

const recoverUncertainSave = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const workspaceRoute = `${apiOrigin}/recurring-plans?*`;
    const refuseReread = (route: Route): Promise<void> =>
      route.fulfill({
        status: rateLimitedStatus,
        contentType: "application/json",
        headers: { "retry-after": "3600" },
        body: '{"_tag":"ResourceLimited","error":{"code":"rate_limited","message":"Try again later.","retryAfterSeconds":3600},"next":[]}',
      });
    yield* Effect.tryPromise(() => page.route(workspaceRoute, refuseReread));
    yield* Effect.tryPromise(() =>
      Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().startsWith(`${apiOrigin}/recurring-plans?`) &&
            response.status() === rateLimitedStatus
        ),
        page.getByRole("button", { name: "Actualizar recurrentes" }).click(),
      ])
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Actualizar recurrentes" })).toBeEnabled()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("alert")).toContainText("No pudimos confirmar si se guardó")
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Nuevo recurrente" })).toBeDisabled()
    );
    yield* Effect.tryPromise(() => page.unroute(workspaceRoute, refuseReread));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Actualizar recurrentes" }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(recurringItem(page, /Guardado sin respuesta/u)).toHaveCount(1)
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Nuevo recurrente" })).toBeEnabled()
    );
    yield* Effect.tryPromise(() => expect(page.getByRole("alert")).toHaveCount(0));
  });

const loseAcknowledgement = (route: Route): Promise<void> =>
  route.request().method() === "POST"
    ? route.fetch().then((response) => {
        if (response.status() === rateLimitedStatus) return route.fulfill({ response });
        return response.text().then((body) => {
          expect(response.status(), body).toBe(successStatus);
          return route.abort("failed");
        });
      })
    : route.continue();

const expectCalendarItemFits = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    page
      .getByRole("button", { name: /Arriendo de prueba/u })
      .first()
      .evaluate((element) => {
        const cell = element.closest("section");
        if (cell === null) return false;
        const outer = cell.getBoundingClientRect();
        return [element, ...element.querySelectorAll("span")].every((content) => {
          const inner = content.getBoundingClientRect();
          return (
            inner.left >= outer.left && inner.right <= outer.right && inner.bottom <= outer.bottom
          );
        });
      })
      .then((fits) => {
        expect(fits).toBe(true);
      })
  );

const filterUsd = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => page.getByText("Filtros", { exact: true }).click());
    yield* Effect.tryPromise(() =>
      page.getByRole("combobox", { name: "Filtrar moneda", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("combobox", { name: "Buscar: Filtrar moneda", exact: true }).fill("USD")
    );
    yield* Effect.tryPromise(() => page.getByRole("option", { name: "USD", exact: true }).click());
    yield* Effect.tryPromise(() => page.getByRole("button", { name: "Aplicar filtros" }).click());
  });

const recurringItem = (page: Page, name: RegExp): ReturnType<Page["getByRole"]> =>
  page
    .getByRole("row", { name })
    .or(page.getByRole("button", { name: new RegExp(`^(?:${name.source})`, "u") }));
const chooseOption = (page: Page, label: string, option: string): Promise<void> =>
  page
    .getByRole("button", { name: new RegExp(`^${RegExp.escape(label)}:`, "u") })
    .click()
    .then(() => page.getByRole("menuitemradio", { name: option, exact: true }).click());
const chooseCurrency = (page: Page, currency: string): Promise<void> =>
  page
    .getByRole("combobox", { name: "Moneda", exact: true })
    .click()
    .then(() => page.getByRole("combobox", { name: "Buscar: Moneda", exact: true }).fill(currency))
    .then(() => page.getByRole("option", { name: currency, exact: true }).click());
const chooseDate = (page: Page, label: string, date: string): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const trigger = page.getByRole("button", {
        name: new RegExp(`^${RegExp.escape(label)}:`, "u"),
      });
      const selected = yield* Effect.tryPromise(() => trigger.innerText());
      const [, month = 0, year = 0] = selected.split("-").map(Number);
      const [targetYear = 0, targetMonth = 0] = date.split("-").map(Number);
      const steps = (targetYear - year) * monthsPerYear + targetMonth - month;
      yield* Effect.tryPromise(() => trigger.click());
      const selectedDay = page.locator('[data-selected-single="true"]');
      yield* Effect.tryPromise(() =>
        expect(selectedDay).toHaveCSS("background-color", "rgb(240, 180, 174)")
      );
      yield* Effect.tryPromise(() =>
        expect(selectedDay.locator("..")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
      );
      for (let step = 0; step < Math.abs(steps); step++) {
        yield* Effect.tryPromise(() =>
          page
            .getByRole("button", {
              name: steps > 0 ? "Ir al mes siguiente" : "Ir al mes anterior",
              exact: true,
            })
            .click()
        );
      }
      yield* Effect.tryPromise(() => page.locator(`[data-day="${date}"] button`).click());
    })
  );

test("manual tracking can be reversed and skipped", ({ page, request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInRecurringThroughCore({
          page,
          deferFreshEntry: true,
          request,
          identity: "recurringTracking",
        })
      );
      yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-10"));
      yield* createPlan({
        page,
        name: "Ciclo de seguimiento",
        kind: "expense",
        currency: "COP",
        amount: "100",
      });
      yield* Effect.tryPromise(() => recurringItem(page, /Ciclo de seguimiento/u).click());
      yield* Effect.tryPromise(() => page.getByLabel("Importe real", { exact: true }).fill("40"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Marcar solo en recurrentes", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(recurringItem(page, /Ciclo de seguimiento.*Parcial/u)).toBeVisible()
      );
      yield* Effect.tryPromise(() => recurringItem(page, /Ciclo de seguimiento/u).click());
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Revertir", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(recurringItem(page, /Ciclo de seguimiento.*Parcial/u)).toHaveCount(0)
      );
      yield* changeOccurrence(page, "Omitir esta vez");
      yield* Effect.tryPromise(() =>
        expect(recurringItem(page, /Ciclo de seguimiento.*Omitido/u)).toBeVisible()
      );
      yield* changeOccurrence(page, "Volver a incluir");
      yield* Effect.tryPromise(() =>
        expect(recurringItem(page, /Ciclo de seguimiento.*Omitido/u)).toHaveCount(0)
      );
    })
  ));

test("pause, resume and stop survive reload", ({ page, request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInRecurringThroughCore({
          page,
          deferFreshEntry: true,
          request,
          identity: "recurringLifecycle",
        })
      );
      // Pause and stop preserve historical occurrences; inspect a future month instead.
      const month = DateTime.formatIsoDate(
        DateTime.add(DateTime.startOf(DateTime.nowUnsafe(), "month"), { months: 1 })
      ).slice(0, "2026-01".length);
      yield* Effect.tryPromise(() => page.goto(`/app/recurring?month=${month}`));
      yield* createPlan({
        page,
        name: "Ciclo de seguimiento",
        kind: "expense",
        currency: "COP",
        amount: "100",
      });
      yield* Effect.tryPromise(() => recurringItem(page, /Ciclo de seguimiento/u).click());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("region", { name: "Estado del plan", exact: true })).toContainText(
          "Activo"
        )
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Reanudar plan", exact: true })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Pausar plan", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("status")).toContainText("Ciclo de seguimiento está pausado")
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Cerrar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(recurringItem(page, /Ciclo de seguimiento/u)).toHaveCount(0)
      );
      yield* verifyPlanLifecycle(page);
      yield* inspectPartialLifecycle(page);
      yield* inspectAnnualLifecycle(page);
    })
  ));

const changeOccurrence = (page: Page, action: string): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => recurringItem(page, /Ciclo de seguimiento/u).click());
    yield* Effect.tryPromise(() => page.getByRole("button", { name: action, exact: true }).click());
    yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toHaveCount(0));
  });

const inspectManagedLifecycle = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Editar Ciclo de seguimiento", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("region", { name: "Estado del plan", exact: true })).toContainText(
        "Activo"
      )
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Pausar plan", exact: true })).toBeEnabled()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Reanudar plan", exact: true })).toHaveCount(0)
    );
    yield* Effect.tryPromise(() =>
      page.getByLabel("Nombre", { exact: true }).fill("Borrador sin guardar")
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Pausar plan", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Reanudar plan", exact: true })).toBeEnabled()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Nombre", { exact: true })).toHaveValue("Borrador sin guardar")
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Reanudar plan", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Pausar plan", exact: true })).toBeEnabled()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Nombre", { exact: true })).toHaveValue("Borrador sin guardar")
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Cerrar", exact: true }).click()
    );
  });

const verifyPlanLifecycle = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => page.reload());
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Todos los recurrentes", exact: true }).click()
    );
    const plan = page.getByRole("button", { name: "Editar Ciclo de seguimiento", exact: true });
    yield* Effect.tryPromise(() => expect(plan).toContainText("Pausado"));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Reanudar", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("status")).toContainText("Ciclo de seguimiento está activo")
    );
    yield* Effect.tryPromise(() => expect(plan).toContainText("Activo"));
    yield* inspectManagedLifecycle(page);
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Mensual", exact: true }).click()
    );
    yield* Effect.tryPromise(() => recurringItem(page, /Ciclo de seguimiento/u).click());
    yield* Effect.tryPromise(() => page.getByText("Dejar de seguir", { exact: true }).click());
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("dialog")).toContainText("No cancela el servicio")
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Confirmar dejar de seguir", exact: true }).click()
    );
    yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toHaveCount(0));
    yield* Effect.tryPromise(() =>
      expect(recurringItem(page, /Ciclo de seguimiento/u)).toHaveCount(0)
    );
    yield* Effect.tryPromise(() => page.reload());
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Todos los recurrentes", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(
        page.getByRole("button", { name: "Editar Ciclo de seguimiento", exact: true })
      ).toContainText("Dejado de seguir")
    );
  });

const inspectPartialLifecycle = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const today = currentRecurringDate();
    yield* Effect.tryPromise(() =>
      page.goto(`/app/recurring?month=${today.slice(0, "2026-01".length)}`)
    );
    yield* Effect.tryPromise(() => page.setViewportSize({ width: 1506, height: 900 }));
    yield* createPlan(
      {
        page,
        name: "Internet QA",
        kind: "expense",
        currency: "COP",
        amount: "90000",
      },
      { frequency: "Cada mes", firstDate: today }
    );
    yield* Effect.tryPromise(() => recurringItem(page, /Internet QA/u).click());
    yield* Effect.tryPromise(() => page.getByLabel("Importe real", { exact: true }).fill("30000"));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Marcar solo en recurrentes", exact: true }).click()
    );
    for (const width of [desktopLifecycleWidth, mobileLifecycleWidth]) {
      yield* inspectPartialLayout(page, width);
    }
  });

const inspectPartialLayout = (page: Page, width: number): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => page.setViewportSize({ width, height: 900 }));
    yield* Effect.tryPromise(() => recurringItem(page, /Internet QA.*Parcial/u).click());
    yield* Effect.tryPromise(() =>
      page.route(`${apiOrigin}/recurring-plans?*`, rejectLifecycleReread)
    );
    yield* inspectLifecycleTransition({
      page,
      action: "Pausar plan",
      state: "Pausado",
      confirmation: "Internet QA está pausado",
    });
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("alert")).toContainText("Actualiza los recurrentes")
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Reanudar plan", exact: true })).toBeDisabled()
    );
    yield* Effect.tryPromise(() =>
      page.unroute(`${apiOrigin}/recurring-plans?*`, rejectLifecycleReread)
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Actualizar recurrentes", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Reanudar plan", exact: true })).toBeEnabled()
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Cerrar", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(recurringItem(page, /Internet QA.*Parcial/u)).toBeVisible()
    );
    yield* Effect.tryPromise(() => page.reload());
    yield* Effect.tryPromise(() => recurringItem(page, /Internet QA.*Parcial/u).click());
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("region", { name: "Estado del plan", exact: true })).toContainText(
        "Pausado"
      )
    );
    yield* inspectLifecycleTransition({
      page,
      action: "Reanudar plan",
      state: "Activo",
      confirmation: "Internet QA está activo",
    });
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Cerrar", exact: true }).click()
    );
    yield* Effect.tryPromise(() => page.reload());
  });

const rejectLifecycleReread = (route: Route): Promise<void> =>
  route.fulfill({
    status: rateLimitedStatus,
    contentType: "application/json",
    headers: { "retry-after": "3600" },
    body: '{"_tag":"ResourceLimited","error":{"code":"rate_limited","message":"Try again later.","retryAfterSeconds":3600},"next":[]}',
  });

const inspectAnnualLifecycle = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      page.setViewportSize({ width: desktopLifecycleWidth, height: 900 })
    );
    yield* createPlan(
      {
        page,
        name: "Plan anual QA",
        kind: "expense",
        currency: "COP",
        amount: "100",
      },
      { frequency: "Cada año", firstDate: currentRecurringDate() }
    );
    yield* Effect.tryPromise(() => recurringItem(page, /Plan anual QA/u).click());
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("region", { name: "Estado del plan", exact: true })).toContainText(
        "Activo"
      )
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Pausar plan", exact: true })).toBeEnabled()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Reanudar plan", exact: true })).toHaveCount(0)
    );
  });

const currentRecurringDate = (): string =>
  DateTime.formatIsoDate(
    DateTime.makeZonedUnsafe(DateTime.nowUnsafe(), { timeZone: "America/Bogota" })
  );

const inspectLifecycleTransition = ({
  page,
  action,
  state,
  confirmation,
}: Readonly<{ page: Page; action: string; state: string; confirmation: string }>): Effect.Effect<
  void,
  Cause.UnknownError
> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => page.getByRole("button", { name: action, exact: true }).click());
    yield* Effect.tryPromise(() => expect(page.getByRole("status")).toContainText(confirmation));
    const detail = page.getByRole("dialog");
    yield* Effect.tryPromise(() => expect(detail).toContainText("Parcial"));
    yield* Effect.tryPromise(() => expect(detail).toContainText("30.000,00"));
    yield* Effect.tryPromise(() =>
      expect(detail).toContainText("Los registros existentes se conservan")
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("region", { name: "Estado del plan", exact: true })).toContainText(
        state
      )
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: action, exact: true })).toHaveCount(0)
    );
    yield* Effect.tryPromise(() =>
      detail
        .evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return (
            bounds.left >= 0 &&
            bounds.right <= window.innerWidth &&
            element.scrollWidth <= element.clientWidth
          );
        })
        .then((fits) => expect(fits).toBe(true))
    );
  });

test("one-occurrence edits stay local and forward edits preserve earlier monthly history", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInRecurringThroughCore({
          page,
          deferFreshEntry: true,
          request,
          identity: "recurringExceptions",
        })
      );
      yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-10"));
      yield* createPlan({
        page,
        name: "Plan con excepciones",
        kind: "expense",
        currency: "COP",
        amount: "100",
      });
      yield* editExpectedPlan(page, {
        current: "Plan con excepciones",
        name: "Solo octubre",
        amount: "120",
        scope: "Solo esta vez",
      });
      yield* Effect.tryPromise(() =>
        expect(recurringItem(page, /Solo octubre/u)).toContainText("120,00")
      );
      yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-11"));
      yield* Effect.tryPromise(() =>
        expect(recurringItem(page, /Plan con excepciones/u)).toContainText("100,00")
      );
      yield* editExpectedPlan(page, {
        current: "Plan con excepciones",
        name: "Desde noviembre",
        amount: "150",
        scope: "Esta y próximas",
      });
      yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-12"));
      yield* Effect.tryPromise(() =>
        expect(recurringItem(page, /Desde noviembre/u)).toContainText("150,00")
      );
      yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-10"));
      yield* Effect.tryPromise(() =>
        expect(recurringItem(page, /Solo octubre/u)).toContainText("120,00")
      );
    })
  ));

const editExpectedPlan = (
  page: Page,
  {
    current,
    name,
    amount,
    scope,
  }: Readonly<{ current: string; name: string; amount: string; scope: string }>
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => recurringItem(page, new RegExp(current, "u")).click());
    yield* Effect.tryPromise(() => page.getByText("Editar recurrente", { exact: true }).click());
    yield* Effect.tryPromise(() => page.getByRole("button", { name: scope, exact: true }).click());
    yield* Effect.tryPromise(() => page.getByLabel("Nombre", { exact: true }).fill(name));
    yield* Effect.tryPromise(() => page.getByLabel("Importe", { exact: true }).fill(amount));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Guardar", exact: true }).click()
    );
    yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toHaveCount(0));
  });

const paymentCategory = "10000000-0000-4000-8000-000000000001";
const inspectPaymentHistory = ({
  request,
  count,
  spent,
}: Readonly<{
  request: APIRequestContext;
  count: number;
  spent: string;
}>): Effect.Effect<void, Cause.UnknownError | Cause.TimeoutError> =>
  Effect.gen(function* () {
    const bound = boundSessionRequests(request);
    const history = yield* probeCanonicalRequest({
      request,
      send: () => bound.get(`${apiOrigin}/transactions`),
    });
    expectPayment(history.status()).toBe(successStatus);
    const historyBody: unknown = yield* Effect.tryPromise(() => history.json());
    expectPayment(historyBody).toMatchObject({
      data:
        count === 0
          ? []
          : [expect.objectContaining({ money: { amount: "90000", currency: "COP" } })],
    });
    const report = yield* probeCanonicalRequest({
      request,
      send: () => bound.get(`${apiOrigin}/budget-status?month=2026-10&timeZone=America%2FBogota`),
    });
    expectPayment(report.status()).toBe(successStatus);
    const reportBody: unknown = yield* Effect.tryPromise(() => report.json());
    expectPayment(reportBody).toMatchObject({
      data: { statuses: [expect.objectContaining({ spent: { amount: spent, currency: "COP" } })] },
    });
  });

test("manual recurring tracking leaves financial totals unchanged and capturing its Transaction replaces the mark once", ({
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
          identity: "recurringCapture",
        })
      );
      yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-10"));
      yield* createPlan({
        page,
        name: "Internet aislado",
        kind: "expense",
        currency: "COP",
        amount: "90000",
      });
      yield* createPaymentBudget(page.request);
      yield* Effect.tryPromise(() => recurringItem(page, /Internet aislado/u).click());
      yield* Effect.tryPromise(() => chooseDate(page, "Fecha real", "2026-10-31"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Marcar solo en recurrentes", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expectPayment(recurringItem(page, /Internet aislado.*Completados/u)).toBeVisible()
      );
      yield* inspectPaymentHistory({ request: page.request, count: 0, spent: "0" });
      yield* Effect.tryPromise(() => recurringItem(page, /Internet aislado/u).click());
      yield* Effect.tryPromise(() =>
        expectPayment(page.getByRole("dialog")).toContainText("Sin transacción vinculada")
      );
      yield* captureMarkedPayment(page);
      yield* inspectPaymentHistory({ request: page.request, count: 1, spent: "90000" });
      yield* recoverCreatedLink(page);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Vincular transacción creada", exact: true }).click()
      );
      yield* Effect.tryPromise(() => expectPayment(page.getByRole("dialog")).toHaveCount(0));
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() => recurringItem(page, /Internet aislado/u).click());
      yield* Effect.tryPromise(() =>
        expectPayment(page.getByText("Sin transacción vinculada", { exact: true })).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expectPayment(page.getByRole("dialog")).toContainText(
          "Completado en recurrentes: COP 90.000,00"
        )
      );
      yield* inspectPaymentHistory({ request: page.request, count: 1, spent: "90000" });
      yield* inspectAndRemoveLinkedPayment(page);
    })
  ));

const recoverCreatedLink = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const editRoute = `${apiOrigin}/recurring-plans/edits`;
    const refuse = (route: Route): Promise<void> =>
      route.fulfill({
        status: invalidStatus,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "validation_failed",
            message: "Review the recurring payment.",
            fields: [],
          },
          next: [],
        }),
      });
    yield* Effect.tryPromise(() => page.route(editRoute, refuse));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Vincular transacción creada", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expectPayment(page.getByRole("alert")).toContainText("Actualiza los recurrentes")
    );
    yield* Effect.tryPromise(() => page.unroute(editRoute, refuse));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Actualizar recurrentes", exact: true }).click()
    );
    yield* Effect.tryPromise(() => expectPayment(page.getByRole("alert")).toHaveCount(0));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Cerrar", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Mes siguiente", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Mes anterior", exact: true }).click()
    );
    yield* Effect.tryPromise(() => recurringItem(page, /Internet aislado/u).click());
    yield* Effect.tryPromise(() =>
      page.getByText("Crear y vincular transacción", { exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expectPayment(
        page.getByText("Transacción creada. Falta vincularla al recurrente.", { exact: true })
      ).toBeVisible()
    );
    yield* Effect.tryPromise(() =>
      expectPayment(page.getByRole("button", { name: "Registrar", exact: true })).toHaveCount(0)
    );
    yield* repairCapturedReplacement(page);
  });

test("an uncertain recurring capture stays locked across panel and month changes and can link the existing Transaction", ({
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
          identity: "recurringCaptureUncertain",
        })
      );
      yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-10"));
      yield* createPlan({
        page,
        name: "Pago sin respuesta",
        kind: "expense",
        currency: "COP",
        amount: "90000",
      });
      yield* Effect.tryPromise(() => recurringItem(page, /Pago sin respuesta/u).click());
      yield* Effect.tryPromise(() =>
        page.getByText("Crear y vincular transacción", { exact: true }).click()
      );
      yield* nameUncertainCapture(page);
      yield* loseCapturedPayment(page);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Cerrar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Mes siguiente", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Mes anterior", exact: true }).click()
      );
      yield* Effect.tryPromise(() => recurringItem(page, /Pago sin respuesta/u).click());
      yield* Effect.tryPromise(() =>
        page.getByText("Crear y vincular transacción", { exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expectPayment(page.getByRole("button", { name: "Registrar", exact: true })).toBeDisabled()
      );
      yield* Effect.tryPromise(() =>
        page.getByText("Vincular transacción existente", { exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: /Revisar Pago sin respuesta/u }).click()
      );
      yield* confirmExistingLink(page);
      yield* inspectCapturedTransactions(page.request, [
        expect.objectContaining({ money: { amount: "90000", currency: "COP" } }),
      ]);
    })
  ));

const enlargeRecurringCaptureText = (): void => {
  document.documentElement.style.fontSize = "32px";
};
const resetRecurringCaptureText = (): void => {
  document.documentElement.style.fontSize = "";
};
const checkMobileCaptureText = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const viewport = page.viewportSize();
    yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
    const capture = page.getByRole("form", { name: "Registrar transacción" });
    const fields = [
      capture.getByLabel("Monto", { exact: true }),
      capture.getByLabel("Contraparte (opcional)", { exact: true }),
      capture.getByLabel("Notas (opcional)", { exact: true }),
    ];
    for (const field of fields) {
      yield* Effect.tryPromise(() => expectPayment(field).toHaveCSS("font-size", "16px"));
    }
    yield* Effect.tryPromise(() => page.evaluate(enlargeRecurringCaptureText));
    for (const field of fields) {
      yield* Effect.tryPromise(() => expectPayment(field).toHaveCSS("font-size", "32px"));
    }
    yield* Effect.tryPromise(() => page.evaluate(resetRecurringCaptureText));
    if (viewport !== null) {
      yield* Effect.tryPromise(() => page.setViewportSize(viewport));
    }
  });

test("capturing recurring income preserves its Currency and direction", ({ page, request }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* prepareIncomeCapture(page, request);
      const capture = page.getByRole("form", { name: "Registrar transacción" });
      yield* Effect.tryPromise(() =>
        expectPayment(capture.getByText("Moneda · USD", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expectPayment(capture.getByRole("combobox", { name: "Moneda", exact: true })).toHaveCount(0)
      );
      yield* checkMobileCaptureText(page);
      yield* Effect.tryPromise(() =>
        expectPayment(page.getByLabel("Monto", { exact: true })).toHaveValue("20,5")
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Registrar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expectPayment(page.getByText("Transacción vinculada.", { exact: true })).toBeVisible()
      );
      yield* Effect.tryPromise(() =>
        expectPayment(
          page.getByRole("button", { name: "Vincular transacción creada", exact: true })
        ).toHaveCount(0)
      );
      yield* Effect.tryPromise(() =>
        expectPayment(recurringItem(page, /Honorarios en USD.*Completados/u)).toBeVisible()
      );
      const bound = boundSessionRequests(page.request);
      const history = yield* probeCanonicalRequest({
        request: page.request,
        send: () => bound.get(`${apiOrigin}/transactions`),
      });
      expectPayment(history.status()).toBe(successStatus);
      const body: unknown = yield* Effect.tryPromise(() => history.json());
      expectPayment(body).toMatchObject({
        data: [
          expect.objectContaining({
            money: { amount: "20.5", currency: "USD" },
            direction: "inflow",
          }),
        ],
      });
    })
  ));

const captureMarkedPayment = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      page.getByText("Crear y vincular transacción", { exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expectPayment(page.getByLabel("Monto", { exact: true })).toHaveValue("90000")
    );
    yield* Effect.tryPromise(() => chooseOption(page, "Categoría", "Restaurantes"));
    yield* Effect.tryPromise(() =>
      page
        .getByRole("form", { name: "Registrar transacción" })
        .getByLabel("Contraparte (opcional)", { exact: true })
        .fill("Mercado QA")
    );
    yield* Effect.tryPromise(() =>
      page.getByLabel("Notas (opcional)", { exact: true }).fill("Compra de la semana")
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Registrar", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expectPayment(
        page.getByText("Transacción creada. Falta vincularla al recurrente.", { exact: true })
      ).toBeVisible()
    );
  });

const loseCapturedPayment = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const transactionRoute = `${apiOrigin}/transactions`;
    const loseCapture = (route: Route): Promise<void> =>
      route.request().method() === "POST"
        ? route.fetch().then((response) => {
            if (response.status() === rateLimitedStatus) return route.fulfill({ response });
            expectPayment(response.status()).toBe(createdStatus);
            return route.abort("failed");
          })
        : route.continue();
    yield* Effect.tryPromise(() => page.route(transactionRoute, loseCapture));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Registrar", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expectPayment(page.getByRole("alert")).toContainText(
        "No pudimos confirmar si la transacción se guardó"
      )
    );
    yield* Effect.tryPromise(() => page.unroute(transactionRoute, loseCapture));
  });

const createPaymentBudget = (
  request: APIRequestContext
): Effect.Effect<void, Cause.UnknownError | Cause.TimeoutError> =>
  Effect.gen(function* () {
    const bound = boundSessionRequests(request);
    const budget = yield* probeCanonicalRequest({
      request,
      send: () =>
        bound.post(`${apiOrigin}/budgets`, {
          data: {
            categoryId: paymentCategory,
            cap: { amount: "200000", currency: "COP" },
            month: "2026-10",
          },
        }),
    });
    expectPayment(budget.status()).toBe(createdStatus);
  });

const inspectCapturedTransactions = (
  request: APIRequestContext,
  expectedData: ReadonlyArray<unknown>
): Effect.Effect<void, Cause.UnknownError | Cause.TimeoutError> =>
  Effect.gen(function* () {
    const bound = boundSessionRequests(request);
    const history = yield* probeCanonicalRequest({
      request,
      send: () => bound.get(`${apiOrigin}/transactions`),
    });
    expectPayment(history.status()).toBe(successStatus);
    const body: unknown = yield* Effect.tryPromise(() => history.json());
    expectPayment(body).toMatchObject({ data: expectedData });
  });

const prepareIncomeCapture = (
  page: Page,
  request: APIRequestContext
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      signInRecurringThroughCore({
        page,
        request,
        deferFreshEntry: true,
        identity: "recurringCaptureCurrency",
      })
    );
    yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-10"));
    yield* createPlan({
      page,
      name: "Honorarios en USD",
      kind: "income",
      currency: "USD",
      amount: "20.5",
    });
    yield* Effect.tryPromise(() => recurringItem(page, /Honorarios en USD/u).click());
    yield* Effect.tryPromise(() => page.getByText("Editar recurrente", { exact: true }).click());
    yield* Effect.tryPromise(() =>
      page
        .getByRole("textbox", { name: "Contraparte (opcional)", exact: true })
        .fill("Honorarios USD")
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Guardar", exact: true }).click()
    );
    yield* Effect.tryPromise(() => expectPayment(page.getByRole("dialog")).toHaveCount(0));
    yield* Effect.tryPromise(() => recurringItem(page, /Honorarios en USD/u).click());
    yield* Effect.tryPromise(() =>
      page.getByText("Crear y vincular transacción", { exact: true }).click()
    );
  });

const nameUncertainCapture = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    page
      .getByRole("form", { name: "Registrar transacción" })
      .getByLabel("Contraparte (opcional)", { exact: true })
      .fill("Pago sin respuesta")
  );

test("recurring capture refuses incompatible manual marks and completes unknown payments across two Transactions", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* prepareSplitMarks(page, request);
      yield* captureSplitPayment(page, "40", false);
      yield* Effect.tryPromise(() => recurringItem(page, /Pago por partes.*Parcial/u).click());
      yield* inspectBlockedOccurrence(page);
      yield* editTrackedPlan(page);
      yield* Effect.tryPromise(() => recurringItem(page, /Pago por partes.*Parcial/u).click());
      yield* Effect.tryPromise(() =>
        page.getByText("Crear y vincular transacción", { exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Registrar otro pago o ingreso", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expectPayment(page.getByLabel("Monto", { exact: true })).toHaveValue("")
      );
      yield* captureSplitPayment(page, "60", true);
      yield* Effect.tryPromise(() =>
        expectPayment(recurringItem(page, /Pago por partes.*Completados/u)).toBeVisible()
      );
      yield* inspectSplitHistory(page.request);
      yield* correctTrackedOccurrence(page);
      yield* inspectSplitHistory(page.request);
      yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-11"));
      yield* Effect.tryPromise(() =>
        expectPayment(recurringItem(page, /Pago futuro/u)).toContainText("100,00")
      );
    })
  ));

const editTrackedPlan = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => page.getByText("Editar recurrente", { exact: true }).click());
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Esta y próximas", exact: true }).click()
    );
    yield* Effect.tryPromise(() => page.getByLabel("Nombre", { exact: true }).fill("Pago futuro"));
    yield* Effect.tryPromise(() => chooseOption(page, "Tipo de importe", "Fijo"));
    yield* Effect.tryPromise(() => page.getByLabel("Importe", { exact: true }).fill("100"));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Guardar", exact: true }).click()
    );
    yield* Effect.tryPromise(() => expectPayment(page.getByRole("dialog")).toHaveCount(0));
  });

const correctTrackedOccurrence = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => recurringItem(page, /Pago por partes/u).click());
    yield* unlinkTrackedTransaction(page);
    yield* Effect.tryPromise(() => expectPayment(page.getByRole("dialog")).toHaveCount(0));
    yield* Effect.tryPromise(() => recurringItem(page, /Pago por partes/u).click());
    yield* inspectBlockedOccurrence(page);
    yield* unlinkTrackedTransaction(page);
    yield* Effect.tryPromise(() => expectPayment(page.getByRole("dialog")).toHaveCount(0));
    yield* Effect.tryPromise(() => recurringItem(page, /Pago por partes/u).click());
    yield* Effect.tryPromise(() => page.getByText("Editar recurrente", { exact: true }).click());
    yield* Effect.tryPromise(() =>
      expect(
        page.getByRole("button", { name: "Solo esta vez", exact: true })
      ).toHaveAccessibleDescription(
        "Los cambios se aplican solo a esta fecha. Las próximas fechas conservan sus datos."
      )
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Revisar seguimiento", exact: true })).toHaveCount(0)
    );
    yield* Effect.tryPromise(() =>
      page.getByLabel("Nombre", { exact: true }).fill("Solo esta fecha")
    );
    yield* Effect.tryPromise(() => chooseOption(page, "Tipo de importe", "Fijo"));
    yield* Effect.tryPromise(() => page.getByLabel("Importe", { exact: true }).fill("120"));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Guardar", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expectPayment(recurringItem(page, /Solo esta fecha/u)).toContainText("120,00")
    );
  });

const inspectBlockedOccurrence = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => page.getByText("Editar recurrente", { exact: true }).click());
    const once = page.getByRole("button", { name: "Solo esta vez", exact: true });
    const forward = page.getByRole("button", { name: "Esta y próximas", exact: true });
    yield* Effect.tryPromise(() => expect(once).toHaveAttribute("aria-pressed", "true"));
    yield* Effect.tryPromise(() =>
      expect(once).toHaveAccessibleDescription(/Esta fecha ya tiene seguimiento registrado/u)
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByText(/Esta fecha ya tiene seguimiento registrado/u)).toBeVisible()
    );
    yield* Effect.tryPromise(() =>
      expect(once).toHaveAccessibleDescription(/no elimina transacciones ni revierte pagos reales/u)
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Guardar", exact: true })).toBeDisabled()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Nombre", { exact: true })).toBeDisabled()
    );
    yield* Effect.tryPromise(() => forward.click());
    yield* Effect.tryPromise(() =>
      expect(forward).toHaveAccessibleDescription(/Las fechas con seguimiento conservan sus datos/u)
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Guardar", exact: true })).toBeEnabled()
    );
    yield* Effect.tryPromise(() => once.click());
    yield* Effect.tryPromise(() => page.keyboard.press("Tab"));
    yield* Effect.tryPromise(() => page.keyboard.press("Tab"));
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Revisar seguimiento", exact: true })).toBeFocused()
    );
    yield* Effect.tryPromise(() => page.keyboard.press("Enter"));
    yield* Effect.tryPromise(() =>
      expect(
        page.getByRole("heading", { name: "Seguimiento de esta fecha", exact: true })
      ).toBeFocused()
    );
    const accessibility = yield* Effect.tryPromise(() => analyzeAccessibility(page));
    expect(accessibility.violations).toEqual([]);
    yield* Effect.tryPromise(() => page.getByText("Editar recurrente", { exact: true }).click());
  });

const markSplitPayment = (page: Page, amount: string): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => recurringItem(page, /Pago por partes/u).click());
    yield* Effect.tryPromise(() => page.getByLabel("Importe real", { exact: true }).fill(amount));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Marcar solo en recurrentes", exact: true }).click()
    );
    yield* Effect.tryPromise(() => expectPayment(page.getByRole("dialog")).toHaveCount(0));
  });

const prepareSplitMarks = (
  page: Page,
  request: APIRequestContext
): Effect.Effect<void, Cause.UnknownError | Cause.TimeoutError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      signInRecurringThroughCore({
        page,
        request,
        deferFreshEntry: true,
        identity: "recurringSplitCapture",
      })
    );
    yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-10"));
    yield* createPlan({
      page,
      name: "Pago por partes",
      kind: "expense",
      currency: "COP",
      amount: "",
    });
    yield* markSplitPayment(page, "40");
    yield* markSplitPayment(page, "60");
    yield* Effect.tryPromise(() => recurringItem(page, /Pago por partes/u).click());
    yield* Effect.tryPromise(() =>
      expectPayment(page.getByRole("dialog")).toContainText("Hay varias marcas manuales")
    );
    yield* inspectBlockedOccurrence(page);
    yield* Effect.tryPromise(() =>
      page.getByText("Crear y vincular transacción", { exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expectPayment(page.getByRole("button", { name: "Registrar", exact: true })).toBeDisabled()
    );
    yield* inspectCapturedTransactions(page.request, []);
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Revertir", exact: true }).last().click()
    );
    yield* Effect.tryPromise(() => expectPayment(page.getByRole("dialog")).toHaveCount(0));
    yield* Effect.tryPromise(() => recurringItem(page, /Pago por partes/u).click());
    yield* inspectBlockedOccurrence(page);
    yield* Effect.tryPromise(() =>
      page.getByText("Crear y vincular transacción", { exact: true }).click()
    );
  });

const captureSplitPayment = (
  page: Page,
  amount: string,
  complete: boolean
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => page.getByLabel("Monto", { exact: true }).fill(amount));
    yield* Effect.tryPromise(() =>
      chooseOption(
        page,
        "Estado de la transacción vinculada",
        complete ? "Pago o ingreso completo" : "Parcial"
      )
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Registrar", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expectPayment(
        page.getByText("Transacción creada. Falta vincularla al recurrente.", { exact: true })
      ).toBeVisible()
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Vincular transacción creada", exact: true }).click()
    );
    yield* Effect.tryPromise(() => expectPayment(page.getByRole("dialog")).toHaveCount(0));
  });

const inspectSplitHistory = (
  request: APIRequestContext
): Effect.Effect<void, Cause.UnknownError | Cause.TimeoutError> =>
  Effect.gen(function* () {
    const bound = boundSessionRequests(request);
    const response = yield* probeCanonicalRequest({
      request,
      send: () => bound.get(`${apiOrigin}/transactions`),
    });
    expectPayment(response.status()).toBe(successStatus);
    const body: unknown = yield* Effect.tryPromise(() => response.json());
    expectPayment(body).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({ money: { amount: "40", currency: "COP" } }),
        expect.objectContaining({ money: { amount: "60", currency: "COP" } }),
      ]),
    });
    expectPayment(body).toMatchObject({ data: [expect.anything(), expect.anything()] });
  });

const repairCapturedReplacement = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Revertir", exact: true }).click()
    );
    yield* Effect.tryPromise(() => expectPayment(page.getByRole("dialog")).toHaveCount(0));
    yield* Effect.tryPromise(() => recurringItem(page, /Internet aislado/u).click());
    yield* Effect.tryPromise(() =>
      page.getByText("Crear y vincular transacción", { exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expectPayment(page.getByRole("dialog")).toContainText("La marca seleccionada ya no existe")
    );
    yield* Effect.tryPromise(() =>
      expectPayment(
        page.getByRole("button", { name: "Vincular transacción creada", exact: true })
      ).toBeDisabled()
    );
    yield* Effect.tryPromise(() => chooseOption(page, "Marca manual que reemplaza", "Ninguno"));
    yield* Effect.tryPromise(() =>
      expectPayment(
        page.getByRole("button", { name: "Vincular transacción creada", exact: true })
      ).toBeEnabled()
    );
  });

test("finds and reviews an older recurring Transaction across 500 records before explicitly linking", ({
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
          identity: "recurringSearch",
        })
      );
      yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-10"));
      yield* createPlan({
        page,
        name: "Internet del hogar",
        kind: "expense",
        currency: "COP",
        amount: "89900",
      });
      yield* Effect.tryPromise(() => recurringItem(page, /Internet del hogar/u).click());
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Vincular transacción existente", exact: true }).click()
      );
      yield* inspectSearchRecovery(page);
      yield* Effect.tryPromise(() =>
        page.getByLabel("Importe exacto", { exact: true }).fill("45.000")
      );
      yield* Effect.tryPromise(() =>
        page.getByLabel("Buscar transacción", { exact: true }).fill("Internet")
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Buscar", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expectPayment(page.getByRole("button", { name: /Revisar Internet antiguo/u })).toHaveCount(
          searchPageSize
        )
      );
      yield* inspectAppliedAmountScope(page);
      yield* inspectLastSearchResult(page);
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Ver más transacciones", exact: true }).click()
      );
      yield* Effect.tryPromise(() =>
        expectPayment(page.getByRole("button", { name: /Revisar Internet antiguo/u })).toHaveCount(
          4
        )
      );
      yield* reviewOlderTransaction(page);
      yield* inspectLargeReview(page);
    })
  ));
const inspectLargeReview = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Vincular transacción existente", exact: true }).click()
    );
    yield* inspectLongSearchScope(page);
    yield* Effect.tryPromise(() =>
      page.getByLabel("Buscar transacción", { exact: true }).fill("Importe extenso")
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Buscar", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: /Revisar Importe extenso/u }).click()
    );
    yield* Effect.tryPromise(() =>
      page.evaluate(() => {
        document.documentElement.style.fontSize = "200%";
      })
    );
    const dialog = page.getByRole("dialog");
    yield* Effect.tryPromise(() => expect(dialog).toContainText("9.007.199.254.740.993,15"));
    const noOverflow = (): Promise<boolean> =>
      dialog.evaluate((element) => element.scrollWidth <= element.clientWidth);
    yield* Effect.tryPromise(() => expect.poll(noOverflow).toBe(true));
    yield* Effect.tryPromise(() =>
      page.screenshot({ path: test.info().outputPath("transaction-link-large-mobile.png") })
    );
  });
const inspectLongSearchScope = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Limpiar filtros", exact: true }).click()
    );
    const query = "Y".repeat(maximumSearchDraftLength);
    yield* Effect.tryPromise(() =>
      page.getByLabel("Buscar transacción", { exact: true }).fill(query)
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Buscar", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("region", { name: "Resultados de transacciones" })).toContainText(query)
    );
    for (const size of ["100%", "200%"]) {
      yield* Effect.tryPromise(() =>
        page.evaluate((value) => {
          document.documentElement.style.fontSize = value;
        }, size)
      );
      const noOverflow = (): Promise<boolean> =>
        page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      yield* Effect.tryPromise(() => expect.poll(noOverflow).toBe(true));
    }
    yield* Effect.tryPromise(() =>
      page.evaluate(() => {
        document.documentElement.style.fontSize = "100%";
      })
    );
  });
const reviewOlderTransaction = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      page
        .getByRole("button", { name: /Revisar Internet antiguo/u })
        .first()
        .press("Enter")
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Vincular transacción", exact: true })).toBeVisible()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByText("Transacción vinculada", { exact: true })).toHaveCount(0)
    );
    yield* inspectLinkDesign(page);
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Vincular transacción", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expectPayment(recurringItem(page, /Internet del hogar.*Parcial/u)).toBeVisible()
    );
    yield* Effect.tryPromise(() => recurringItem(page, /Internet del hogar/u).click());
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("article", { name: /^Transacción vinculada:/u })).toHaveCount(1)
    );
  });

const confirmExistingLink = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Vincular transacción", exact: true }).click()
    );
    yield* Effect.tryPromise(() => expectPayment(page.getByRole("dialog")).toHaveCount(0));
  });

const inspectSearchRecovery = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const release = Promise.withResolvers<void>();
    const failedSearch = (route: Route): Promise<void> =>
      release.promise.then(() =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"error":{"code":"unavailable","message":"private-search-diagnostic"},"next":[]}',
        })
      );
    yield* Effect.tryPromise(() => page.route("**/transactions/search?**", failedSearch));
    yield* Effect.tryPromise(() =>
      page.getByLabel("Buscar transacción", { exact: true }).fill("Sin coincidencias")
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Buscar", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("status", { name: "Cargando transacciones" })).toBeVisible()
    );
    release.resolve();
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Reintentar transacciones" })).toBeVisible()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByLabel("Buscar transacción", { exact: true })).toHaveValue(
        "Sin coincidencias"
      )
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByText("private-search-diagnostic")).toHaveCount(0)
    );
    yield* Effect.tryPromise(() => page.unroute("**/transactions/search?**", failedSearch));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Reintentar transacciones" }).click()
    );
    yield* Effect.tryPromise(() =>
      expectPayment(
        page.getByText("Sin coincidencias. Prueba otra contraparte o amplía las fechas.", {
          exact: true,
        })
      ).toBeVisible()
    );
  });
const inspectLinkDesign = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => page.setViewportSize({ width: 1440, height: 1000 }));
    yield* Effect.tryPromise(() => page.evaluate(() => window.scrollTo(0, 0)));
    yield* Effect.tryPromise(() =>
      page.screenshot({ path: test.info().outputPath("transaction-link-desktop.png") })
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Activar tema oscuro", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(
        page.getByRole("button", {
          name: "Estado de la transacción vinculada: Parcial",
          exact: true,
        })
      ).toHaveCSS("color", "rgb(255, 246, 239)")
    );
    const darkAccessibility = yield* Effect.tryPromise(() => analyzeAccessibility(page));
    expect(darkAccessibility.violations).toEqual([]);
    yield* Effect.tryPromise(() =>
      page.screenshot({ path: test.info().outputPath("transaction-link-dark.png") })
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Activar tema claro", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(
        page.getByRole("button", {
          name: "Estado de la transacción vinculada: Parcial",
          exact: true,
        })
      ).toHaveCSS("color", "rgb(20, 20, 20)")
    );
    yield* Effect.tryPromise(() => page.setViewportSize({ width: 390, height: 844 }));
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("dialog")).toContainText("Revisar vínculo")
    );
    yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toHaveCSS("height", "844px"));
    yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toHaveCSS("top", "0px"));
    yield* Effect.tryPromise(() =>
      page.screenshot({ path: test.info().outputPath("transaction-link-mobile.png") })
    );
    const accessibility = yield* Effect.tryPromise(() => analyzeAccessibility(page));
    expect(accessibility.violations).toEqual([]);
    yield* inspectMobileResults(page);
  });
const inspectMobileResults = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Cerrar revisión", exact: true }).click()
    );
    yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toHaveCount(0));
    const overflow = yield* Effect.tryPromise(() =>
      page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    );
    expect(overflow).toBe(false);
    const candidate = page.getByRole("button", { name: /Revisar Internet antiguo/u }).first();
    yield* Effect.tryPromise(() => candidate.press("Enter"));
    yield* Effect.tryPromise(() => expect(page.getByRole("dialog")).toBeVisible());
  });

const inspectLastSearchResult = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const candidate = page
      .getByRole("button", { name: /Revisar Internet antiguo/u })
      .nth(searchPageSize - 1);
    yield* Effect.tryPromise(() => candidate.click());
    const heading = page.getByRole("heading", { name: "Revisar vínculo", exact: true });
    const viewportHeight = page.viewportSize()?.height ?? 0;
    const reviewVisible = (): Promise<boolean> =>
      heading
        .boundingBox()
        .then((box) => box !== null && box.y >= 0 && box.y + box.height <= viewportHeight);
    yield* Effect.tryPromise(() => expect.poll(reviewVisible).toBe(true));
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Cerrar revisión", exact: true }).click()
    );
  });

const inspectAppliedAmountScope = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const amount = page.getByLabel("Importe exacto", { exact: true });
    yield* Effect.tryPromise(() => expect(amount).toHaveAttribute("inputmode", "decimal"));
    yield* Effect.tryPromise(() => amount.fill("90.000,50"));
    yield* Effect.tryPromise(() => amount.pressSequentially("abc"));
    yield* Effect.tryPromise(() => expect(amount).toHaveValue("90.000,50"));
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("region", { name: "Resultados de transacciones" })).toContainText(
        "Importe exacto: COP 45.000,00"
      )
    );
    yield* Effect.tryPromise(() => amount.fill("45.000"));
  });

const inspectLinkedPayment = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const record = page.getByRole("article", {
      name: "Transacción vinculada: Mercado QA",
      exact: true,
    });
    yield* Effect.tryPromise(() => expect(record).toContainText("Restaurantes"));
    yield* Effect.tryPromise(() => expect(record).toContainText("Compra de la semana"));
    yield* Effect.tryPromise(() => expect(record).toContainText("Salida"));
    yield* Effect.tryPromise(() => expect(record.getByRole("link")).toHaveCount(0));
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button", { name: "Ver transacción", exact: true })).toHaveCount(0)
    );
    yield* Effect.tryPromise(() =>
      record.getByRole("button", { name: "Desvincular transacción", exact: true }).click()
    );
    yield* Effect.tryPromise(() => expect(record).toContainText("La transacción no se elimina"));
    yield* Effect.tryPromise(() =>
      record.getByRole("button", { name: "Volver", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(
        record.getByRole("button", { name: "Desvincular transacción", exact: true })
      ).toBeFocused()
    );
  });

const inspectLinkedPaymentLayouts = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    for (const width of [desktopLifecycleWidth, mobileLifecycleWidth]) {
      yield* Effect.tryPromise(() => page.setViewportSize({ width, height: 900 }));
      for (const theme of ["light", "dark"]) {
        if (theme === "dark") {
          yield* Effect.tryPromise(() =>
            page
              .getByRole("button", { name: "Activar tema oscuro", exact: true })
              .filter({ visible: true })
              .click()
          );
        }
        yield* Effect.tryPromise(() =>
          expect(
            page.getByRole("article", { name: "Transacción vinculada: Mercado QA", exact: true })
          ).toContainText("Compra de la semana")
        );
        yield* Effect.tryPromise(() =>
          page.screenshot({ path: test.info().outputPath(`linked-${width}-${theme}.png`) })
        );
        yield* Effect.tryPromise(() => page.evaluate(enlargeRecurringCaptureText));
        yield* Effect.tryPromise(() => expect.poll(() => panelFits(page)).toBe(true));
        yield* Effect.tryPromise(() => page.evaluate(resetRecurringCaptureText));
      }
      yield* Effect.tryPromise(() =>
        page
          .getByRole("button", { name: "Activar tema claro", exact: true })
          .filter({ visible: true })
          .click()
      );
    }
  });

const inspectAndRemoveLinkedPayment = (
  page: Page
): Effect.Effect<void, Cause.UnknownError | Cause.TimeoutError> =>
  Effect.gen(function* () {
    yield* inspectLinkedPayment(page);
    yield* inspectLinkedPaymentLayouts(page);
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Desvincular transacción", exact: true }).click()
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Confirmar desvinculación", exact: true }).click()
    );
    yield* Effect.tryPromise(() => expectPayment(page.getByRole("dialog")).toHaveCount(0));
    yield* inspectPaymentHistory({ request: page.request, count: 1, spent: "90000" });
  });
const panelFits = (page: Page): Promise<boolean> =>
  page.getByRole("dialog").evaluate((element) => element.scrollWidth <= element.clientWidth);

const unlinkTrackedTransaction = (page: Page): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Desvincular transacción", exact: true }).first().click()
    );
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Confirmar desvinculación", exact: true }).click()
    );
  });
