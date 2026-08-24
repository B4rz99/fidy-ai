import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { Effect, Layer, Option } from "effect";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebApplication } from "@/app/application";
import { createWebRouter } from "@/app/routes";
import { SessionRegistryProvider } from "@/session/session";
import { type FidyClient, makeFidyClient, makeWebAuthClient } from "@/transport/client";

const responseJson = (
  request: HttpClientRequest.HttpClientRequest,
  body: unknown
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  );

const makeHttpClient = (
  handler: (
    request: HttpClientRequest.HttpClientRequest
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>
): HttpClient.HttpClient =>
  HttpClient.makeWith<
    HttpClientError.HttpClientError,
    never,
    HttpClientError.HttpClientError,
    never
  >((effect) => Effect.flatMap(effect, handler), Effect.succeed);

const renderRoute = async (
  path: string,
  apiClient = makeFidyClient("https://api.test.fidyapp.com")
): Promise<void> => {
  const apiOrigin = "https://api.test.fidyapp.com";
  const router = createWebRouter({
    apiClient,
    webAuthClient: makeWebAuthClient(apiOrigin),
    history: Option.some(createMemoryHistory({ initialEntries: [path] })),
  });

  render(
    <SessionRegistryProvider>
      <RouterProvider router={router} />
    </SessionRegistryProvider>
  );
  await router.load();
};

const resetApplicationTest = (): void => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
};

const malformedFidyClient = (): FidyClient => {
  const httpClient = makeHttpClient((request) =>
    Effect.succeed(responseJson(request, { unexpected: true }))
  );
  return makeFidyClient(
    "https://api.test.fidyapp.com",
    Layer.succeed(HttpClient.HttpClient, httpClient)
  );
};

describe("public web application routes", () => {
  afterEach(resetApplicationTest);
  it("renders the minimal root through the real router and Atom provider", async () => {
    await renderRoute("/");

    expect(await screen.findByRole("heading", { level: 1, name: "Fidy" })).toBeVisible();
  });

  it("renders the authoritative policy at its stable route", async () => {
    await renderRoute("/politica");

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Política de tratamiento de datos personales",
      })
    ).toBeVisible();
    expect(screen.getByText("policy-2026-08-03")).toBeVisible();
    expect(screen.getByText(/Fidy usa OpenAI/iu)).toBeVisible();
    expect(screen.getByText(/Estados Unidos/iu)).toBeVisible();
    expect(screen.queryByText(/cuentas|saldos/iu)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /términos de servicio/iu })).not.toBeInTheDocument();
  });

  it("does not start browser pairing merely by opening its route", async () => {
    await renderRoute("/auth/pair");

    expect(await screen.findByRole("heading", { name: "Inicia sesión en Fidy" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Iniciar sesión en el navegador" })).toBeVisible();
    expect(screen.queryByText(/pairing code/iu)).not.toBeInTheDocument();
  });
});

describe("signed-in web application routes", () => {
  afterEach(resetApplicationTest);

  it("owns Transactions at /app/transactions and routes malformed canonical data to failure", async () => {
    await renderRoute("/app/transactions", malformedFidyClient());

    expect(await screen.findByText("No pudimos cargar tus transacciones")).toBeVisible();
  });

  it("owns the authenticated Subscription offer page at /upgrade", async () => {
    await renderRoute("/upgrade", malformedFidyClient());

    expect(await screen.findByRole("heading", { name: "Mejora tu suscripción" })).toBeVisible();
    expect(await screen.findByText("No pudimos cargar las ofertas")).toBeVisible();
  });

  it("owns the Dashboard at /app/dashboard and routes malformed canonical data to failure", async () => {
    await renderRoute("/app/dashboard", malformedFidyClient());

    expect(await screen.findByText("No pudimos cargar tu tablero")).toBeVisible();
  });

  it("redirects the authenticated /app index to the Dashboard", async () => {
    await renderRoute("/app", malformedFidyClient());

    expect(await screen.findByText("No pudimos cargar tu tablero")).toBeVisible();
  });
});

describe("web application fallbacks", () => {
  afterEach(resetApplicationTest);

  it("renders not-found behavior for an unknown route", async () => {
    await renderRoute("/ruta-inexistente");

    expect(await screen.findByRole("heading", { name: "Página no encontrada" })).toBeVisible();
  });

  it("uses the configured browser application origin", async () => {
    vi.stubEnv("VITE_API_ORIGIN", "https://api.test.fidyapp.com");
    render(<WebApplication />);

    expect(await screen.findByRole("heading", { level: 1, name: "Fidy" })).toBeVisible();
  });
});
