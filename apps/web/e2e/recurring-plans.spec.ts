import type { Page, Route } from "@playwright/test";
import { type Cause, Effect } from "effect";
import { signInRecurringThroughCore } from "./real-core-fixture";
import { playwright } from "./playwright-runtime";

const { expect, test } = playwright;
const successStatus = 200;
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
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        page
          .getByRole("button", { name: /Arriendo de prueba/u })
          .first()
          .click()
      );
      yield* Effect.tryPromise(() =>
        page.getByLabel("Importe real", { exact: true }).fill("400000")
      );
      yield* Effect.tryPromise(() => page.getByLabel("Fecha real").fill("2026-10-30"));
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Registrar parcial" }).click()
      );
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("button", { name: /Arriendo de prueba.*Parcial/u }).first()
        ).toBeVisible()
      );
      yield* Effect.tryPromise(() => page.reload());
      yield* Effect.tryPromise(() =>
        expect(
          page.getByRole("button", { name: /Arriendo de prueba.*Parcial/u }).first()
        ).toBeVisible()
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
    yield* Effect.tryPromise(() => page.getByLabel("Primera fecha").fill("2026-10-31"));
    yield* Effect.tryPromise(() => page.getByLabel("Tipo", { exact: true }).selectOption(kind));
    yield* Effect.tryPromise(() => page.getByLabel("Moneda", { exact: true }).fill(currency));
    if (amount !== "") {
      yield* Effect.tryPromise(() => page.getByLabel("Tipo de importe").selectOption("fixed"));
      yield* Effect.tryPromise(() => page.getByLabel("Importe", { exact: true }).fill(amount));
    }
    yield* Effect.tryPromise(() =>
      page.getByRole("button", { name: "Guardar recurrente" }).click()
    );
    yield* Effect.tryPromise(() =>
      expect(page.getByRole("button").filter({ hasText: name }).first()).toBeVisible()
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
      yield* Effect.tryPromise(() => page.getByText("Filtros", { exact: true }).click());
      yield* Effect.tryPromise(() => page.getByLabel("Filtrar moneda").fill("USD"));
      yield* Effect.tryPromise(() => page.getByRole("button", { name: "Aplicar filtros" }).click());
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("region", { name: "Transferencias", exact: true })).toContainText(
          "Sin recurrentes"
        )
      );
      yield* Effect.tryPromise(() =>
        expect(page.getByRole("button").filter({ hasText: "Pago de tarjeta" })).toHaveCount(0)
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
      page
        .getByRole("button", { name: /Arriendo de prueba.*Parcial/u })
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
        expect(page.getByRole("button").filter({ hasText: "Guardado sin respuesta" })).toHaveCount(
          1
        )
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
