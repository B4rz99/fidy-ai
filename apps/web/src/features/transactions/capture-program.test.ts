import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupFoldkit, renderFoldkit } from "@/testing/foldkit";
import { makeFidyClient } from "@/transport/client";
import { mountTransactionCapture } from "./capture-program";

const created = {
  id: "24000000-0000-4000-8000-000000000002",
  categoryId: "24000000-0000-4000-8000-000000000001",
  money: { amount: "125.50", currency: "COP" },
  counterparty: "La Cocina",
  direction: "outflow",
  occurredAt: "2026-10-08T05:00:00Z",
  createdAt: "2026-10-11T12:30:00Z",
  revision: 0,
};
const mount = (
  httpClient: HttpClient.HttpClient
): Readonly<{
  created: ReturnType<typeof vi.fn>;
  history: ReturnType<typeof vi.fn>;
  dispose: () => void;
}> => {
  const client = makeFidyClient({
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(HttpClient.HttpClient, httpClient),
  });
  const registry = AtomRegistry.make();
  const onCreated = vi.fn();
  const onCheckHistory = vi.fn();
  const mounted = renderFoldkit((container) => {
    const dispose = mountTransactionCapture({
      container,
      client,
      resources: registry.get(client.runtime.layer),
      timeZone: "America/Bogota",
      onCreated,
      onStatus: vi.fn(),
      onCheckHistory,
    });
    return (): void => {
      dispose();
      registry.dispose();
    };
  });
  return { created: onCreated, history: onCheckHistory, dispose: mounted.unmount };
};
const fill = (label: string, value: string): void => {
  fireEvent.input(screen.getByLabelText(label), { target: { value } });
};
const submit = (): void => {
  fireEvent.submit(screen.getByRole("form", { name: "Registrar transacción" }));
};
afterEach(() => {
  cleanupFoldkit();
  vi.restoreAllMocks();
});
it("sends exact decimal Money and local-day UTC bounds only after valid input", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const bodies: string[] = [];
      const mounted = mount(
        HttpClient.make((request) => {
          if (request.body._tag === "Uint8Array") {
            bodies.push(new TextDecoder().decode(request.body.body));
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ data: created, next: [] }, { status: 201 })
            )
          );
        })
      );
      yield* Effect.tryPromise(() => screen.findByLabelText("Monto ($)"));
      fill("Monto ($)", "125.501");
      fill("Fecha del movimiento", "2026-10-08");
      submit();
      yield* Effect.tryPromise(() => screen.findByRole("alert"));
      expect(bodies).toHaveLength(0);
      fill("Monto ($)", "125,50");
      fill("Contraparte (opcional)", "  La Cocina  ");
      submit();
      yield* Effect.tryPromise(() =>
        waitFor(() => expect(mounted.created).toHaveBeenCalledTimes(1))
      );
      const body = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        Option.getOrThrow(Option.fromNullishOr(bodies[0]))
      );
      expect(body).toEqual({
        money: { amount: "125.5", currency: "COP" },
        direction: "outflow",
        counterparty: "La Cocina",
        occurredAt: "2026-10-08T05:00:00.000Z",
      });
      yield* Effect.tryPromise(() => screen.findByText("Transacción guardada."));
      expect(screen.getByLabelText("Monto ($)")).toHaveValue("");
    })
  ));
it("requires checking history after a lost acknowledgement and never repeats creation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let captures = 0;
      const mounted = mount(
        HttpClient.make((request) => {
          captures += 1;
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request }),
            })
          );
        })
      );
      yield* Effect.tryPromise(() => screen.findByLabelText("Monto ($)"));
      fill("Monto ($)", "25000");
      submit();
      yield* Effect.tryPromise(() =>
        screen.findByText(
          "No pudimos confirmar el registro de la transacción. Revisa el historial antes de registrar otro movimiento."
        )
      );
      expect(screen.getByRole("button", { name: "Registrar transacción" })).toBeDisabled();
      submit();
      expect(captures).toBe(1);
      expect(mounted.created).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Actualizar historial" }));
      yield* Effect.tryPromise(() =>
        waitFor(() => expect(mounted.history).toHaveBeenCalledTimes(1))
      );
    })
  ));
it("disables duplicate creation and cancels pending work when unmounted", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let requests = 0;
      const mounted = mount(
        HttpClient.make(() => {
          requests += 1;
          return Effect.never;
        })
      );
      yield* Effect.tryPromise(() => screen.findByLabelText("Monto ($)"));
      fill("Monto ($)", "25000");
      submit();
      submit();
      yield* Effect.tryPromise(() => waitFor(() => expect(requests).toBe(1)));
      expect(screen.getByRole("button", { name: "Guardando…" })).toBeDisabled();
      mounted.dispose();
      expect(mounted.created).not.toHaveBeenCalled();
      expect(screen.queryByLabelText("Monto ($)")).not.toBeInTheDocument();
    })
  ));
