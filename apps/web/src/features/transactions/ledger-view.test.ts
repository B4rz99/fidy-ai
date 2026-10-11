import { screen, waitFor } from "@testing-library/dom";
import { type Cause, Effect, Option, Schema } from "effect";
import { Runtime, type Update } from "foldkit";
import { afterEach, expect, it } from "vitest";
import { cleanupFoldkit, renderFoldkit } from "@/testing/foldkit";
import { Category, TransactionId, maximumAtomicBatchCalls } from "@/transport/client";
import { transactionLedger } from "./ledger-view";
import { type Message, Model } from "./model";
import { category, ready, record } from "./test-fixtures";

afterEach(cleanupFoldkit);
const render = (model: Model): Effect.Effect<HTMLElement, Cause.UnknownError> => {
  const { container } = renderFoldkit((target) => {
    const handle = Runtime.embed(
      Runtime.makeElement({
        Model,
        container: target,
        devTools: false,
        init: (): Update.Return<Model, Message> => ({ model }),
        update: (current, _message: Message): Update.Return<Model, Message> => ({ model: current }),
        view: (current, html) => transactionLedger({ model: current, html, toolbar: [] }),
      })
    );
    return handle.dispose;
  });
  return Effect.tryPromise(() =>
    waitFor(() => expect(container.querySelector("section")).not.toBeNull())
  ).pipe(Effect.as(container));
};

it("retains an unavailable Category as a disabled choice while offering current Categories", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const alternative = yield* Schema.decodeEffect(Category)({
        id: "24000000-0000-4000-8000-000000000099",
        label: "Mercado",
      });
      yield* render({ ...ready, query: { ...ready.query, categories: [alternative] } });
      const select = screen.getByRole("combobox", { name: "Cambiar categoría de Árbol" });
      expect(select.querySelector(`option[value="${record.categoryId}"]`)).toBeDisabled();
      expect(select.querySelectorAll("option")).toHaveLength(2);
    })
  ));

it.each([
  ["Restaurantes", "rose"],
  ["Mercado", "sage"],
  ["Suscripciones", "sky"],
  ["Transporte", "lavender"],
  ["Hogar", "butter"],
  ["Salario", "sage"],
  ["Otros", "peach"],
] as const)(
  "presents %s through a decorative category illustration and an accessible name",
  (label, tone) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const categoryLabel = yield* Schema.decodeEffect(Category.fields.label)(label);
        const container = yield* render({
          ...ready,
          query: { ...ready.query, categories: [{ ...category, label: categoryLabel }] },
        });
        expect(container.querySelector(`[data-tone="${tone}"]`)).toHaveAttribute(
          "aria-hidden",
          "true"
        );
        expect(screen.getByRole("button", { name: "Ver transacción Árbol" })).toBeEnabled();
      })
    )
);

it("hides optional columns without hiding the Transaction's name or amount", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* render({ ...ready, categoryVisible: false, typeVisible: false });
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Ver tipo de Árbol" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Ver monto de Árbol" })).toBeEnabled();
    })
  ));

it.each(["Capture", "Bulk"] as const)(
  "locks row actions while the %s workspace owns a draft",
  (panel) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* render({ ...ready, panel });
        expect(screen.getByRole("button", { name: "Ver transacción Árbol" })).toBeDisabled();
        expect(screen.getByRole("combobox", { name: "Cambiar categoría de Árbol" })).toBeDisabled();
      })
    )
);

it("keeps selected rows removable when the atomic batch limit disables unselected rows", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const records = Array.from({ length: maximumAtomicBatchCalls + 1 }, (_, index) => ({
        ...record,
        id: TransactionId.make(`24000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`),
        counterparty: Option.some(`Record ${index}`),
      }));
      yield* render({
        ...ready,
        panel: "Selecting",
        selection: records.slice(0, maximumAtomicBatchCalls).map((value) => value.id),
        query: { ...ready.query, transactions: records },
      });
      expect(screen.getByRole("checkbox", { name: "Seleccionar Record 0" })).toBeEnabled();
      expect(
        screen.getByRole("checkbox", { name: `Seleccionar Record ${maximumAtomicBatchCalls}` })
      ).toBeDisabled();
    })
  ));

it("shows canonical category text when no editable categories are available", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* render({ ...ready, query: { ...ready.query, categories: [] } });
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
      expect(screen.getByRole("table", { name: "Tabla de transacciones" })).toBeVisible();
    })
  ));

it.each([
  ["", "complete", "No hay transacciones para mostrar"],
  ["missing", "complete", "No hay transacciones que coincidan con los filtros."],
  ["missing", "available", "No hay coincidencias entre las transacciones cargadas"],
] as const)(
  "distinguishes empty reads and partial filtered results",
  (search, continuation, copy) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* render({
          ...ready,
          filters: { ...ready.filters, search },
          query: { ...ready.query, transactions: [], continuation },
        });
        expect(screen.getByText(copy)).toBeVisible();
      })
    )
);
