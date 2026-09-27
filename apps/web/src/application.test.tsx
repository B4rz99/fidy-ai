import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { Data, Effect, Layer, Option } from "effect";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebRouter } from "@/app/routes";
import { SessionRegistryProvider } from "@/session/session";
import { SubscriptionEnrollmentLifetime } from "@/session/subscription-enrollment-lifetime";
import {
  BackupRecoveryCode,
  type FidyClient,
  type HostedTurnClient,
  type WebAuthClient,
  makeFidyClient,
  makeHostedTurnClient,
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

class TestPromiseFailure extends Data.TaggedError("TestPromiseFailure")<{ cause: unknown }> {}

const fromPromise = <A,>(promise: Promise<A>): Effect.Effect<A, TestPromiseFailure> =>
  Effect.tryPromise({
    try: () => promise,
    catch: (cause) => new TestPromiseFailure({ cause }),
  });

const renderRoute = (
  path: string,
  apiClient = makeFidyClient("https://api.test.fidyapp.com"),
  webAuthClient: WebAuthClient = makeWebAuthClient("https://api.test.fidyapp.com")
): Promise<ReturnType<typeof createWebRouter>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const router = createWebRouter({
        apiClient,
        webAuthClient,
        hostedTurnClient: makeHostedTurnClient("https://api.test.fidyapp.com"),
        history: Option.some(createMemoryHistory({ initialEntries: [path] })),
      });
      render(
        <SessionRegistryProvider>
          <SubscriptionEnrollmentLifetime
            makeClient={() => makeSubscriptionEnrollmentClient("https://api.test.fidyapp.com")}
          >
            <RouterProvider router={router} />
          </SubscriptionEnrollmentLifetime>
        </SessionRegistryProvider>
      );
      yield* fromPromise(router.load());
      return router;
    })
  );

const renderHostedRoute = (hostedTurnClient: HostedTurnClient): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const router = createWebRouter({
        apiClient: makeFidyClient("https://api.test.fidyapp.com"),
        webAuthClient: makeWebAuthClient("https://api.test.fidyapp.com"),
        hostedTurnClient,
        history: Option.some(createMemoryHistory({ initialEntries: ["/app/agent"] })),
      });
      render(
        <SessionRegistryProvider>
          <RouterProvider router={router} />
        </SessionRegistryProvider>
      );
      yield* fromPromise(router.load());
    })
  );

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
  body: { data: { status: "replaced" }, next: [] },
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

const beginRenderedEmailReplacement = (candidateEmail: string): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      fireEvent.change(yield* fromPromise(screen.findByLabelText("Nuevo correo")), {
        target: { value: candidateEmail },
      });
      fireEvent.click(screen.getByRole("button", { name: "Enviar código" }));
      expect(
        yield* fromPromise(screen.findByText(`Enviamos un código a ${candidateEmail}.`))
      ).toBeVisible();
    })
  );

const enterReplacementCode = (): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      fireEvent.change(yield* fromPromise(screen.findByLabelText("Código de verificación")), {
        target: { value: "BCDF-GHJK-MNPQ-RSTW-XY23-4567" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Cambiar correo" }));
    })
  );

const submitRenderedEmailReplacement = (requests: Array<string>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* fromPromise(beginRenderedEmailReplacement("new.mailbox@example.com"));
      fireEvent.click(screen.getByRole("button", { name: "Reenviar código" }));
      yield* fromPromise(waitFor(() => expect(requests).toHaveLength(2)));
      yield* fromPromise(enterReplacementCode());
      expect(
        yield* fromPromise(screen.findByText("Tu nuevo correo verificado ya está activo."))
      ).toBeVisible();
    })
  );

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
  it("renders the authoritative policy at its stable route", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* fromPromise(renderRoute("/politica"));

        expect(
          yield* fromPromise(
            screen.findByRole("heading", {
              level: 1,
              name: "Política de tratamiento de datos personales",
            })
          )
        ).toBeVisible();
        expect(screen.getByText("policy-2026-09-21")).toBeVisible();
        expect(screen.getByText(/Cloudflare Workers AI/iu)).toBeVisible();
        expect(screen.getByText(/fuera de Colombia/iu)).toBeVisible();
        expect(screen.queryByText(/cuentas|saldos/iu)).not.toBeInTheDocument();
        expect(
          screen.queryByRole("link", { name: /términos de servicio/iu })
        ).not.toBeInTheDocument();
      })
    ));

  it("does not start browser pairing merely by opening its route", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* fromPromise(renderRoute("/auth/pair"));

        expect(
          yield* fromPromise(screen.findByRole("heading", { name: "Inicia sesión en Fidy" }))
        ).toBeVisible();
        expect(
          screen.getByRole("button", { name: "Iniciar sesión en el navegador" })
        ).toBeVisible();
        expect(screen.queryByText(/pairing code/iu)).not.toBeInTheDocument();
      })
    ));
});

const transactionCaptureInstant = (request: HttpClientRequest.HttpClientRequest): string => {
  if (request.body._tag !== "Uint8Array") throw new Error("Expected canonical JSON body");
  const body: unknown = JSON.parse(new TextDecoder().decode(request.body.body));
  if (typeof body !== "object" || body === null || !("occurredAt" in body)) {
    throw new Error("Missing occurredAt");
  }
  return String(body.occurredAt);
};

const httpCreated = 201;
const httpUnavailable = 503;
const transactionCaptureClient = (
  requests: Array<string>,
  capturedInstants: Array<string>
): FidyClient => {
  const categoryId = "24000000-0000-4000-8000-000000000001";
  const httpClient = makeHttpClient((request) => {
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    if (path === "/user") {
      return Effect.succeed(
        responseJson(request, {
          data: {
            id: "24000000-0000-4000-8000-000000000003",
            serviceMarket: "CO",
            locale: "es-CO",
            timeZone: "America/Bogota",
            trialPeriod: { startedAt: "2025-01-01T00:00:00Z", endsAt: "2025-01-08T00:00:00Z" },
            createdAt: "2025-01-01T00:00:00Z",
          },
          next: [],
        })
      );
    }
    if (path === "/categories") {
      return Effect.succeed(
        responseJson(request, { data: [{ id: categoryId, label: "Restaurantes" }], next: [] })
      );
    }
    if (path === "/transactions" && request.method === "POST") {
      capturedInstants.push(transactionCaptureInstant(request));
      return Effect.succeed(
        responseJson(
          request,
          {
            data: {
              id: "24000000-0000-4000-8000-000000000002",
              revision: 0,
              money: { amount: "25000", currency: "COP" },
              direction: "outflow",
              counterparty: "El Corral",
              categoryId,
              occurredAt: "2025-01-10T05:00:00.000Z",
              createdAt: "2026-09-08T12:00:00.000Z",
            },
            next: [],
          },
          httpCreated
        )
      );
    }
    if (path === "/transactions") {
      return Effect.succeed(responseJson(request, { data: [], next: [] }));
    }
    return Effect.succeed(responseJson(request, { status: "unavailable" }, httpUnavailable));
  });
  return makeFidyClient(
    "https://api.test.fidyapp.com",
    Layer.succeed(HttpClient.HttpClient, httpClient)
  );
};

const requestCount = (requests: ReadonlyArray<string>, target: string): number =>
  requests.filter((request) => request === target).length;

describe("signed-in web application routes", () => {
  afterEach(resetApplicationTest);

  it("owns Transactions at /app/transactions and safely presents malformed canonical data", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* fromPromise(renderRoute("/app/transactions", malformedFidyClient()));

        expect(
          yield* fromPromise(screen.findByText("No pudimos comunicarnos con Fidy"))
        ).toBeVisible();
      })
    ));

  it("captures through the generated HTTP client and presents the returned Transaction even outside the first history page", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const requests: Array<string> = [];
        const capturedInstants: Array<string> = [];
        yield* fromPromise(
          renderRoute("/app/transactions", transactionCaptureClient(requests, capturedInstants))
        );
        expect(
          yield* fromPromise(screen.findByText("Aún no hay transacciones este mes"))
        ).toBeVisible();
        fireEvent.change(screen.getByLabelText("Monto en COP"), { target: { value: "25000" } });
        fireEvent.change(screen.getByLabelText("Fecha del movimiento"), {
          target: { value: "2025-01-10" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Registrar transacción" }));
        expect(
          yield* fromPromise(screen.findByLabelText("Transacción recién registrada"))
        ).toHaveTextContent("El Corral");
        expect(screen.getByLabelText("Transacción recién registrada")).toHaveTextContent(
          "10-01-2025"
        );
        const assertRefetched = (): void => {
          expect(requestCount(requests, "GET /transactions")).toBe(2);
        };
        yield* fromPromise(waitFor(assertRefetched));
        expect(requests).toContain("POST /transactions");
        expect(capturedInstants).toEqual(["2025-01-10T05:00:00.000Z"]);
      })
    ));
});

describe("signed-in web application routes — invalid Money", () => {
  afterEach(resetApplicationTest);

  it("refuses malformed Money before sending a canonical create request", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const requests: Array<string> = [];
        const capturedInstants: Array<string> = [];
        yield* fromPromise(
          renderRoute("/app/transactions", transactionCaptureClient(requests, capturedInstants))
        );
        expect(
          yield* fromPromise(screen.findByText("Aún no hay transacciones este mes"))
        ).toBeVisible();
        fireEvent.change(screen.getByLabelText("Monto en COP"), {
          target: { value: "not-a-number" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Registrar transacción" }));
        expect(yield* fromPromise(screen.findByRole("alert"))).toHaveTextContent(
          "No se pudo guardar la transacción"
        );
        expect(requests).not.toContain("POST /transactions");
        expect(capturedInstants).toEqual([]);
      })
    ));
});

describe("backup recovery route", () => {
  afterEach(resetApplicationTest);

  it("drops one-time disclosure through navigation, logout, and a fresh application mount", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const code = BackupRecoveryCode.make("ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2");
        const clients = recoveryClients();
        const router = yield* fromPromise(
          renderRoute("/settings/recovery", clients.apiClient, clients.webAuthClient)
        );

        fireEvent.click(
          yield* fromPromise(screen.findByRole("button", { name: "Crear un código nuevo" }))
        );
        expect(yield* fromPromise(screen.findByText(code))).toBeVisible();

        const navigateToEmail = (): ReturnType<typeof router.navigate> =>
          router.navigate({ to: "/settings/email" });
        yield* fromPromise(act(navigateToEmail));
        expect(screen.queryByText(code)).not.toBeInTheDocument();
        const navigateToRecovery = (): ReturnType<typeof router.navigate> =>
          router.navigate({ to: "/settings/recovery" });
        yield* fromPromise(act(navigateToRecovery));
        expect(screen.queryByText(code)).not.toBeInTheDocument();

        fireEvent.click(
          yield* fromPromise(screen.findByRole("button", { name: "Crear un código nuevo" }))
        );
        expect(yield* fromPromise(screen.findByText(code))).toBeVisible();
        fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
        const assertLoggedOut = (): void => {
          expect(clients.requests).toContain("/web/session/logout");
        };
        yield* fromPromise(waitFor(assertLoggedOut));
        expect(
          yield* fromPromise(screen.findByRole("heading", { name: "Inicia sesión en Fidy" }))
        ).toBeVisible();
        expect(screen.queryByText(code)).not.toBeInTheDocument();

        cleanup();
        yield* fromPromise(
          renderRoute("/settings/recovery", clients.apiClient, clients.webAuthClient)
        );
        expect(
          yield* fromPromise(screen.findByRole("button", { name: "Crear un código nuevo" }))
        ).toBeVisible();
        expect(screen.queryByText(code)).not.toBeInTheDocument();
      })
    ));
});

describe("verified-email replacement request route", () => {
  afterEach(resetApplicationTest);

  it("runs verified-email replacement through the rendered route and typed clients", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        localStorage.clear();
        sessionStorage.clear();
        const requests: Array<string> = [];
        const clients = emailReplacementClients(requests);
        yield* fromPromise(
          renderRoute("/settings/email", clients.apiClient, clients.webAuthClient)
        );
        yield* fromPromise(submitRenderedEmailReplacement(requests));
        expect(requests).toEqual([
          "/email/replacement",
          "/email/replacement",
          "/web/email/replacement/verify",
        ]);
        expect(window.location.search).toBe("");
        expect(localStorage.length).toBe(0);
        expect(sessionStorage.length).toBe(0);
      })
    ));

  it("requires fresh pairing when replacement initiation is refused", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const requests: Array<string> = [];
        const clients = emailReplacementClients(requests, {
          status: 401,
          body: {
            error: { code: "unauthenticated", message: "Authenticate before continuing." },
            next: [],
          },
        });
        yield* fromPromise(
          renderRoute("/settings/email", clients.apiClient, clients.webAuthClient)
        );

        fireEvent.change(yield* fromPromise(screen.findByLabelText("Nuevo correo")), {
          target: { value: "new.mailbox@example.com" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Enviar código" }));

        expect(
          yield* fromPromise(screen.findByText("Vincula el navegador de nuevo"))
        ).toBeVisible();
        expect(requests).toEqual(["/email/replacement"]);
      })
    ));
});

describe("verified-email replacement completion failures", () => {
  afterEach(resetApplicationTest);

  it("distinguishes stale authority from an invalid replacement proof", () =>
    Effect.runPromise(
      Effect.gen(function* () {
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
        yield* fromPromise(
          renderRoute("/settings/email", freshClients.apiClient, freshClients.webAuthClient)
        );
        yield* fromPromise(beginRenderedEmailReplacement("fresh@example.com"));
        yield* fromPromise(enterReplacementCode());
        expect(
          yield* fromPromise(screen.findByText("Vincula el navegador de nuevo"))
        ).toBeVisible();

        cleanup();
        const invalidRequests: Array<string> = [];
        const invalidClients = emailReplacementClients(
          invalidRequests,
          successfulReplacementRequest,
          {
            status: 400,
            body: {
              error: {
                code: "verification_invalid",
                message: "El código no es válido. Revisa el correo o solicita uno nuevo.",
              },
            },
          }
        );
        yield* fromPromise(
          renderRoute("/settings/email", invalidClients.apiClient, invalidClients.webAuthClient)
        );
        yield* fromPromise(beginRenderedEmailReplacement("invalid@example.com"));
        yield* fromPromise(enterReplacementCode());
        expect(yield* fromPromise(screen.findByText("El código no es válido"))).toBeVisible();
        fireEvent.click(screen.getByRole("button", { name: "Usar otro correo" }));
        expect(yield* fromPromise(screen.findByLabelText("Nuevo correo"))).toBeVisible();
      })
    ));
});

describe("verified-email replacement malformed candidate", () => {
  afterEach(resetApplicationTest);

  it("keeps malformed candidate email local to the editing state", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const requests: Array<string> = [];
        const clients = emailReplacementClients(requests);
        yield* fromPromise(
          renderRoute("/settings/email", clients.apiClient, clients.webAuthClient)
        );
        const input = yield* fromPromise(screen.findByLabelText("Nuevo correo"));
        fireEvent.change(input, { target: { value: "not-an-email" } });
        const form = input.closest("form");
        if (form === null) throw new Error("replacement form missing");
        fireEvent.submit(form);
        const assertNoRequests = (): void => {
          expect(requests).toHaveLength(0);
        };
        yield* fromPromise(waitFor(assertNoRequests));
        expect(screen.getByLabelText("Nuevo correo")).toBeVisible();
      })
    ));
});

describe("verified-email replacement malformed proof", () => {
  afterEach(resetApplicationTest);

  it("rejects malformed proof locally without sending it to the API", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const requests: Array<string> = [];
        const clients = emailReplacementClients(requests);
        yield* fromPromise(
          renderRoute("/settings/email", clients.apiClient, clients.webAuthClient)
        );
        yield* fromPromise(beginRenderedEmailReplacement("new.mailbox@example.com"));
        const input = yield* fromPromise(screen.findByLabelText("Código de verificación"));
        fireEvent.change(input, { target: { value: "not-a-code" } });
        fireEvent.click(screen.getByRole("button", { name: "Cambiar correo" }));
        expect(yield* fromPromise(screen.findByText("El código no es válido"))).toBeVisible();
        expect(requests).toEqual(["/email/replacement"]);
      })
    ));
});

const hostedReceiptLength = 64;
const proposedStatus = 202;
const acknowledgedStatus = 200;
const rejectedStatus = 401;

describe("hosted Agent reply delivery", () => {
  afterEach(resetApplicationTest);

  it("requires a visibly rendered reply and explicit receipt before showing Completed", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const paths: Array<string> = [];
        const reply = (
          request: HttpClientRequest.HttpClientRequest
        ): Effect.Effect<HttpClientResponse.HttpClientResponse> => {
          const path = new URL(request.url).pathname;
          paths.push(path);
          return Effect.succeed(
            responseJson(
              request,
              path.endsWith("/delivery")
                ? { status: "completed" }
                : {
                    text: "Respuesta exacta",
                    turnId: "10000000-0000-4000-8000-000000000097",
                    receipt: "a".repeat(hostedReceiptLength),
                  },
              path.endsWith("/delivery") ? acknowledgedStatus : proposedStatus
            )
          );
        };
        const httpClient = makeHttpClient(reply);
        const channel = makeHostedTurnClient(
          "https://api.test.fidyapp.com",
          Layer.succeed(HttpClient.HttpClient, httpClient)
        );
        const route = renderHostedRoute(channel);
        yield* fromPromise(route);
        fireEvent.change(yield* fromPromise(screen.findByLabelText("Mensaje")), {
          target: { value: "Hola" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
        expect(yield* fromPromise(screen.findByText("Respuesta exacta"))).toBeVisible();
        expect(paths).toEqual(["/web/hosted-turns"]);
        expect(screen.queryByText("Respuesta entregada.")).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Confirmar recepción" }));
        expect(yield* fromPromise(screen.findByText("Respuesta entregada."))).toBeVisible();
        expect(paths).toEqual(["/web/hosted-turns", "/web/hosted-turns/delivery"]);
      })
    ));
});

describe("rejected hosted Agent receipt", () => {
  afterEach(resetApplicationTest);

  it("does not label a rejected receipt Completed", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const rejectReceipt = (
          request: HttpClientRequest.HttpClientRequest
        ): Effect.Effect<HttpClientResponse.HttpClientResponse> =>
          Effect.succeed(
            responseJson(
              request,
              request.url.endsWith("/delivery")
                ? { status: "unauthenticated" }
                : {
                    text: "Respuesta sin confirmar",
                    turnId: "10000000-0000-4000-8000-000000000097",
                    receipt: "a".repeat(hostedReceiptLength),
                  },
              request.url.endsWith("/delivery") ? rejectedStatus : proposedStatus
            )
          );
        const httpClient = makeHttpClient(rejectReceipt);
        const channel = makeHostedTurnClient(
          "https://api.test.fidyapp.com",
          Layer.succeed(HttpClient.HttpClient, httpClient)
        );
        const route = renderHostedRoute(channel);
        yield* fromPromise(route);
        fireEvent.change(yield* fromPromise(screen.findByLabelText("Mensaje")), {
          target: { value: "Hola" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
        fireEvent.click(
          yield* fromPromise(screen.findByRole("button", { name: "Confirmar recepción" }))
        );
        expect(
          yield* fromPromise(screen.findByText(/La entrega no se pudo confirmar/u))
        ).toBeVisible();
        expect(screen.queryByText("Respuesta entregada.")).not.toBeInTheDocument();
      })
    ));
});

describe("signed-in web application data routes", () => {
  afterEach(resetApplicationTest);

  it("owns the authenticated Subscription offer page at /upgrade", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* fromPromise(renderRoute("/upgrade", malformedFidyClient()));

        expect(
          yield* fromPromise(screen.findByRole("heading", { name: "Mejora tu suscripción" }))
        ).toBeVisible();
        expect(
          yield* fromPromise(screen.findByText("No pudimos comunicarnos con Fidy"))
        ).toBeVisible();
      })
    ));

  it("owns the Dashboard at /app/dashboard and safely presents malformed canonical data", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* fromPromise(renderRoute("/app/dashboard", malformedFidyClient()));

        expect(
          yield* fromPromise(
            screen.findByText("No pudimos comunicarnos con Fidy", undefined, { timeout: 3_000 })
          )
        ).toBeVisible();
      })
    ));

  it("redirects the authenticated /app index to the Dashboard", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* fromPromise(renderRoute("/app", malformedFidyClient()));

        expect(
          yield* fromPromise(
            screen.findByText("No pudimos comunicarnos con Fidy", undefined, { timeout: 3_000 })
          )
        ).toBeVisible();
      })
    ));
});
