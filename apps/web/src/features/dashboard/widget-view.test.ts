import { screen, waitFor } from "@testing-library/dom";
import { type Cause, Effect, Layer, Schema } from "effect";
import { Runtime, type Update } from "foldkit";
import { afterEach, expect, it } from "vitest";
import { cleanupFoldkit, renderFoldkit } from "@/testing/foldkit";
import { type Message } from "./model";
import type { DashboardLayout, DashboardWidgetView } from "./presentation";
import { type FixtureOptions, makeView, standardOptions } from "./test-fixtures";
import { widgetContent } from "./widget-view";

const collect = (layout: DashboardLayout): ReadonlyArray<DashboardWidgetView> =>
  layout.kind === "leaf" ? [layout.widget] : layout.children.flatMap(({ node }) => collect(node));
const renderWidgets = (options: Partial<FixtureOptions>): void => {
  const view = makeView({ ...standardOptions, ...options });
  renderFoldkit((container) => {
    const handle = Runtime.embed(
      Runtime.makeElement({
        Model: Schema.String,
        container,
        resources: Layer.empty,
        devTools: false,
        init: (): Update.Return<string, Message> => ({ model: "" }),
        update: (model) => ({ model }),
        view: (_, html) =>
          html.div(
            [],
            collect(view.layout).map((widget) =>
              widgetContent({ view: widget, context: view.context, html })
            )
          ),
      })
    );
    return (): void => handle.dispose();
  });
};
const visible = (text: string | RegExp): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() => screen.findByText(text)).pipe(Effect.asVoid);
afterEach(cleanupFoldkit);
for (const budgetState of ["missing", "under", "reached", "over"] as const) {
  it(`presents canonical ${budgetState} Budget progress with bounded geometry`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        renderWidgets({ budgetState });
        const text = {
          missing: "No hay presupuesto configurado",
          under: /Disponible.*75\.000,00/u,
          reached: "Presupuesto alcanzado",
          over: /Excedido por.*15\.000,00/u,
        }[budgetState];
        yield* visible(text);
        if (budgetState === "missing") expect(screen.queryByRole("progressbar")).toBeNull();
        else {
          expect(screen.getByRole("progressbar")).toHaveAttribute(
            "aria-valuenow",
            budgetState === "under" ? "25" : "100"
          );
        }
      })
    ));
}
for (const emptyState of ["chartEmpty", "metricEmpty", "transactionEmpty"] as const) {
  it(`presents the ${emptyState} Widget without inventing data`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        renderWidgets({ [emptyState]: true });
        const text = {
          chartEmpty: "No hay transacciones en este periodo",
          metricEmpty: "No hay transacciones para calcular",
          transactionEmpty: "No hay transacciones para mostrar",
        }[emptyState];
        yield* visible(text);
      })
    ));
}
it("keeps exact Money labels separate from chart geometry for mixed currencies", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      renderWidgets({ exact: true });
      yield* Effect.tryPromise(() => screen.findByRole("img", { name: "Gastos en USD" }));
      expect(screen.getByRole("img", { name: "Gastos en COP" })).toBeInTheDocument();
      yield* Effect.tryPromise(() =>
        waitFor(() => expect(document.body.textContent).toContain("9.007.199.254.740.993,12"))
      );
      expect(document.body.textContent).not.toContain("9.007.199.254.740.992");
      for (const rectangle of document.querySelectorAll("rect")) {
        expect(Number(rectangle.getAttribute("height"))).toBeLessThanOrEqual(140);
      }
    })
  ));
it("presents an unidentified inflow in the canonical locale and time zone", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      renderWidgets({ transactionInflow: true });
      yield* visible("Sin contraparte");
      expect(screen.getByRole("table", { name: "Transacciones del Widget" })).toHaveTextContent(
        "Ingreso"
      );
      expect(screen.getByRole("table", { name: "Transacciones del Widget" })).toHaveTextContent(
        "20 de jul"
      );
    })
  ));
