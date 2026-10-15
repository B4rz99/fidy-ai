import type { Page, Route } from "@playwright/test";
import { type Cause, Effect } from "effect";
import { signInRecurringThroughCore } from "./real-core-fixture";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;
const successStatus = 200;
const monthsPerYear = 12;
test("recurring plans persist through the real canonical API and share monthly list/calendar items", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInRecurringThroughCore({ page, request, identity: "recurring" })
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
        page.getByLabel("Importe real", { exact: true }).fill("400000")
      );
      yield* Effect.tryPromise(() => chooseDate(page, "Fecha real", "2026-10-30"));
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Registrar" }).click());
      yield* Effect.tryPromise(() =>
        expect(recurringItem(page, /Arriendo de prueba.*Parcial/u).first()).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(recurringItem(page, /Arriendo de prueba.*Parcial/u).first()).toBeVisible()
      );
      yield* inspectMobile(page);
    })
  ));

type PlanDraft = Readonly<{
  page: Page;
  name: string;
  kind: string;
  currency: string;
  amount: string;
}>;
const createPlan = ({
  page,
  name,
  kind,
  currency,
  amount,
}: PlanDraft): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => page.getByRole("button", { name: "Nuevo recurrente" }).click());
    yield* Effect.tryPromise(() => page.getByLabel("Nombre", { exact: true }).fill(name));
    yield* Effect.tryPromise(() => chooseDate(page, "Primera fecha", "2026-10-31"));
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
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Guardar recurrente" }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(recurringItem(page, new RegExp(name, "u")).first()).toBeVisible()
    );
  });
test("keeps income, transfers, unknown expenses and filtered summaries separate", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInRecurringThroughCore({ page, request, identity: "recurringSummary" })
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
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("region", { name: "Gastos", exact: true })).toContainText(
          "1 por confirmar"
        )
      );
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

test("recovers a committed save with a lost acknowledgement through an explicit reread", ({
  page,
  request,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        signInRecurringThroughCore({ page, request, identity: "recurringRecovery" })
      );
      yield* Effect.tryPromise(() => page.goto("/app/recurring?month=2026-10"));
      yield* Effect.tryPromise(() => page.route("**/recurring-plans/edits", loseAcknowledgement));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Nuevo recurrente" }).click()
      );
      yield* Effect.tryPromise(() =>
        page.getByLabel("Nombre", { exact: true }).fill("Guardado sin respuesta")
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Guardar recurrente" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("alert")).toContainText("No pudimos confirmar si se guardó")
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button", { name: "Guardar recurrente" })).toBeDisabled()
      );
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Actualizar recurrentes" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(recurringItem(page, /Guardado sin respuesta/u)).toHaveCount(1)
      );
    })
  ));

const loseAcknowledgement = (route: Route): Promise<void> =>
  route.request().method() === "POST"
    ? route.fetch().then((response) =>
        response.text().then((body) => {
          expect(response.status(), body).toBe(successStatus);
          return route.abort("failed");
        })
      )
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
    .getByRole("button", { name: label, exact: true })
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
      const trigger = page.getByRole("button", { name: label, exact: true });
      const selected = yield* Effect.tryPromise(() => trigger.innerText());
      const [, month = 0, year = 0] = selected.split("-").map(Number);
      const [targetYear = 0, targetMonth = 0] = date.split("-").map(Number);
      const steps = (targetYear - year) * monthsPerYear + targetMonth - month;
      yield* Effect.tryPromise(() => trigger.click());
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
