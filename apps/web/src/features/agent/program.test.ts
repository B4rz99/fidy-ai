import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupFoldkit, renderFoldkit } from "@/testing/foldkit";
import { makeHostedTurnClient } from "@/transport/client";
import { mountHostedAgent } from "./program";

afterEach(() => {
  cleanupFoldkit();
  vi.restoreAllMocks();
});
const receiptLength = 64;
const proposedStatus = 202;
const renderAgent = (paths: string[]): ReturnType<typeof renderFoldkit> => {
  const client = makeHostedTurnClient({
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        paths.push(new URL(request.url).pathname);
        const delivery = request.url.endsWith("/delivery");
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              delivery
                ? { status: "completed" }
                : {
                    text: "Respuesta privada",
                    turnId: "10000000-0000-4000-8000-000000000097",
                    receipt: "a".repeat(receiptLength),
                  },
              { status: delivery ? 200 : proposedStatus }
            )
          )
        );
      })
    ),
  });
  const registry = AtomRegistry.make();
  return renderFoldkit((container): (() => void) => {
    const dispose = mountHostedAgent({
      container,
      client,
      resources: registry.get(client.runtime.layer),
    });
    return () => {
      dispose();
      registry.dispose();
    };
  });
};
it("acknowledges a committed reply only after document visibility and removes observation on disposal", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      const paths: string[] = [];
      const mounted = renderAgent(paths);
      fireEvent.click(
        yield* Effect.tryPromise(() => screen.findByRole("button", { name: "Abrir agente Fidy" }))
      );
      fireEvent.input(yield* Effect.tryPromise(() => screen.findByLabelText("Mensaje")), {
        target: { value: "Hola" },
      });
      yield* Effect.tryPromise(() =>
        waitFor(() => expect(screen.getByRole("button", { name: "Enviar" })).toBeEnabled())
      );
      fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
      expect(yield* Effect.tryPromise(() => screen.findByText("Respuesta privada"))).toBeVisible();
      expect(paths).toEqual(["/web/hosted-turns"]);
      expect(mounted.container.textContent).not.toContain("a".repeat(receiptLength));
      visibility.mockReturnValue("visible");
      fireEvent(document, new Event("visibilitychange"));
      yield* Effect.tryPromise(() =>
        waitFor(() => expect(paths).toEqual(["/web/hosted-turns", "/web/hosted-turns/delivery"]))
      );
      mounted.unmount();
      fireEvent(document, new Event("visibilitychange"));
      expect(paths).toHaveLength(2);
    })
  ));
it("preserves composition and clears the private draft immediately when disposed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const paths: string[] = [];
      const mounted = renderAgent(paths);
      fireEvent.click(
        yield* Effect.tryPromise(() => screen.findByRole("button", { name: "Abrir agente Fidy" }))
      );
      const input = yield* Effect.tryPromise(() => screen.findByLabelText("Mensaje"));
      fireEvent.input(input, { target: { value: "Mensaje sin enviar" } });
      fireEvent.keyDown(input, { key: "Enter", isComposing: true });
      fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
      expect(paths).toEqual([]);
      mounted.unmount();
      expect(input).toHaveValue("");
    })
  ));
