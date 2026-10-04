import { RegistryProvider } from "@effect/atom-react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { type Cause, Effect, Layer } from "effect";
import {
  HttpClient,
  type HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { afterEach, expect, it } from "vitest";
import { type WebAuthClient, makeWebAuthClient } from "@/transport/client";
import { OAuthManagementFeature, OAuthReviewFeature } from "./feature";

const requestId = "10000000-0000-4000-8000-000000000001";
const review = {
  requestId,
  claimedClientName: "Agente personal",
  scopes: ["read"],
  permissions: [
    { scope: "read", label: "Consultar tus datos", description: "Consulta tus datos." },
  ],
  reviewedAt: "2026-10-03T12:00:00.000Z",
  requestExpiresAt: "2026-10-03T12:10:00.000Z",
  connectAvailable: true,
};
const connection = {
  connectionId: requestId,
  claimedClientName: "Agente personal",
  scopes: review.scopes,
  permissions: review.permissions,
  expiresAt: "2026-12-01T00:00:00Z",
  state: "active",
  recentActivity: [],
};
const successStatus = 200;
type Reply = Readonly<{ body: unknown }> | Readonly<{ body: unknown; status: number }>;
const wait = <A,>(promise: Promise<A>): Effect.Effect<A, Cause.UnknownError> =>
  Effect.tryPromise(() => promise);
const renderFeature = (
  path: string,
  handler: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<Reply>
): (() => Readonly<Record<string, unknown>>) => {
  const httpClient = HttpClient.makeWith<
    HttpClientError.HttpClientError,
    never,
    HttpClientError.HttpClientError,
    never
  >(
    (effect) =>
      Effect.flatMap(effect, (request) =>
        handler(request).pipe(
          Effect.map((reply) =>
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify(reply.body), {
                status: "status" in reply ? reply.status : successStatus,
                headers: { "content-type": "application/json" },
              })
            )
          )
        )
      ),
    Effect.succeed
  );
  const client = makeWebAuthClient({
    apiOrigin: "https://api.fidyapp.com",
    httpClient: Layer.succeed(HttpClient.HttpClient, httpClient),
  });
  const root = createRootRouteWithContext<{ webAuthClient: WebAuthClient }>()();
  const reviewRoute = createRoute({
    getParentRoute: () => root,
    path: "/oauth/$requestId",
    component: OAuthReviewFeature,
  });
  const managementRoute = createRoute({
    getParentRoute: () => root,
    path: "/settings/agents",
    component: OAuthManagementFeature,
  });
  const router = createRouter({
    routeTree: root.addChildren([reviewRoute, managementRoute]),
    context: { webAuthClient: client },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <RegistryProvider>
      <RouterProvider router={router} />
    </RegistryProvider>
  );
  return () => router.state.location.search;
};
afterEach(cleanup);

it("refuses malformed review references without querying authority", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const requests: string[] = [];
      renderFeature("/oauth/invalid", (request) => {
        requests.push(request.url);
        return Effect.succeed({ body: review });
      });
      expect(yield* wait(screen.findByRole("alert"))).toHaveTextContent(
        "La solicitud no es válida."
      );
      expect(requests).toEqual([]);
    })
  ));
it("keeps unavailable review separate from approval and offers fresh sign-in", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      renderFeature(`/oauth/${requestId}`, () =>
        Effect.succeed({ body: { error: "unauthenticated" }, status: 401 })
      );
      expect(yield* wait(screen.findByText("Solicitud no disponible"))).toBeVisible();
      expect(screen.getByRole("link", { name: "Iniciar sesión" })).toHaveAttribute(
        "href",
        `/auth/pair?oauthRequest=${requestId}`
      );
    })
  ));
it("cancels a reviewed request and never presents it as approved", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      renderFeature(`/oauth/${requestId}`, (request) =>
        Effect.succeed({ body: request.method === "GET" ? review : { cancelled: true } })
      );
      fireEvent.click(yield* wait(screen.findByRole("button", { name: "Cancelar" })));
      expect(
        yield* wait(screen.findByText("Solicitud cancelada. No se autorizó ningún acceso."))
      ).toBeVisible();
    })
  ));
it("reports cancellation failure and allows a deliberate retry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let attempts = 0;
      renderFeature(`/oauth/${requestId}`, (request) => {
        if (request.method === "GET") return Effect.succeed({ body: review });
        attempts += 1;
        return Effect.succeed(
          attempts === 1
            ? { body: { error: "temporarily_unavailable" }, status: 503 }
            : { body: { cancelled: true } }
        );
      });
      fireEvent.click(yield* wait(screen.findByRole("button", { name: "Cancelar" })));
      expect(yield* wait(screen.findByRole("alert"))).toHaveTextContent("No pudimos cancelar.");
      fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
      expect(
        yield* wait(screen.findByText("Solicitud cancelada. No se autorizó ningún acceso."))
      ).toBeVisible();
      expect(attempts).toBe(2);
    })
  ));
it("does not replay an uncertain approval or label it connected", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let attempts = 0;
      renderFeature(`/oauth/${requestId}`, (request) => {
        if (request.method === "GET") return Effect.succeed({ body: review });
        attempts += 1;
        return Effect.succeed({ body: { error: "temporarily_unavailable" }, status: 503 });
      });
      fireEvent.click(yield* wait(screen.findByRole("button", { name: "Conectar" })));
      expect(yield* wait(screen.findByRole("alert"))).toHaveTextContent(
        "no repitas esta aprobación"
      );
      yield* wait(
        waitFor(() => expect(screen.getByRole("button", { name: "Conectando…" })).toBeDisabled())
      );
      expect(attempts).toBe(1);
    })
  ));
it("keeps loading distinct from empty connection evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const reply = Promise.withResolvers<Reply>();
      renderFeature("/settings/agents", () => wait(reply.promise).pipe(Effect.orDie));
      expect(yield* wait(screen.findByText("Cargando agentes…"))).toBeVisible();
      expect(screen.queryByText("No hay conexiones en esta página.")).not.toBeInTheDocument();
      reply.resolve({ body: { connections: [], nextCursor: null } });
      expect(yield* wait(screen.findByText("No hay conexiones en esta página."))).toBeVisible();
    })
  ));
it("keeps unavailable management evidence distinct from an empty list", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      renderFeature("/settings/agents", () =>
        Effect.succeed({ body: { error: "unauthenticated" }, status: 401 })
      );
      expect(yield* wait(screen.findByRole("alert"))).toHaveTextContent(
        "no mostramos una lista vacía"
      );
      expect(screen.queryByText("No hay conexiones en esta página.")).not.toBeInTheDocument();
    })
  ));
it.each(["Revocar este agente", "Revocar todos los agentes conectados"])(
  "invalidates the owned list after %s",
  (button) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const mutations: string[] = [];
        let reads = 0;
        renderFeature("/settings/agents", (request) => {
          if (request.method === "GET") {
            reads += 1;
            return Effect.succeed({ body: { connections: [connection], nextCursor: null } });
          }
          mutations.push(request.url);
          return Effect.succeed({ body: { revoked: true } });
        });
        yield* wait(screen.findByText("Agente personal"));
        fireEvent.click(screen.getByRole("button", { name: button }));
        expect(yield* wait(screen.findByRole("status"))).toHaveTextContent("Acceso revocado.");
        yield* wait(waitFor(() => expect(reads).toBeGreaterThan(1)));
        expect(mutations).toHaveLength(1);
      })
    )
);
it("does not claim successful revocation on failure and permits refreshing evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let reads = 0;
      renderFeature("/settings/agents", (request) => {
        if (request.method === "GET") {
          reads += 1;
          return Effect.succeed({ body: { connections: [connection], nextCursor: null } });
        }
        return Effect.succeed({ body: { error: "temporarily_unavailable" }, status: 503 });
      });
      fireEvent.click(yield* wait(screen.findByRole("button", { name: "Revocar este agente" })));
      expect(yield* wait(screen.findByRole("alert"))).toHaveTextContent(
        "No pudimos confirmar la revocación."
      );
      fireEvent.click(screen.getByRole("button", { name: "Actualizar lista" }));
      yield* wait(waitFor(() => expect(reads).toBeGreaterThan(1)));
    })
  ));
it("marks previous connection evidence stale and disables revocation after refresh failure", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let reads = 0;
      renderFeature("/settings/agents", () => {
        reads += 1;
        return Effect.succeed(
          reads === 1
            ? { body: { connections: [connection], nextCursor: null } }
            : { body: { error: "temporarily_unavailable" }, status: 503 }
        );
      });
      yield* wait(screen.findByText("Agente personal"));
      fireEvent.click(screen.getByRole("button", { name: "Actualizar lista" }));
      expect(yield* wait(screen.findByRole("alert"))).toHaveTextContent(
        "La información anterior puede haber cambiado."
      );
      expect(screen.getByRole("button", { name: "Revocar este agente" })).toBeDisabled();
    })
  ));
it("puts connection pagination in the router and offers a first-page link", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const router = renderFeature("/settings/agents", () =>
        Effect.succeed({ body: { connections: [connection], nextCursor: requestId } })
      );
      fireEvent.click(yield* wait(screen.findByRole("button", { name: "Siguiente página" })));
      expect(yield* wait(screen.findByRole("link", { name: "Primera página" }))).toBeVisible();
      expect(router()).toMatchObject({ after: requestId });
    })
  ));
