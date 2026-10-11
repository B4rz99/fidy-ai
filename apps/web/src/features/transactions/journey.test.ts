import { fireEvent, screen, waitFor, within } from "@testing-library/dom";
import { AtomRegistry } from "effect/reactivity";
import { cleanupFoldkit, renderFoldkit } from "@/testing/foldkit";
import { DateTime, Deferred, Effect, Layer, Option, Schema } from "effect";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeFidyClient } from "@/transport/client";
import { mountTransactions } from "./program";

const selectChoice = (label: string, choice: string): void => {
  const element = screen.getByRole<HTMLSelectElement>("combobox", { name: label });
  const option = Array.from(element.options).find((item) => item.text === choice);
  if (option === undefined) throw new Error("Missing choice");
  fireEvent.change(element, { target: { value: option.value } });
};
const nextPaint = Effect.callback<void>((resume) => {
  const frame = requestAnimationFrame(() => queueMicrotask(() => resume(Effect.void)));
  return Effect.sync(() => cancelAnimationFrame(frame));
});
const waitForEditableHistory = (): Promise<void> =>
  waitFor(() => expect(screen.getByRole("button", { name: "+ Registrar" })).toBeEnabled()).then(
    () => {}
  );
const waitForMutation = (updates: () => number): Promise<void> =>
  waitFor(() => expect(updates()).toBe(1));
const createdStatus = 201;
const invalidStatus = 400;
const categoryId = "24000000-0000-4000-8000-000000000001";
const transactionId = "24000000-0000-4000-8000-000000000002";
const storedTransaction = {
  id: transactionId,
  categoryId,
  money: { amount: "25000", currency: "COP" },
  counterparty: "El Corral",
  direction: "outflow",
  occurredAt: "2026-10-09T12:30:00Z",
  createdAt: "2026-10-09T12:30:00Z",
  revision: 0,
};
const wireResponse = (
  request: HttpClientRequest.HttpClientRequest,
  data: unknown,
  status = 200
): HttpClientResponse.HttpClientResponse => {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const realmBytes = new window.Uint8Array(bytes.length);
  realmBytes.set(bytes);
  const response = new Response(bytes, { status, headers: { "content-type": "application/json" } });
  Object.defineProperty(response, "arrayBuffer", {
    value: () => Promise.resolve(realmBytes.buffer),
  });
  return HttpClientResponse.fromWeb(request, response);
};
const jsonResponse = (
  request: HttpClientRequest.HttpClientRequest,
  data: unknown,
  status = 200
): HttpClientResponse.HttpClientResponse => wireResponse(request, { data, next: [] }, status);
const mountJourney = (client: HttpClient.HttpClient): void => {
  const options = {
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(HttpClient.HttpClient, client),
  };
  const apiClient = makeFidyClient(options);
  const registry = AtomRegistry.make();
  renderFoldkit((container) => {
    const dispose = mountTransactions({
      container,
      client: apiClient,
      registry,
      resources: registry.get(apiClient.runtime.layer),
    });
    return (): void => {
      dispose();
      registry.dispose();
    };
  });
};
const renderJourney = (
  uncertain = false,
  saveGate: Effect.Effect<void> = Effect.void
): Readonly<{ updates: () => number; updateBody: () => string }> => {
  let transaction = storedTransaction;
  let updates = 0;
  let updateBody = "";
  const created = {
    ...storedTransaction,
    id: "24000000-0000-4000-8000-000000000003",
    counterparty: "La Cocina",
    money: { amount: "45000", currency: "COP" },
  };
  let captured = false;
  const client = HttpClient.make((request) => {
    if (request.method === "PUT") {
      updates += 1;
      if (request.body._tag === "Uint8Array") {
        updateBody = new TextDecoder().decode(request.body.body);
      }
      if (uncertain) {
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request }),
          })
        );
      }
      transaction = { ...transaction, money: { amount: "30000", currency: "COP" }, revision: 1 };
      return saveGate.pipe(Effect.as(jsonResponse(request, transaction)));
    }
    if (request.method === "POST") {
      captured = true;
      return Effect.succeed(jsonResponse(request, created, createdStatus));
    }
    if (request.url.endsWith("/user")) {
      return Effect.succeed(jsonResponse(request, storedUser));
    }
    if (request.url.endsWith("/categories")) {
      return Effect.succeed(
        jsonResponse(request, [
          { id: categoryId, label: "Restaurantes" },
          { id: "24000000-0000-4000-8000-000000000099", label: "Mercado" },
        ])
      );
    }
    return Effect.succeed(jsonResponse(request, captured ? [created, transaction] : [transaction]));
  });
  mountJourney(client);
  return { updates: () => updates, updateBody: () => updateBody };
};
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  }));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(DateTime.makeUnsafe("2026-10-09T14:00:00Z").epochMilliseconds);
});
afterEach(() => {
  cleanupFoldkit();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("corrects the selected transaction and refreshes the same history entry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const requests = renderJourney();
      fireEvent.click(
        yield* Effect.tryPromise(() =>
          screen.findByRole("button", { name: "Ver transacción El Corral" })
        )
      );
      yield* nextPaint;
      fireEvent.input(screen.getByLabelText("Monto ($)"), { target: { value: "30000" } });
      yield* nextPaint;
      fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
      yield* nextPaint;
      expect(yield* Effect.tryPromise(() => screen.findByText("Cambios guardados"))).toBeVisible();
      expect(
        yield* Effect.tryPromise(() =>
          within(screen.getByLabelText("Transacciones del mes")).findByText("$ 30.000,00")
        )
      ).toBeVisible();
      expect(screen.getAllByRole("button", { name: "Ver transacción El Corral" })).toHaveLength(1);
      expect(requests.updateBody()).toBe(
        '{"expectedRevision":0,"changes":{"money":{"amount":"30000","currency":"COP"}}}'
      );
    })
  ));

it("keeps an uncertain correction from being submitted a second time", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const requests = renderJourney(true);
      fireEvent.click(
        yield* Effect.tryPromise(() =>
          screen.findByRole("button", { name: "Ver transacción El Corral" })
        )
      );
      yield* nextPaint;
      fireEvent.input(screen.getByLabelText("Monto ($)"), { target: { value: "30000" } });
      yield* nextPaint;
      fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
      yield* nextPaint;
      expect(yield* Effect.tryPromise(() => screen.findByRole("alert"))).toHaveTextContent(
        "No pudimos confirmar los cambios"
      );
      expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
      yield* nextPaint;
      expect(requests.updates()).toBe(1);
      fireEvent.click(screen.getByRole("button", { name: "Actualizar historial" }));
      yield* nextPaint;
      expect(screen.getByRole("region", { name: "Resumen de transacciones" })).toBeVisible();
    })
  ));

it("records a transaction, shows the saved history entry and opens its details", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      renderJourney();
      yield* Effect.tryPromise(() =>
        screen.findByRole("button", { name: "Ver transacción El Corral" })
      );
      fireEvent.click(screen.getByRole("button", { name: "+ Registrar" }));
      yield* nextPaint;
      selectChoice("Dirección", "Ingreso");
      yield* nextPaint;
      expect(screen.getByLabelText("Dirección")).toHaveDisplayValue("Ingreso");
      selectChoice("Dirección", "Gasto");
      yield* nextPaint;
      expect(screen.getByLabelText("Dirección")).toHaveDisplayValue("Gasto");
      fireEvent.input(screen.getByLabelText("Monto ($)"), { target: { value: "45000.001" } });
      yield* nextPaint;
      fireEvent.click(screen.getByRole("button", { name: "Registrar transacción" }));
      yield* nextPaint;
      yield* Effect.tryPromise(() => screen.findByRole("alert"));
      expect(
        screen.queryByRole("button", { name: "Ver transacción La Cocina" })
      ).not.toBeInTheDocument();
      fireEvent.input(screen.getByLabelText("Monto ($)"), { target: { value: "45000" } });
      yield* nextPaint;
      fireEvent.input(screen.getByLabelText("Contraparte (opcional)"), {
        target: { value: "La Cocina" },
      });
      yield* nextPaint;
      fireEvent.click(screen.getByRole("button", { name: "Registrar transacción" }));
      yield* nextPaint;
      const row = yield* Effect.tryPromise(() =>
        screen.findByRole("button", { name: "Ver transacción La Cocina" })
      );
      expect(screen.getByLabelText("Resumen de transacciones")).toBeVisible();
      fireEvent.click(row);
      yield* nextPaint;
      expect(
        within(screen.getByRole("region", { name: "Detalle de transacción" })).getByText(
          "$ 45.000,00"
        )
      ).toBeVisible();
    })
  ));

it("opens transaction details in a dismissible sheet on a narrow screen", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      vi.stubGlobal("matchMedia", () => ({
        matches: false,
        addEventListener: (): void => undefined,
        removeEventListener: (): void => undefined,
      }));
      renderJourney();
      const row = yield* Effect.tryPromise(() =>
        screen.findByRole("button", { name: "Ver transacción El Corral" })
      );
      fireEvent.click(row);
      yield* nextPaint;
      expect(yield* Effect.tryPromise(() => screen.findByRole("dialog"))).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Cerrar detalle" }));
      yield* nextPaint;
      expect(
        yield* Effect.tryPromise(() => screen.findByLabelText("Resumen de transacciones"))
      ).toBeVisible();
    })
  ));

const resizeableScreen = (): ((desktop: boolean) => void) => {
  let matches = true;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", () => ({
    get matches(): boolean {
      return matches;
    },
    addEventListener: (_event: string, listener: () => void): void => {
      listeners.add(listener);
    },
    removeEventListener: (_event: string, listener: () => void): void => {
      listeners.delete(listener);
    },
  }));
  return (desktop) => {
    matches = desktop;
    listeners.forEach((listener) => listener());
  };
};
it("preserves capture and correction drafts when the layout changes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const resize = resizeableScreen();
      renderJourney();
      yield* Effect.tryPromise(() =>
        screen.findByRole("button", { name: "Ver transacción El Corral" })
      );
      fireEvent.click(screen.getByRole("button", { name: "+ Registrar" }));
      yield* nextPaint;
      fireEvent.input(screen.getByLabelText("Monto ($)"), { target: { value: "45000" } });
      yield* nextPaint;
      resize(false);
      expect(screen.getByLabelText("Monto ($)")).toHaveValue("45000");
      resize(true);
      expect(screen.getByLabelText("Monto ($)")).toHaveValue("45000");
      fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
      yield* nextPaint;
      fireEvent.click(screen.getByRole("button", { name: "Ver transacción El Corral" }));
      yield* nextPaint;
      fireEvent.input(screen.getByLabelText("Monto ($)"), { target: { value: "30000" } });
      yield* nextPaint;
      resize(false);
      expect(screen.getByLabelText("Monto ($)")).toHaveValue("30000");
      resize(true);
      expect(screen.getByLabelText("Monto ($)")).toHaveValue("30000");
    })
  ));

it("finishes a pending correction after crossing the responsive breakpoint", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const complete = yield* Deferred.make<void>();
      const resize = resizeableScreen();
      const requests = renderJourney(false, Deferred.await(complete));
      fireEvent.click(
        yield* Effect.tryPromise(() =>
          screen.findByRole("button", { name: "Ver transacción El Corral" })
        )
      );
      yield* nextPaint;
      fireEvent.input(screen.getByLabelText("Monto ($)"), { target: { value: "30000" } });
      yield* nextPaint;
      fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
      yield* nextPaint;
      expect(
        yield* Effect.tryPromise(() => screen.findByRole("button", { name: "Guardando…" }))
      ).toBeDisabled();
      expect(screen.getByLabelText("Notas")).toBeDisabled();
      resize(false);
      expect(screen.getByLabelText("Monto ($)")).toHaveValue("30000");
      expect(screen.getByLabelText("Notas")).toBeDisabled();
      yield* Deferred.succeed(complete, undefined);
      yield* Effect.tryPromise(() => screen.findByText("Cambios guardados"));
      yield* Effect.tryPromise(waitForEditableHistory);
      fireEvent.click(screen.getByRole("button", { name: "Ver transacción El Corral" }));
      yield* nextPaint;
      expect(screen.getByLabelText("Monto ($)")).toHaveValue("30000");
      expect(requests.updates()).toBe(1);
    })
  ));

it("rejects invalid corrections and discards cancelled field changes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const requests = renderJourney();
      fireEvent.click(
        yield* Effect.tryPromise(() =>
          screen.findByRole("button", { name: "Ver transacción El Corral" })
        )
      );
      yield* nextPaint;
      const invalidAmounts = ["0", "-1", "not money", "1.001"];
      for (const amount of invalidAmounts) {
        fireEvent.input(screen.getByLabelText("Monto ($)"), { target: { value: amount } });
        yield* nextPaint;
        fireEvent.submit(screen.getByRole("form", { name: "Corregir transacción" }));
        yield* nextPaint;
        expect(screen.getByRole("alert")).toHaveTextContent("Revisa los cambios");
        expect(requests.updates()).toBe(0);
      }
      fireEvent.input(screen.getByLabelText("Contraparte"), {
        target: { value: "Draft merchant" },
      });
      yield* nextPaint;
      selectChoice("Tipo", "Ingreso");
      yield* nextPaint;
      fireEvent.input(screen.getByLabelText("Notas"), {
        target: { value: "Draft notes" },
      });
      yield* nextPaint;
      fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
      yield* nextPaint;
      expect(screen.getByRole("region", { name: "Resumen de transacciones" })).toBeVisible();
      expect(screen.queryByText("Draft merchant")).not.toBeInTheDocument();
      expect(requests.updates()).toBe(0);
      fireEvent.click(screen.getByRole("button", { name: "Ver transacción El Corral" }));
      yield* nextPaint;
      expect(screen.getByLabelText("Monto ($)")).toHaveValue("25000");
      expect(screen.getByRole("combobox", { name: "Tipo" })).toHaveDisplayValue("Gasto");
      expect(screen.getByLabelText("Notas")).toHaveValue("");
    })
  ));

const bulkRequest = Schema.fromJsonString(
  Schema.Struct({
    calls: Schema.Array(
      Schema.Struct({
        callId: Schema.String,
        operation: Schema.String,
        input: Schema.Struct({
          params: Schema.Struct({ id: Schema.String }),
          payload: Schema.Struct({
            expectedRevision: Schema.Finite,
            changes: Schema.Struct({ notes: Schema.String }),
          }),
        }),
      })
    ),
  })
);
const bulkRejection = (
  request: HttpClientRequest.HttpClientRequest
): HttpClientResponse.HttpClientResponse =>
  wireResponse(
    request,
    {
      error: {
        code: "validation_failed",
        message: "Revision changed",
        failedCallIndex: 1,
        operation: "transactions.updateTransaction",
        fields: [],
      },
      next: [],
    },
    invalidStatus
  );
const storedUser = {
  id: "24000000-0000-4000-8000-000000000241",
  serviceMarket: "CO",
  locale: "es-CO",
  timeZone: "America/Bogota",
  trialPeriod: { startedAt: "2026-10-01T00:00:00Z", endsAt: "2026-10-08T00:00:00Z" },
  createdAt: "2026-10-01T00:00:00Z",
};
const bulkRecords = [
  storedTransaction,
  {
    ...storedTransaction,
    id: "24000000-0000-4000-8000-000000000003",
    counterparty: "Éxito",
    revision: 4,
  },
  {
    ...storedTransaction,
    id: "24000000-0000-4000-8000-000000000004",
    counterparty: "Transporte",
  },
];
const renderBulkJourney = (
  result: "saved" | "rejected" | "uncertain" = "saved",
  mixedCurrencies = false
): Readonly<{ bodies: string[] }> => {
  let records = bulkRecords.map((record) =>
    mixedCurrencies && record.counterparty === "Éxito"
      ? { ...record, money: { ...record.money, currency: "USD" } }
      : record
  );
  const bodies: string[] = [];
  const client = HttpClient.make((request) => {
    if (request.url.endsWith("/operations/atomic-batch")) {
      if (request.body._tag === "Uint8Array") {
        bodies.push(new TextDecoder().decode(request.body.body));
      }
      if (result === "uncertain") {
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request }),
          })
        );
      }
      if (result === "rejected") return Effect.succeed(bulkRejection(request));
      const { calls } = Schema.decodeSync(bulkRequest)(
        Option.getOrThrow(Option.fromNullishOr(bodies[0]))
      );
      records = records.map((record) =>
        calls.some((call) => call.input.params.id === record.id)
          ? { ...record, notes: "Compra revisada", revision: record.revision + 1 }
          : record
      );
      return Effect.succeed(
        jsonResponse(request, {
          results: calls.map((call) => ({
            callId: call.callId,
            operation: call.operation,
            output: {
              data: records.find((record) => record.id === call.input.params.id),
              next: [],
            },
          })),
        })
      );
    }
    if (request.url.endsWith("/user")) return Effect.succeed(jsonResponse(request, storedUser));
    if (request.url.endsWith("/categories")) {
      return Effect.succeed(
        jsonResponse(request, [
          { id: categoryId, label: "Restaurantes" },
          { id: "24000000-0000-4000-8000-000000000099", label: "Mercado" },
        ])
      );
    }
    return Effect.succeed(jsonResponse(request, records));
  });
  mountJourney(client);
  return { bodies };
};
const selectBulkRecords: Effect.Effect<void> = Effect.gen(function* () {
  fireEvent.click(
    yield* Effect.tryPromise(() => screen.findByRole("button", { name: "Editar varias" }))
  );
  yield* nextPaint;
  expect(screen.queryByLabelText("Resumen de transacciones")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Editar selección" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "Seleccionar El Corral" }));
  yield* nextPaint;
  fireEvent.click(screen.getByRole("checkbox", { name: "Seleccionar Éxito" }));
  yield* nextPaint;
  expect(screen.getByText("2 seleccionadas")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Editar selección" }));
  yield* nextPaint;
}).pipe(Effect.orDie);
it("corrects only selected records atomically at their observed revisions", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const requests = renderBulkJourney();
      yield* selectBulkRecords;
      fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
      yield* nextPaint;
      expect(screen.getByRole("alert")).toHaveTextContent("Revisa los cambios");
      expect(requests.bodies).toHaveLength(0);
      fireEvent.input(screen.getByLabelText("Notas"), { target: { value: "Compra revisada" } });
      yield* nextPaint;
      fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
      yield* nextPaint;
      yield* Effect.tryPromise(() => screen.findByLabelText("Resumen de transacciones"));
      expect(requests.bodies).toHaveLength(1);
      const batch = yield* Schema.decodeEffect(bulkRequest)(
        Option.getOrThrow(Option.fromNullishOr(requests.bodies[0]))
      );
      expect(batch.calls.map((call) => ({ operation: call.operation, input: call.input }))).toEqual(
        [
          {
            operation: "transactions.updateTransaction",
            input: {
              params: { id: transactionId },
              payload: { expectedRevision: 0, changes: { notes: "Compra revisada" } },
            },
          },
          {
            operation: "transactions.updateTransaction",
            input: {
              params: { id: "24000000-0000-4000-8000-000000000003" },
              payload: { expectedRevision: 4, changes: { notes: "Compra revisada" } },
            },
          },
        ]
      );
      fireEvent.click(screen.getByRole("button", { name: "Ver transacción Éxito" }));
      yield* nextPaint;
      expect(screen.getByLabelText("Notas")).toHaveValue("Compra revisada");
      fireEvent.click(screen.getByRole("button", { name: "Cerrar detalle" }));
      yield* nextPaint;
      fireEvent.click(screen.getByRole("button", { name: "Ver transacción Transporte" }));
      yield* nextPaint;
      expect(screen.getByLabelText("Notas")).toHaveValue("");
    })
  ));
it.each(["rejected", "uncertain"] as const)("blocks replay after a %s bulk save", (result) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const requests = renderBulkJourney(result);
      yield* selectBulkRecords;
      fireEvent.input(screen.getByLabelText("Notas"), { target: { value: "Compra revisada" } });
      yield* nextPaint;
      fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
      yield* nextPaint;
      yield* Effect.tryPromise(() => screen.findByRole("button", { name: "Actualizar historial" }));
      expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeDisabled();
      expect(screen.getByRole("alert")).toHaveTextContent(
        result === "rejected" ? "No se guardaron los cambios" : "No pudimos confirmar los cambios"
      );
      fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
      yield* nextPaint;
      expect(requests.bodies).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "Actualizar historial" }));
      yield* nextPaint;
      yield* Effect.tryPromise(() => screen.findByLabelText("Resumen de transacciones"));
      expect(requests.bodies).toHaveLength(1);
    })
  )
);

it("opens corrections from transaction type and lets the user switch records", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      renderBulkJourney();
      fireEvent.click(
        yield* Effect.tryPromise(() =>
          screen.findByRole("button", { name: "Ver tipo de El Corral" })
        )
      );
      yield* nextPaint;
      expect(screen.getByLabelText("Contraparte")).toHaveValue("El Corral");
      fireEvent.input(screen.getByLabelText("Contraparte"), { target: { value: "Borrador" } });
      yield* nextPaint;
      fireEvent.click(screen.getByRole("button", { name: "Ver transacción Éxito" }));
      yield* nextPaint;
      expect(screen.getByLabelText("Contraparte")).toHaveValue("Éxito");
      fireEvent.click(screen.getByRole("button", { name: "Ver monto de El Corral" }));
      yield* nextPaint;
      expect(screen.getByLabelText("Contraparte")).toHaveValue("El Corral");
    })
  ));
it("saves a category from the ledger directly without opening correction", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const requests = renderJourney();
      yield* Effect.tryPromise(() =>
        screen.findByRole("combobox", { name: "Cambiar categoría de El Corral" })
      );
      selectChoice("Cambiar categoría de El Corral", "Mercado");
      yield* nextPaint;
      yield* Effect.tryPromise(() => screen.findByText("Categoría guardada"));
      expect(requests.updates()).toBe(1);
      expect(requests.updateBody()).toContain('"expectedRevision":0');
      expect(requests.updateBody()).toContain(
        '"categoryId":"24000000-0000-4000-8000-000000000099"'
      );
      expect(screen.queryByRole("form", { name: "Corregir transacción" })).not.toBeInTheDocument();
      expect(screen.getByLabelText("Resumen de transacciones")).toBeInTheDocument();
    })
  ));
it("blocks repeating an uncertain inline category correction", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const requests = renderJourney(true);
      yield* Effect.tryPromise(() =>
        screen.findByRole("combobox", { name: "Cambiar categoría de El Corral" })
      );
      selectChoice("Cambiar categoría de El Corral", "Mercado");
      yield* nextPaint;
      yield* Effect.tryPromise(() => screen.findByRole("alert"));
      expect(
        screen.getByRole("combobox", { name: "Cambiar categoría de El Corral" })
      ).toBeDisabled();
      expect(requests.updates()).toBe(1);
      fireEvent.click(screen.getByRole("button", { name: "Actualizar historial" }));
      yield* nextPaint;
      yield* Effect.tryPromise(() => screen.findByLabelText("Resumen de transacciones"));
      expect(requests.updates()).toBe(1);
    })
  ));

it("sends every explicitly changed bulk fact and keeps the selected local date", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const requests = renderBulkJourney();
      yield* selectBulkRecords;
      selectChoice("Categoría de la selección", "Mercado");
      selectChoice("Tipo de la selección", "Ingreso");
      fireEvent.input(screen.getByLabelText("Contraparte"), {
        target: { value: "  Nueva contraparte  " },
      });
      yield* nextPaint;
      fireEvent.input(screen.getByLabelText("Monto ($)"), { target: { value: "125,50" } });
      yield* nextPaint;
      fireEvent.input(screen.getByLabelText("Notas"), { target: { value: "Compra revisada" } });
      yield* nextPaint;
      fireEvent.input(screen.getByLabelText("Fecha"), { target: { value: "2026-10-08" } });
      yield* nextPaint;
      fireEvent.input(screen.getByLabelText("Fecha"), { target: { value: "" } });
      yield* nextPaint;
      fireEvent.input(screen.getByLabelText("Fecha"), { target: { value: "2026-10-08" } });
      yield* nextPaint;
      fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
      yield* nextPaint;
      yield* Effect.tryPromise(() => screen.findByLabelText("Resumen de transacciones"));
      const request = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        Option.getOrThrow(Option.fromNullishOr(requests.bodies[0]))
      );
      const changes = {
        categoryId: "24000000-0000-4000-8000-000000000099",
        direction: "inflow",
        counterparty: "Nueva contraparte",
        notes: "Compra revisada",
        money: { amount: "125.5", currency: "COP" },
        occurredAt: "2026-10-08T05:00:00.000Z",
      };
      expect(request).toMatchObject({
        calls: [
          { input: { payload: { expectedRevision: 0, changes } } },
          { input: { payload: { expectedRevision: 4, changes } } },
        ],
      });
    })
  ));

it.each(["-1", "125.123"])("refuses invalid bulk Money %s without issuing a batch", (amount) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const requests = renderBulkJourney();
      yield* selectBulkRecords;
      fireEvent.input(screen.getByLabelText("Monto ($)"), { target: { value: amount } });
      yield* nextPaint;
      fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
      yield* nextPaint;
      expect(screen.getByRole("alert")).toHaveTextContent("Revisa los cambios");
      expect(requests.bodies).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
      yield* nextPaint;
      expect(screen.getByLabelText("Resumen de transacciones")).toBeVisible();
    })
  )
);

it("clears optional correction facts and sends the chosen type, category and date", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const requests = renderJourney();
      fireEvent.click(
        yield* Effect.tryPromise(() =>
          screen.findByRole("button", { name: "Ver transacción El Corral" })
        )
      );
      yield* nextPaint;
      fireEvent.input(screen.getByLabelText("Contraparte"), { target: { value: " " } });
      yield* nextPaint;
      fireEvent.input(screen.getByLabelText("Notas"), { target: { value: " " } });
      yield* nextPaint;
      selectChoice("Tipo", "Ingreso");
      selectChoice("Categoría", "Mercado");
      fireEvent.input(screen.getByLabelText("Fecha"), { target: { value: "2026-10-08" } });
      yield* nextPaint;
      fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
      yield* nextPaint;
      yield* Effect.tryPromise(() => waitForMutation(requests.updates));
      expect(
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(requests.updateBody())
      ).toMatchObject({
        expectedRevision: 0,
        changes: {
          counterparty: null,
          notes: null,
          direction: "inflow",
          categoryId: "24000000-0000-4000-8000-000000000099",
          occurredAt: "2026-10-08T05:00:00.000Z",
        },
      });
    })
  ));

it("closes an unchanged correction without issuing a mutation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const requests = renderJourney();
      fireEvent.click(
        yield* Effect.tryPromise(() =>
          screen.findByRole("button", { name: "Ver transacción El Corral" })
        )
      );
      yield* nextPaint;
      fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
      yield* nextPaint;
      expect(screen.getByLabelText("Resumen de transacciones")).toBeVisible();
      expect(requests.updates()).toBe(0);
    })
  ));

it("allows shared notes but prevents a shared amount across different currencies", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const requests = renderBulkJourney("saved", true);
      yield* selectBulkRecords;
      expect(screen.getByLabelText("Monto ($)")).toBeDisabled();
      expect(screen.getByText(/selecciona transacciones con la misma moneda/u)).toBeVisible();
      fireEvent.input(screen.getByLabelText("Notas"), { target: { value: "Compra revisada" } });
      yield* nextPaint;
      fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
      yield* nextPaint;
      yield* Effect.tryPromise(() => screen.findByLabelText("Resumen de transacciones"));
      const request = yield* Schema.decodeEffect(bulkRequest)(
        Option.getOrThrow(Option.fromNullishOr(requests.bodies[0]))
      );
      for (const call of request.calls) {
        expect(call.input.payload.changes).toEqual({ notes: "Compra revisada" });
      }
    })
  ));

it("trims a changed counterparty and retains the explicitly changed notes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const requests = renderJourney();
      fireEvent.click(
        yield* Effect.tryPromise(() =>
          screen.findByRole("button", { name: "Ver transacción El Corral" })
        )
      );
      yield* nextPaint;
      fireEvent.input(screen.getByLabelText("Contraparte"), {
        target: { value: "  Nueva contraparte  " },
      });
      yield* nextPaint;
      fireEvent.input(screen.getByLabelText("Notas"), {
        target: { value: "  Nota revisada  " },
      });
      yield* nextPaint;
      fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
      yield* nextPaint;
      yield* Effect.tryPromise(() => waitForMutation(requests.updates));
      expect(
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(requests.updateBody())
      ).toMatchObject({
        changes: { counterparty: "Nueva contraparte", notes: "Nota revisada" },
      });
    })
  ));

const historyCursor =
  "2026-10-09T12:30:00.000Z|2026-10-09T12:30:00.000Z|24000000-0000-4000-8000-000000000002";
type PaginationFixture = {
  mode: "ready" | "failure" | "repeat" | "wrong-period" | "missing-args";
  requests: Array<string>;
  gate: Effect.Effect<void>;
};
const paginationQuery = (request: HttpClientRequest.HttpClientRequest): Record<string, string> =>
  Object.fromEntries([...new URL(request.url).searchParams, ...request.urlParams]);
const paginationSuggestion = (
  request: HttpClientRequest.HttpClientRequest,
  fixture: PaginationFixture
): unknown => {
  const query = paginationQuery(request);
  return {
    tool: "transactions.listTransactions",
    hint: "Continue Transaction history.",
    ...(fixture.mode === "missing-args"
      ? {}
      : {
          args: {
            query: {
              from: fixture.mode === "wrong-period" ? "2026-09-01T05:00:00Z" : query.from,
              to: query.to,
              cursor: historyCursor,
            },
          },
        }),
  };
};
const renderPaginationJourney = (fixture: PaginationFixture): void => {
  const client = HttpClient.make((request) => {
    if (request.url.endsWith("/user")) {
      return Effect.succeed(jsonResponse(request, storedUser));
    }
    if (request.url.endsWith("/categories")) {
      return Effect.succeed(jsonResponse(request, [{ id: categoryId, label: "Restaurantes" }]));
    }
    const query = paginationQuery(request);
    fixture.requests.push(query.cursor ?? "first");
    if (query.cursor === undefined) {
      return Effect.succeed(
        wireResponse(request, {
          data: [storedTransaction],
          next: [paginationSuggestion(request, fixture)],
        })
      );
    }
    if (fixture.mode === "failure") {
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request }),
        })
      );
    }
    const last = {
      ...storedTransaction,
      id: "24000000-0000-4000-8000-000000000003",
      counterparty: "La Cocina",
    };
    return fixture.gate.pipe(
      Effect.as(
        wireResponse(request, {
          data: [storedTransaction, last],
          next: fixture.mode === "repeat" ? [paginationSuggestion(request, fixture)] : [],
        })
      )
    );
  });
  mountJourney(client);
};
const waitForFirstPage = (): Promise<void> =>
  waitFor(() =>
    expect(screen.getAllByRole("button", { name: /^Ver transacción/ })).toHaveLength(1)
  );
const firstPaginationRow = (): Promise<HTMLElement> =>
  screen.findByRole("button", { name: "Ver transacción El Corral" });
it("retains loaded scope while a continuation waits, appends unique rows and refreshes to page one", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const fixture: PaginationFixture = {
        mode: "ready",
        requests: [],
        gate: Deferred.await(gate),
      };
      renderPaginationJourney(fixture);
      yield* Effect.tryPromise(firstPaginationRow);

      fireEvent.input(screen.getByLabelText("Buscar transacciones"), {
        target: { value: "La Cocina" },
      });
      yield* nextPaint;
      expect(
        screen.getByText("No hay coincidencias entre las transacciones cargadas")
      ).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Cargar más transacciones" }));
      yield* nextPaint;
      yield* Effect.tryPromise(() =>
        screen.findByRole("button", { name: "Cargando más transacciones…" })
      );
      expect(screen.getByRole("button", { name: "Cargando más transacciones…" })).toBeDisabled();
      yield* Deferred.succeed(gate, undefined);
      yield* Effect.tryPromise(() =>
        screen.findByRole("button", { name: "Ver transacción La Cocina" })
      );
      fireEvent.click(screen.getByRole("button", { name: "Limpiar filtros" }));
      yield* nextPaint;
      expect(screen.getAllByRole("button", { name: /^Ver transacción/ })).toHaveLength(2);
      expect(
        screen.queryByRole("button", { name: "Cargar más transacciones" })
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Actualizar transacciones" }));
      yield* nextPaint;
      yield* Effect.tryPromise(waitForFirstPage);
      expect(fixture.requests).toEqual(["first", historyCursor, "first"]);
    })
  ));
it("retains rows after continuation transport failure and retries the same cursor", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture: PaginationFixture = { mode: "failure", requests: [], gate: Effect.void };
      renderPaginationJourney(fixture);
      yield* Effect.tryPromise(firstPaginationRow);
      fireEvent.click(screen.getByRole("button", { name: "Cargar más transacciones" }));
      yield* nextPaint;
      const retry = yield* Effect.tryPromise(() =>
        screen.findByRole("button", { name: "Reintentar carga de más transacciones" })
      );
      expect(screen.getByRole("button", { name: "Ver transacción El Corral" })).toBeVisible();
      fixture.mode = "ready";
      fireEvent.click(retry);
      yield* nextPaint;
      yield* Effect.tryPromise(() =>
        screen.findByRole("button", { name: "Ver transacción La Cocina" })
      );
      expect(fixture.requests.slice(1).every((cursor) => cursor === historyCursor)).toBe(true);
    })
  ));
it.each(["repeat", "wrong-period", "missing-args"] as const)(
  "rejects %s continuation without exposing boundary details and permits refresh",
  (mode) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture: PaginationFixture = { mode, requests: [], gate: Effect.void };
        renderPaginationJourney(fixture);
        yield* Effect.tryPromise(firstPaginationRow);
        if (mode === "repeat") {
          fireEvent.click(screen.getByRole("button", { name: "Cargar más transacciones" }));
          yield* nextPaint;
          yield* Effect.tryPromise(() =>
            screen.findByRole("button", { name: "Ver transacción La Cocina" })
          );
          fireEvent.click(screen.getByRole("button", { name: "Cargar más transacciones" }));
          yield* nextPaint;
        }
        yield* Effect.tryPromise(() =>
          screen.findByText(/No pudimos actualizar las transacciones/u)
        );
        expect(
          screen.queryByText(/Invalid Transaction|Repeated Transaction/)
        ).not.toBeInTheDocument();
        fixture.mode = "ready";
        fireEvent.click(screen.getByRole("button", { name: "Actualizar historial" }));
        yield* nextPaint;
        yield* Effect.tryPromise(() =>
          screen.findByRole("button", { name: "Cargar más transacciones" })
        );
        expect(screen.getAllByRole("button", { name: /^Ver transacción/ })).toHaveLength(1);
      })
    )
);
