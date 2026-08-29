import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { Effect, Layer, Option } from "effect";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebApplication } from "@/app/application";
import { createWebRouter } from "@/app/routes";
import { SessionRegistryProvider } from "@/session/session";
import {
  BackupRecoveryCode,
  type FidyClient,
  type WebAuthClient,
  makeFidyClient,
  makeSubscriptionEnrollmentClient,
  makeWebAuthClient,
} from "@/transport/client";

const responseJson = (
  request: HttpClientRequest.HttpClientRequest,
  body: unknown,
  status = 200
): HttpClientResponse.HttpClientResponse => {
  const encoded = new TextEncoder().encode(JSON.stringify(body));
  const realmBytes = new window.Uint8Array(encoded.length);
  realmBytes.set(encoded);
  const response = new Response(encoded, {
    status,
    headers: { "content-type": "application/json" },
  });
  Object.defineProperty(response, "arrayBuffer", {
    value: () => Promise.resolve(realmBytes.buffer),
  });
  return HttpClientResponse.fromWeb(request, response);
};

const responseNoContent = (
  request: HttpClientRequest.HttpClientRequest
): HttpClientResponse.HttpClientResponse => {
  const response = new Response(null, { status: 204 });
  Object.defineProperty(response, "arrayBuffer", {
    value: () => Promise.resolve(new window.Uint8Array().buffer),
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
): Promise<ReturnType<typeof createWebRouter>> => {
  const router = createWebRouter({
    apiClient,
    webAuthClient,
    subscriptionEnrollmentClient: makeSubscriptionEnrollmentClient("https://api.test.fidyapp.com"),
    history: Option.some(createMemoryHistory({ initialEntries: [path] })),
  });

  render(
    <SessionRegistryProvider>
      <RouterProvider router={router} />
    </SessionRegistryProvider>
  );
  await router.load();
  return router;
};

const resetApplicationTest = (): void => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
};

type StubResponse = Readonly<{ status: number; body: unknown }>;

const successfulReplacementRequest: StubResponse = {
  status: 200,
  body: { data: { status: "pending" }, next: [] },
};
const successfulReplacementCompletion: StubResponse = {
  status: 200,
  body: { status: "replaced" },
};

const emailReplacementClients = (
  requests: Array<string>,
  requestResponse = successfulReplacementRequest,
  completionResponse = successfulReplacementCompletion
): Readonly<{ apiClient: FidyClient; webAuthClient: WebAuthClient }> => {
  const httpClient = makeHttpClient((request) => {
    requests.push(new URL(request.url).pathname);
    const response = request.url.endsWith("/web/email/replacement/verify")
      ? completionResponse
      : requestResponse;
    return Effect.succeed(responseJson(request, response.body, response.status));
  });
  const layer = Layer.succeed(HttpClient.HttpClient, httpClient);
  return {
    apiClient: makeFidyClient("https://api.test.fidyapp.com", layer),
    webAuthClient: makeWebAuthClient("https://api.test.fidyapp.com", layer),
  };
};

const recoveryClients = (): Readonly<{
  apiClient: FidyClient;
  webAuthClient: WebAuthClient;
  requests: Array<string>;
}> => {
  const requests: Array<string> = [];
  const httpClient = makeHttpClient((request) => {
    requests.push(new URL(request.url).pathname);
    if (request.url.endsWith("/web/session/logout")) {
      return Effect.succeed(responseNoContent(request));
    }
    return Effect.succeed(
      responseJson(request, {
        data: {
          status: "rotated",
          backupRecoveryCode: "ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2",
          rotatedAt: "2026-08-28T03:00:00Z",
        },
        next: [],
      })
    );
  });
  const layer = Layer.succeed(HttpClient.HttpClient, httpClient);
  return {
    apiClient: makeFidyClient("https://api.test.fidyapp.com", layer),
    webAuthClient: makeWebAuthClient("https://api.test.fidyapp.com", layer),
    requests,
  };
};

const beginRenderedEmailReplacement = async (candidateEmail: string): Promise<void> => {
  fireEvent.change(await screen.findByLabelText("Nuevo correo"), {
    target: { value: candidateEmail },
  });
  fireEvent.click(screen.getByRole("button", { name: "Enviar código" }));
  expect(await screen.findByText(`Enviamos un código a ${candidateEmail}.`)).toBeVisible();
};

const enterReplacementCode = async (): Promise<void> => {
  fireEvent.change(await screen.findByLabelText("Código de verificación"), {
    target: { value: "BCDF-GHJK-MNPQ-RSTW-XY23-4567" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Cambiar correo" }));
};

const submitRenderedEmailReplacement = async (requests: Array<string>): Promise<void> => {
  await beginRenderedEmailReplacement("new.mailbox@example.com");
  fireEvent.click(screen.getByRole("button", { name: "Reenviar código" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  await enterReplacementCode();
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
});

describe("backup recovery route", () => {
  afterEach(resetApplicationTest);

  it("drops one-time disclosure through navigation, logout, and a fresh application mount", async () => {
    const code = BackupRecoveryCode.make("ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2");
    const clients = recoveryClients();
    const router = await renderRoute(
      "/settings/recovery",
      clients.apiClient,
      clients.webAuthClient
    );

    fireEvent.click(await screen.findByRole("button", { name: "Crear un código nuevo" }));
    expect(await screen.findByText(code)).toBeVisible();

    await act(() => router.navigate({ to: "/settings/email" }));
    expect(screen.queryByText(code)).not.toBeInTheDocument();
    await act(() => router.navigate({ to: "/settings/recovery" }));
    expect(screen.queryByText(code)).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "Crear un código nuevo" }));
    expect(await screen.findByText(code)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    await waitFor(() => expect(clients.requests).toContain("/web/session/logout"));
    expect(await screen.findByRole("heading", { name: "Inicia sesión en Fidy" })).toBeVisible();
    expect(screen.queryByText(code)).not.toBeInTheDocument();

    cleanup();
    await renderRoute("/settings/recovery", clients.apiClient, clients.webAuthClient);
    expect(await screen.findByRole("button", { name: "Crear un código nuevo" })).toBeVisible();
    expect(screen.queryByText(code)).not.toBeInTheDocument();
  });
});

describe("verified-email replacement request route", () => {
  afterEach(resetApplicationTest);

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

  it("requires fresh pairing when replacement initiation is refused", async () => {
    const requests: Array<string> = [];
    const clients = emailReplacementClients(requests, {
      status: 401,
      body: {
        error: { code: "unauthenticated", message: "Authenticate before continuing." },
        next: [],
      },
    });
    await renderRoute("/settings/email", clients.apiClient, clients.webAuthClient);

    fireEvent.change(await screen.findByLabelText("Nuevo correo"), {
      target: { value: "new.mailbox@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enviar código" }));

    expect(await screen.findByText("Vincula el navegador de nuevo")).toBeVisible();
    expect(requests).toEqual(["/email/replacement"]);
  });
});

describe("verified-email replacement completion failures", () => {
  afterEach(resetApplicationTest);

  it("distinguishes stale authority from an invalid replacement proof", async () => {
    const freshPairingResponse: StubResponse = {
      status: 401,
      body: {
        error: {
          code: "fresh_pairing_required",
          message: "Vincula el navegador de nuevo antes de cambiar tu correo.",
        },
      },
    };
    const freshRequests: Array<string> = [];
    const freshClients = emailReplacementClients(
      freshRequests,
      successfulReplacementRequest,
      freshPairingResponse
    );
    await renderRoute("/settings/email", freshClients.apiClient, freshClients.webAuthClient);
    await beginRenderedEmailReplacement("fresh@example.com");
    await enterReplacementCode();
    expect(await screen.findByText("Vincula el navegador de nuevo")).toBeVisible();

    cleanup();
    const invalidRequests: Array<string> = [];
    const invalidClients = emailReplacementClients(invalidRequests, successfulReplacementRequest, {
      status: 400,
      body: {
        error: {
          code: "verification_invalid",
          message: "El código no es válido. Revisa el correo o solicita uno nuevo.",
        },
      },
    });
    await renderRoute("/settings/email", invalidClients.apiClient, invalidClients.webAuthClient);
    await beginRenderedEmailReplacement("invalid@example.com");
    await enterReplacementCode();
    expect(await screen.findByText("El código no es válido")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Usar otro correo" }));
    expect(await screen.findByLabelText("Nuevo correo")).toBeVisible();
  });

  it("keeps malformed candidate email local to the editing state", async () => {
    const requests: Array<string> = [];
    const clients = emailReplacementClients(requests);
    await renderRoute("/settings/email", clients.apiClient, clients.webAuthClient);
    const input = await screen.findByLabelText("Nuevo correo");
    fireEvent.change(input, { target: { value: "not-an-email" } });
    const form = input.closest("form");
    if (form === null) throw new Error("replacement form missing");
    fireEvent.submit(form);
    await waitFor(() => expect(requests).toHaveLength(0));
    expect(screen.getByLabelText("Nuevo correo")).toBeVisible();
  });
});

describe("signed-in web application data routes", () => {
  afterEach(resetApplicationTest);

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
