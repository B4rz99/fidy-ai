import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { type Cause, Effect, Option, Schema } from "effect";
import { Mount, Runtime, type Update } from "foldkit";
import { afterEach, expect, it } from "vitest";
import { cleanupFoldkit, renderFoldkit } from "@/testing/foldkit";
import { DashboardCatalogEntry } from "@/transport/client";
import { type DashboardMounts, dashboardView } from "./foldkit-view";
import { Message, Model, initialModel } from "./model";
import { catalog, ids, makeView, standardOptions } from "./test-fixtures";

afterEach(cleanupFoldkit);
const mounted = Mount.define("DashboardViewTestMount", {
  messages: [Message.Mounted],
  execute: () => Effect.succeed(Message.Mounted()),
});
const mounts: DashboardMounts = { source: mounted, target: mounted, resize: mounted };
const render = (model: Model): Effect.Effect<ReadonlyArray<Message>, Cause.UnknownError> => {
  const messages: Message[] = [];
  const { container } = renderFoldkit((target) => {
    const handle = Runtime.embed(
      Runtime.makeElement({
        Model,
        container: target,
        devTools: false,
        init: (): Update.Return<Model, Message> => ({ model }),
        update: (current, message: Message): Update.Return<Model, Message> => {
          messages.push(message);
          return { model: current };
        },
        view: (current, html) =>
          dashboardView({ model: current, html, mounts, targetLabel: Option.none() }),
      })
    );
    return handle.dispose;
  });
  return Effect.tryPromise(() =>
    waitFor(() => expect(container.querySelector("main")).not.toBeNull())
  ).pipe(Effect.as(messages));
};
const cancelledTitle = (message: Message): boolean => message._tag === "CancelTitle";
const ready: Model = {
  ...initialModel,
  query: {
    ...initialModel.query,
    view: Option.some(makeView(standardOptions)),
    status: "Ready",
    waiting: false,
    catalogWaiting: false,
  },
};

it.each([
  ["reading", "Cargando tablero…"],
  ["initializing", "Inicializando tablero…"],
  ["reading-initialized", "Leyendo el tablero inicializado…"],
] as const)("distinguishes the loading phase %s", (phase, copy) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* render({ ...initialModel, query: { ...initialModel.query, phase } });
      expect(screen.getByRole("status")).toHaveTextContent(copy);
    })
  )
);

it.each(["reading", "initializing", "reading-initialized"] as const)(
  "shows retry and the failed %s phase",
  (phase) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* render({
          ...initialModel,
          query: { ...initialModel.query, status: "Failed", waiting: false, phase },
        });
        expect(screen.getByRole("alert")).toHaveTextContent("No pudimos cargar tu tablero");
        expect(screen.getByRole("button", { name: "Reintentar carga del tablero" })).toBeEnabled();
        if (phase === "initializing") {
          expect(screen.getByText("No pudimos inicializar el tablero.")).toBeVisible();
        }
        if (phase === "reading-initialized") {
          expect(
            screen.getByText("El tablero se inicializó, pero no pudimos leerlo.")
          ).toBeVisible();
        }
      })
    )
);

it("explains a transport boundary failure without claiming the Dashboard is empty", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* render({
        ...initialModel,
        query: { ...initialModel.query, status: "Failed", boundaryFailure: true },
      });
      expect(screen.getByRole("alert")).toHaveTextContent("No pudimos comunicarnos con Fidy");
    })
  ));

it.each(["Rejected", "Uncertain"] as const)(
  "keeps financial reads visible after a %s edit",
  (error) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* render({
          ...ready,
          error,
          query: { ...ready.query, catalogFailed: true, stale: true },
        });
        expect(screen.getByRole("table", { name: "Transacciones del Widget" })).toBeVisible();
        expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
        expect(screen.getByRole("button", { name: "Reintentar carga del catálogo" })).toBeEnabled();
      })
    )
);

it("retains accessible editing controls and handles Escape in a name draft", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const messages = yield* render({
        ...ready,
        editing: true,
        renaming: Option.some(ids.chart),
        titleDraft: "Draft",
        query: {
          ...ready.query,
          catalog: catalog.map((entry) => Schema.decodeUnknownSync(DashboardCatalogEntry)(entry)),
        },
      });
      const title = screen.getByRole("textbox", { name: "Nuevo nombre del Widget" });
      fireEvent.keyDown(title, { key: "x" });
      fireEvent.keyDown(title, { key: "Escape" });
      yield* Effect.tryPromise(() =>
        waitFor(() => expect(messages.some(cancelledTitle)).toBe(true))
      );
      expect(screen.getByRole("button", { name: "Guardar nombre del Widget" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Guardar" })).toBeEnabled();
    })
  ));
