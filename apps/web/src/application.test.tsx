import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { Effect, Layer, Option } from "effect";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebApplication } from "@/app/application";
import { createWebRouter } from "@/app/routes";
import { SessionRegistryProvider } from "@/session/session";
import {
  type FidyClient,
  type WebAuthClient,
  makeFidyClient,
  makeWebAuthClient,
} from "@/transport/client";

const responseJson = (
  request: HttpClientRequest.HttpClientRequest,
  body: unknown
): HttpClientResponse.HttpClientResponse => {
  const encoded = new TextEncoder().encode(JSON.stringify(body));
  const realmBytes = new window.Uint8Array(encoded.length);
  realmBytes.set(encoded);
  const response = new Response(encoded, { headers: { "content-type": "application/json" } });
  Object.defineProperty(response, "arrayBuffer", {
    value: () => Promise.resolve(realmBytes.buffer),
  });
  return HttpClientResponse.fromWeb(request, response);
};

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
  apiClient = makeFidyClient("https://api.test.fidyapp.com"),
  webAuthClient: WebAuthClient = makeWebAuthClient("https://api.test.fidyapp.com")
): Promise<void> => {
  const router = createWebRouter({
    apiClient,
    webAuthClient,
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

const emailReplacementClients = (
  requests: Array<string>
): Readonly<{ apiClient: FidyClient; webAuthClient: WebAuthClient }> => {
  const httpClient = makeHttpClient((request) => {
    requests.push(new URL(request.url).pathname);
    return Effect.succeed(
      responseJson(
        request,
        request.url.endsWith("/web/email/replacement/verify")
          ? { status: "replaced" }
          : { data: { status: "pending" }, next: [] }
      )
    );
  });
  const layer = Layer.succeed(HttpClient.HttpClient, httpClient);
  return {
    apiClient: makeFidyClient("https://api.test.fidyapp.com", layer),
    webAuthClient: makeWebAuthClient("https://api.test.fidyapp.com", layer),
  };
};

const submitRenderedEmailReplacement = async (requests: Array<string>): Promise<void> => {
  fireEvent.change(await screen.findByLabelText("Nuevo correo"), {
    target: { value: "new.mailbox@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Enviar código" }));
  expect(await screen.findByText("Enviamos un código a new.mailbox@example.com.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Reenviar código" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  fireEvent.change(await screen.findByLabelText("Código de verificación"), {
    target: { value: "bcdf-ghjk-mnpq-rstw-xy23-4567" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Cambiar correo" }));
  expect(await screen.findByText("Tu nuevo correo verificado ya está activo.")).toBeVisible();
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

  it("runs verified-email replacement through the rendered route and typed clients", async () => {
    localStorage.clear();
    sessionStorage.clear();
    const requests: Array<string> = [];
    const clients = emailReplacementClients(requests);
    await renderRoute("/settings/email", clients.apiClient, clients.webAuthClient);
    await submitRenderedEmailReplacement(requests);
    expect(requests).toEqual([
      "/email/replacement",
      "/email/replacement",
      "/web/email/replacement/verify",
    ]);
    expect(window.location.search).toBe("");
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("owns the authenticated Subscription offer page at /upgrade", async () => {
    await renderRoute("/upgrade", malformedFidyClient());

    expect(await screen.findByRole("heading", { name: "Mejora tu suscripción" })).toBeVisible();
    expect(await screen.findByText("No pudimos cargar las ofertas")).toBeVisible();
  });

  it("owns the Dashboard at /app/dashboard and routes malformed canonical data to failure", async () => {
    await renderRoute("/app/dashboard", malformedFidyClient());

    expect(
      await screen.findByText("No pudimos cargar tu tablero", undefined, { timeout: 3_000 })
    ).toBeVisible();
  });

  it("redirects the authenticated /app index to the Dashboard", async () => {
    await renderRoute("/app", malformedFidyClient());

    expect(
      await screen.findByText("No pudimos cargar tu tablero", undefined, { timeout: 3_000 })
    ).toBeVisible();
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
