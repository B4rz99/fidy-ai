import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, expect, it } from "vitest";
import { cleanupFoldkit, renderFoldkit } from "@/testing/foldkit";
import { makeWebAuthClient } from "@/transport/client";
import { mountConnectionContinuation } from "./program";

afterEach(cleanupFoldkit);
const attempt = "00000000-0000-4000-8000-000000000001";
const review = (expiresAt: string): unknown => ({
  connection: { id: attempt, institutionId: "bancolombia", state: "Connecting" },
  institutionName: "Bancolombia",
  expiresAt,
  phase: "ready",
});
const renderConnection = (respond: (url: string) => Response): void => {
  const client = makeWebAuthClient({
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => HttpClientResponse.fromWeb(request, respond(request.url)))
      )
    ),
  });
  const registry = AtomRegistry.make();
  renderFoldkit((container): (() => void) => {
    const dispose = mountConnectionContinuation({
      container,
      attempt,
      client,
      resources: registry.get(client.runtime.layer),
    });
    return () => {
      dispose();
      registry.dispose();
    };
  });
};

it("never repeats an uncertain preparation, including after a status refresh", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let begins = 0;
      renderConnection((url) => {
        if (url.endsWith("/begin")) {
          begins += 1;
          return Response.json({ error: { code: "continuation_unavailable" } }, { status: 503 });
        }
        return Response.json(review("2099-01-01T00:00:00.000Z"));
      });
      const begin = yield* Effect.tryPromise(() =>
        screen.findByRole("button", { name: "Continuar" })
      );
      expect(begins).toBe(0);
      fireEvent.click(begin);
      expect(
        yield* Effect.tryPromise(() => screen.findByText(/No pudimos confirmar el resultado/u))
      ).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Consultar estado" }));
      yield* Effect.tryPromise(() =>
        waitFor(() =>
          expect(screen.getByRole("button", { name: "Consultar estado" })).not.toBeDisabled()
        )
      );
      expect(screen.getByRole("button", { name: "Continuar" })).toBeDisabled();
      expect(begins).toBe(1);
    })
  ));

it("disables preparation when the original absolute deadline has passed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      renderConnection(() => Response.json(review("2000-01-01T00:00:00.000Z")));
      expect(
        yield* Effect.tryPromise(() =>
          screen.findByText("La solicitud venció. Inicia una nueva conexión.")
        )
      ).toBeVisible();
      expect(screen.getByRole("button", { name: "Continuar" })).toBeDisabled();
    })
  ));
