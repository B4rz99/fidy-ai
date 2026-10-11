import { fireEvent, screen, waitFor, within } from "@testing-library/dom";
import { type Cause, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupFoldkit, renderFoldkit } from "@/testing/foldkit";
import { makeFidyClient } from "@/transport/client";
import { mountTransactions } from "./program";

const category = { id: "24000000-0000-4000-8000-000000000001", label: "Restaurantes" };
const otherCategory = { id: "24000000-0000-4000-8000-000000000004", label: "Mercado" };
const record = {
  id: "24000000-0000-4000-8000-000000000002",
  categoryId: category.id,
  revision: 3,
  money: { amount: "25000", currency: "COP" },
  direction: "outflow",
  counterparty: "El Corral",
  occurredAt: "2026-10-09T12:30:00Z",
  createdAt: "2026-10-09T12:30:00Z",
};
const user = {
  id: "24000000-0000-4000-8000-000000000003",
  serviceMarket: "CO",
  locale: "es-CO",
  timeZone: "America/Bogota",
  trialPeriod: { startedAt: "2026-01-01T00:00:00Z", endsAt: "2026-01-08T00:00:00Z" },
  createdAt: "2026-01-01T00:00:00Z",
};
const decodeBody = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
type Respond = (request: Readonly<{ path: string; method: string; body: unknown }>) => Response;
const mount = (respond: Respond): ReturnType<typeof renderFoldkit> => {
  const client = makeFidyClient({
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() =>
          HttpClientResponse.fromWeb(
            request,
            respond({
              path: new URL(request.url).pathname,
              method: request.method,
              body:
                request.body._tag === "Uint8Array"
                  ? decodeBody(new TextDecoder().decode(request.body.body))
                  : null,
            })
          )
        )
      )
    ),
  });
  const registry = AtomRegistry.make();
  return renderFoldkit((container) => {
    const dispose = mountTransactions({
      container,
      client,
      registry,
      resources: registry.get(client.runtime.layer),
    });
    return (): void => {
      dispose();
      registry.dispose();
    };
  });
};
const respondWithRecords: Respond = ({ path }) => {
  if (path === "/user") return Response.json({ data: user, next: [] });
  if (path === "/categories") return Response.json({ data: [category, otherCategory], next: [] });
  return Response.json({ data: [record], next: [] });
};
const click = (name: string): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() => screen.findByRole("button", { name })).pipe(
    Effect.flatMap((button) =>
      Effect.tryPromise(() => waitFor(() => expect(button).not.toBeDisabled())).pipe(
        Effect.tap(() => Effect.sync(() => fireEvent.click(button)))
      )
    ),
    Effect.asVoid
  );
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  }));
});
afterEach(() => {
  cleanupFoldkit();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("preserves the editing draft across mobile and desktop layouts and restores focus on close", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const media = {
        matches: false,
        addEventListener: vi.fn<(type: string, listener: () => void) => void>(),
        removeEventListener: vi.fn(),
      };
      vi.stubGlobal("matchMedia", () => media);
      mount(respondWithRecords);
      const opener = yield* Effect.tryPromise(() =>
        screen.findByRole("button", { name: "Ver transacción El Corral" })
      );
      opener.focus();
      yield* click("Ver transacción El Corral");
      const notes = yield* Effect.tryPromise(() => screen.findByLabelText("Notas"));
      fireEvent.input(notes, { target: { value: "Conservar borrador" } });
      yield* Effect.tryPromise(() =>
        waitFor(() => expect(notes).toHaveValue("Conservar borrador"))
      );
      expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
      const change = media.addEventListener.mock.calls[0]?.[1];
      if (typeof change !== "function") throw new Error("Missing media listener");
      media.matches = true;
      change();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByLabelText("Notas")).toBe(notes);
      expect(notes).toHaveValue("Conservar borrador");
      media.matches = false;
      change();
      fireEvent.keyDown(notes, { key: "Escape" });
      yield* Effect.tryPromise(() => waitFor(() => expect(screen.queryByRole("form")).toBeNull()));
      expect(opener).toHaveFocus();
      expect(screen.getByLabelText("Buscar transacciones").closest("header")).not.toHaveAttribute(
        "inert"
      );
    })
  ));
it("captures once, clears the mounted form, and reads authoritative history after success", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const writes: unknown[] = [];
      let reads = 0;
      mount((request) => {
        if (request.method === "POST") {
          writes.push(request.body);
          return Response.json({ data: record, next: [] }, { status: 201 });
        }
        if (request.path === "/transactions") reads += 1;
        return respondWithRecords(request);
      });
      yield* click("+ Registrar");
      const amount = yield* Effect.tryPromise(() => screen.findByLabelText("Monto ($)"));
      fireEvent.input(amount, { target: { value: "125,50" } });
      fireEvent.submit(screen.getByRole("form"));
      yield* Effect.tryPromise(() => waitFor(() => expect(writes).toHaveLength(1)));
      yield* Effect.tryPromise(() => waitFor(() => expect(screen.queryByRole("form")).toBeNull()));
      yield* Effect.tryPromise(() => waitFor(() => expect(reads).toBe(2)));
      expect(screen.getByRole("button", { name: "+ Registrar" })).not.toBeDisabled();
    })
  ));
it("loads canonical records, filters and summarizes exact money without mixing currencies", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      mount(respondWithRecords);
      yield* Effect.tryPromise(() =>
        screen.findByRole("button", { name: "Ver transacción El Corral" })
      );
      const summary = screen.getByRole("region", { name: "Resumen de transacciones" });
      expect(within(summary).getByText("Total de transacciones")).toBeVisible();
      fireEvent.input(screen.getByLabelText("Buscar transacciones"), {
        target: { value: "no match" },
      });
      yield* Effect.tryPromise(() =>
        screen.findByText("No hay transacciones que coincidan con los filtros.")
      );
      yield* click("Limpiar filtros");
      yield* Effect.tryPromise(() =>
        screen.findByRole("button", { name: "Ver transacción El Corral" })
      );
    })
  ));
it("mounts the revision-bound editor and refreshes once after a successful save", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const writes: unknown[] = [];
      let reads = 0;
      mount((request) => {
        if (request.method === "PUT") {
          writes.push(request.body);
          return Response.json({ data: { ...record, revision: 4 }, next: [] });
        }
        if (request.path === "/transactions") reads += 1;
        return respondWithRecords(request);
      });
      yield* click("Ver transacción El Corral");
      const notes = yield* Effect.tryPromise(() => screen.findByLabelText("Notas"));
      fireEvent.input(notes, { target: { value: "Almuerzo" } });
      fireEvent.submit(screen.getByRole("form"));
      yield* Effect.tryPromise(() =>
        waitFor(() =>
          expect(writes).toEqual([{ expectedRevision: 3, changes: { notes: "Almuerzo" } }])
        )
      );
      yield* Effect.tryPromise(() => waitFor(() => expect(reads).toBe(2)));
      expect(screen.queryByRole("form")).toBeNull();
    })
  ));
it("locks category edits after an uncertain response and refreshes explicitly", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const writes: unknown[] = [];
      mount((request) => {
        if (request.method === "PUT") {
          writes.push(request.body);
          return Response.json({}, { status: 503 });
        }
        return respondWithRecords(request);
      });
      const categoryInput = yield* Effect.tryPromise(() =>
        screen.findByLabelText("Cambiar categoría de El Corral")
      );
      fireEvent.change(categoryInput, { target: { value: otherCategory.id } });
      yield* Effect.tryPromise(() => screen.findByRole("alert"));
      expect(writes).toEqual([{ expectedRevision: 3, changes: { categoryId: otherCategory.id } }]);
      yield* Effect.tryPromise(() =>
        waitFor(() =>
          expect(screen.getByLabelText("Cambiar categoría de El Corral")).toBeDisabled()
        )
      );
      yield* click("Actualizar historial");
      yield* Effect.tryPromise(() =>
        waitFor(() =>
          expect(screen.getByLabelText("Cambiar categoría de El Corral")).not.toBeDisabled()
        )
      );
      expect(writes).toHaveLength(1);
    })
  ));
it("keeps records readable after a refresh failure and disables writes until a successful retry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let failing = false;
      mount((request) =>
        request.path === "/categories" && failing
          ? Response.json({}, { status: 503 })
          : respondWithRecords(request)
      );
      yield* click("Ver transacción El Corral");
      yield* click("Cerrar detalle");
      failing = true;
      yield* click("Actualizar transacciones");
      yield* Effect.tryPromise(() => screen.findByText(/No pudimos actualizar las transacciones/u));
      expect(screen.getByRole("button", { name: "Ver transacción El Corral" })).toBeVisible();
      expect(screen.getByRole("button", { name: "+ Registrar" })).toBeDisabled();
      expect(screen.getByLabelText("Cambiar categoría de El Corral")).toBeDisabled();
      failing = false;
      yield* click("Actualizar historial");
      yield* Effect.tryPromise(() =>
        waitFor(() =>
          expect(screen.getByRole("button", { name: "+ Registrar" })).not.toBeDisabled()
        )
      );
    })
  ));
it("presents malformed canonical responses safely and permits retry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let malformed = true;
      mount((request) =>
        request.path === "/user" && malformed
          ? Response.json({ data: { secret: "do not display" }, next: [] })
          : respondWithRecords(request)
      );
      yield* Effect.tryPromise(() => screen.findByText("No pudimos comunicarnos con Fidy"));
      expect(screen.queryByText(/do not display/u)).toBeNull();
      malformed = false;
      yield* click("Actualizar historial");
      yield* Effect.tryPromise(() =>
        screen.findByRole("button", { name: "Ver transacción El Corral" })
      );
    })
  ));
it("shows unavailable categories and separate currency totals without inventing a category", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      mount((request) => {
        if (request.path === "/categories") return Response.json({ data: [], next: [] });
        if (request.path === "/transactions") {
          return Response.json({
            data: [
              record,
              {
                ...record,
                id: "24000000-0000-4000-8000-000000000005",
                direction: "inflow",
                counterparty: "Salario",
                money: { amount: "200", currency: "USD" },
              },
            ],
            next: [],
          });
        }
        return respondWithRecords(request);
      });
      yield* Effect.tryPromise(() =>
        screen.findByRole("button", { name: "Ver transacción Salario" })
      );
      expect(screen.getAllByText("Categoría no disponible")).toHaveLength(4);
      const summary = within(screen.getByRole("region", { name: "Resumen de transacciones" }));
      expect(summary.getByText("peso colombiano")).toBeVisible();
      expect(summary.getByText("dólar estadounidense")).toBeVisible();
      expect(summary.getAllByText("$ 25.000,00")).toHaveLength(4);
      expect(summary.getAllByText("$ 200,00")).toHaveLength(3);
    })
  ));
