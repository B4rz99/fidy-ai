import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupFoldkit, renderFoldkit } from "@/testing/foldkit";
import { Category, Transaction, makeFidyClient } from "@/transport/client";
import type { EditorContext } from "./editor-draft";
import { mountTransactionEditor } from "./editor-program";

const firstCategory = Schema.decodeSync(Category)({
  id: "24000000-0000-4000-8000-000000000001",
  label: "Restaurantes",
});
const secondCategory = Schema.decodeSync(Category)({
  id: "24000000-0000-4000-8000-000000000004",
  label: "Mercado",
});
const transaction = Schema.decodeSync(Transaction)({
  id: "24000000-0000-4000-8000-000000000002",
  categoryId: firstCategory.id,
  money: { amount: "25000", currency: "COP" },
  counterparty: "El Corral",
  direction: "outflow",
  occurredAt: "2026-10-09T12:30:00Z",
  createdAt: "2026-10-09T12:30:00Z",
  revision: 3,
});
const encodeTransaction = Schema.encodeSync(Transaction);
const decodeTransaction = Schema.decodeSync(Transaction);
const mount = (
  mode: EditorContext["mode"],
  httpClient: HttpClient.HttpClient
): Readonly<{
  saved: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  dispose: () => void;
}> => {
  const client = makeFidyClient({
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(HttpClient.HttpClient, httpClient),
  });
  const registry = AtomRegistry.make();
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  const onRefresh = vi.fn();
  const mounted = renderFoldkit((container) => {
    const dispose = mountTransactionEditor({
      container,
      client,
      resources: registry.get(client.runtime.layer),
      mode,
      categories: [firstCategory, secondCategory],
      timeZone: "America/Bogota",
      onSaved,
      onCancel,
      onRefresh,
      onStatus: vi.fn(),
    });
    return (): void => {
      dispose();
      registry.dispose();
    };
  });
  return { saved: onSaved, cancel: onCancel, refresh: onRefresh, dispose: mounted.unmount };
};
const fill = (label: string, value: string): void => {
  fireEvent.input(screen.getByLabelText(label), { target: { value } });
};
const submit = (): void => {
  fireEvent.submit(screen.getByRole("form"));
};
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
afterEach(() => {
  cleanupFoldkit();
  vi.restoreAllMocks();
});
it("corrects only changed facts at the displayed revision", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const bodies: string[] = [];
      const mounted = mount(
        { _tag: "Single", transaction },
        HttpClient.make((request) => {
          if (request.body._tag === "Uint8Array") {
            bodies.push(new TextDecoder().decode(request.body.body));
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ data: encodeTransaction(transaction), next: [] })
            )
          );
        })
      );
      yield* Effect.tryPromise(() => screen.findByLabelText("Monto ($)"));
      fill("Monto ($)", "30000.001");
      submit();
      yield* Effect.tryPromise(() => screen.findByRole("alert"));
      expect(bodies).toHaveLength(0);
      fill("Monto ($)", "30000");
      fill("Contraparte", "");
      fill("Fecha", "2026-10-08");
      submit();
      yield* Effect.tryPromise(() => waitFor(() => expect(mounted.saved).toHaveBeenCalledTimes(1)));
      expect(decodeJson(bodies[0])).toEqual({
        expectedRevision: 3,
        changes: {
          money: { amount: "30000", currency: "COP" },
          counterparty: null,
          occurredAt: "2026-10-08T05:00:00.000Z",
        },
      });
    })
  ));
it("cancels an unchanged single correction without a mutation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const request = vi.fn(() => Effect.never);
      const mounted = mount({ _tag: "Single", transaction }, HttpClient.make(request));
      yield* Effect.tryPromise(() => screen.findByRole("button", { name: "Guardar cambios" }));
      submit();
      yield* Effect.tryPromise(() =>
        waitFor(() => expect(mounted.cancel).toHaveBeenCalledTimes(1))
      );
      expect(request).not.toHaveBeenCalled();
    })
  ));
it("locks an uncertain correction until history is refreshed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let requests = 0;
      const mounted = mount(
        { _tag: "Single", transaction },
        HttpClient.make((request) => {
          requests += 1;
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request }),
            })
          );
        })
      );
      yield* Effect.tryPromise(() => screen.findByLabelText("Monto ($)"));
      fill("Monto ($)", "30000");
      submit();
      yield* Effect.tryPromise(() =>
        screen.findByText(
          "No pudimos confirmar los cambios. Actualiza el historial antes de volver a editar."
        )
      );
      expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeDisabled();
      submit();
      expect(requests).toBe(1);
      fireEvent.click(screen.getByRole("button", { name: "Actualizar historial" }));
      yield* Effect.tryPromise(() =>
        waitFor(() => expect(mounted.refresh).toHaveBeenCalledTimes(1))
      );
      expect(mounted.saved).not.toHaveBeenCalled();
    })
  ));
it("disables bulk amount changes across currencies", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const other = decodeTransaction({
        ...encodeTransaction(transaction),
        id: "24000000-0000-4000-8000-000000000003",
        money: { amount: "25", currency: "USD" },
      });
      mount(
        { _tag: "Bulk", transactions: [transaction, other] },
        HttpClient.make(() => Effect.never)
      );
      yield* Effect.tryPromise(() => screen.findByLabelText("Monto ($)"));
      expect(screen.getByLabelText("Monto ($)")).toBeDisabled();
      expect(
        screen.getByText(
          "Para cambiar el monto en conjunto, selecciona transacciones con la misma moneda."
        )
      ).toBeVisible();
      submit();
      yield* Effect.tryPromise(() => screen.findByRole("alert"));
    })
  ));

it("sends one atomic revision-bound batch for explicitly changed bulk facts and never replays uncertainty", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const other = decodeTransaction({
        ...encodeTransaction(transaction),
        id: "24000000-0000-4000-8000-000000000003",
        revision: 7,
      });
      const bodies: string[] = [];
      mount(
        { _tag: "Bulk", transactions: [transaction, other] },
        HttpClient.make((request) => {
          if (request.body._tag === "Uint8Array") {
            bodies.push(new TextDecoder().decode(request.body.body));
          }
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request }),
            })
          );
        })
      );
      yield* Effect.tryPromise(() => screen.findByLabelText("Notas"));
      fill("Notas", "Compra revisada");
      fill("Monto ($)", "125,50");
      fill("Fecha", "2026-10-08");
      fireEvent.change(screen.getByLabelText("Categoría de la selección"), {
        target: { value: secondCategory.id },
      });
      submit();
      yield* Effect.tryPromise(() => screen.findByRole("alert"));
      expect(bodies).toHaveLength(1);
      const changes = {
        notes: "Compra revisada",
        money: { amount: "125.5", currency: "COP" },
        categoryId: secondCategory.id,
        occurredAt: "2026-10-08T05:00:00.000Z",
      };
      expect(decodeJson(bodies[0])).toEqual({
        calls: [
          {
            callId: expect.any(String),
            operation: "transactions.updateTransaction",
            input: { params: { id: transaction.id }, payload: { expectedRevision: 3, changes } },
          },
          {
            callId: expect.any(String),
            operation: "transactions.updateTransaction",
            input: { params: { id: other.id }, payload: { expectedRevision: 7, changes } },
          },
        ],
      });
      submit();
      expect(bodies).toHaveLength(1);
    })
  ));
