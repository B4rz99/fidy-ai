import { RegistryProvider } from "@effect/atom-react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { DateTime, Deferred, Effect, Layer, Option, Schema } from "effect";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeFidyClient, makeHostedTurnClient, makeWebAuthClient } from "@/transport/client";
import { TransactionListFeature } from "./feature";

const findDetailAmount = (amount: string): Promise<HTMLElement> =>
  waitFor(() =>
    within(screen.getByRole("region", { name: "Detalle de transacción" })).getByText(amount)
  );
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
  const context = {
    apiClient: makeFidyClient(options),
    webAuthClient: makeWebAuthClient(options),
    hostedTurnClient: makeHostedTurnClient(options),
  };
  const root = createRootRouteWithContext<typeof context>()();
  const route = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: TransactionListFeature,
  });
  const router = createRouter({
    context,
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <RegistryProvider>
      <RouterProvider router={router} />
    </RegistryProvider>
  );
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
      return Effect.succeed(
        jsonResponse(request, {
          id: "24000000-0000-4000-8000-000000000241",
          serviceMarket: "CO",
          locale: "es-CO",
          timeZone: "America/Bogota",
          trialPeriod: { startedAt: "2026-10-01T00:00:00Z", endsAt: "2026-10-08T00:00:00Z" },
          createdAt: "2026-10-01T00:00:00Z",
        })
      );
    }
    if (request.url.endsWith("/categories")) {
      return Effect.succeed(jsonResponse(request, [{ id: categoryId, label: "Restaurantes" }]));
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
  cleanup();
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
      fireEvent.change(screen.getByLabelText("Monto ($)"), { target: { value: "30000" } });
      fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
      expect(yield* Effect.tryPromise(() => screen.findByText("Cambios guardados"))).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Cerrar detalle" }));
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
      fireEvent.change(screen.getByLabelText("Monto ($)"), { target: { value: "30000" } });
      fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
      expect(yield* Effect.tryPromise(() => screen.findByRole("alert"))).toHaveTextContent(
        "No pudimos confirmar los cambios"
      );
      expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
      expect(requests.updates()).toBe(1);
      fireEvent.click(screen.getByRole("button", { name: "Actualizar historial" }));
      fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
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
      fireEvent.change(screen.getByLabelText("Monto ($)"), { target: { value: "45000" } });
      fireEvent.change(screen.getByLabelText("Contraparte (opcional)"), {
        target: { value: "La Cocina" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Registrar transacción" }));
      const row = yield* Effect.tryPromise(() =>
        screen.findByRole("button", { name: "Ver transacción La Cocina" })
      );
      expect(screen.getByLabelText("Resumen de transacciones")).toBeVisible();
      fireEvent.click(row);
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
      expect(yield* Effect.tryPromise(() => screen.findByRole("dialog"))).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Cerrar detalle" }));
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
    act(() => {
      matches = desktop;
      listeners.forEach((listener) => listener());
    });
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
      fireEvent.change(screen.getByLabelText("Monto ($)"), { target: { value: "45000" } });
      resize(false);
      expect(screen.getByLabelText("Monto ($)")).toHaveValue("45000");
      resize(true);
      expect(screen.getByLabelText("Monto ($)")).toHaveValue("45000");
      fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
      fireEvent.click(screen.getByRole("button", { name: "Ver transacción El Corral" }));
      fireEvent.change(screen.getByLabelText("Monto ($)"), { target: { value: "30000" } });
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
      fireEvent.change(screen.getByLabelText("Monto ($)"), { target: { value: "30000" } });
      fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
      expect(
        yield* Effect.tryPromise(() => screen.findByRole("button", { name: "Guardando…" }))
      ).toBeDisabled();
      expect(screen.getByLabelText("Notas (opcional)")).toBeDisabled();
      resize(false);
      expect(screen.getByLabelText("Monto ($)")).toHaveValue("30000");
      expect(screen.getByLabelText("Notas (opcional)")).toBeDisabled();
      yield* Deferred.succeed(complete, undefined);
      expect(yield* Effect.tryPromise(() => findDetailAmount("$ 30.000,00"))).toBeVisible();
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
      const invalidAmounts = ["0", "-1", "not money", "1.001"];
      for (const amount of invalidAmounts) {
        fireEvent.change(screen.getByLabelText("Monto ($)"), { target: { value: amount } });
        fireEvent.submit(screen.getByRole("form", { name: "Corregir transacción" }));
        expect(screen.getByRole("alert")).toHaveTextContent("Revisa el monto");
        expect(requests.updates()).toBe(0);
      }
      fireEvent.change(screen.getByLabelText("Contraparte"), {
        target: { value: "Draft merchant" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^Tipo$/ }));
      fireEvent.click(screen.getByRole("menuitemradio", { name: /^Ingreso$/ }));
      fireEvent.change(screen.getByLabelText("Notas (opcional)"), {
        target: { value: "Draft notes" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
      expect(screen.getByRole("region", { name: "Resumen de transacciones" })).toBeVisible();
      expect(screen.queryByText("Draft merchant")).not.toBeInTheDocument();
      expect(requests.updates()).toBe(0);
      fireEvent.click(screen.getByRole("button", { name: "Ver transacción El Corral" }));
      expect(screen.getByLabelText("Monto ($)")).toHaveValue("25000");
      expect(screen.getByRole("button", { name: /^Tipo$/ })).toHaveTextContent("Gasto");
      expect(screen.getByLabelText("Notas (opcional)")).toHaveValue("");
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
const bulkUser = {
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
  result: "saved" | "rejected" | "uncertain" = "saved"
): Readonly<{ bodies: string[] }> => {
  let records = [...bulkRecords];
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
    if (request.url.endsWith("/user")) return Effect.succeed(jsonResponse(request, bulkUser));
    if (request.url.endsWith("/categories")) {
      return Effect.succeed(jsonResponse(request, [{ id: categoryId, label: "Restaurantes" }]));
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
  expect(screen.queryByLabelText("Resumen de transacciones")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Editar selección" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "Seleccionar El Corral" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Seleccionar Éxito" }));
  expect(screen.getByText("2 seleccionadas")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Editar selección" }));
}).pipe(Effect.orDie);
it("corrects only selected records atomically at their observed revisions", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const requests = renderBulkJourney();
      yield* selectBulkRecords;
      fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
      expect(screen.getByRole("alert")).toHaveTextContent("Revisa los campos");
      expect(requests.bodies).toHaveLength(0);
      fireEvent.change(screen.getByLabelText("Notas"), { target: { value: "Compra revisada" } });
      fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
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
      expect(screen.getByLabelText("Notas (opcional)")).toHaveValue("Compra revisada");
      fireEvent.click(screen.getByRole("button", { name: "Cerrar detalle" }));
      fireEvent.click(screen.getByRole("button", { name: "Ver transacción Transporte" }));
      expect(screen.getByLabelText("Notas (opcional)")).toHaveValue("");
    })
  ));
it.each(["rejected", "uncertain"] as const)("blocks replay after a %s bulk save", (result) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const requests = renderBulkJourney(result);
      yield* selectBulkRecords;
      fireEvent.change(screen.getByLabelText("Notas"), { target: { value: "Compra revisada" } });
      fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
      yield* Effect.tryPromise(() => screen.findByRole("button", { name: "Actualizar historial" }));
      expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeDisabled();
      expect(screen.getByRole("alert")).toHaveTextContent(
        result === "rejected" ? "No se guardó ningún cambio" : "No pudimos confirmar los cambios"
      );
      fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
      expect(requests.bodies).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "Actualizar historial" }));
      yield* Effect.tryPromise(() => screen.findByLabelText("Resumen de transacciones"));
      expect(requests.bodies).toHaveLength(1);
    })
  )
);
