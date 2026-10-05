import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { it } from "@effect/vitest";
import { type Cause, Deferred, Effect, Layer } from "effect";
import { HttpClient, type HttpClientError, HttpClientResponse } from "effect/http";
import type { JSX } from "react";
import { afterEach, expect } from "vitest";
import { SessionRegistryProvider } from "@/session/session";
import { useSession } from "@/session/session-context";
import { type WebAuthClient, makeWebAuthClient } from "@/transport/client";
import { SignedInFeature } from "./feature";

const SessionProbe = (): JSX.Element => {
  const { authentication, completeLogin } = useSession();
  return (
    <>
      <p>Estado: {authentication}</p>
      <button onClick={completeLogin}>Iniciar sesión de prueba</button>
    </>
  );
};

const renderShell = (webAuthClient: WebAuthClient): void => {
  const root = createRootRouteWithContext<{ webAuthClient: WebAuthClient }>()({
    component: () => (
      <>
        <SessionProbe />
        <Outlet />
      </>
    ),
  });
  const app = createRoute({ getParentRoute: () => root, path: "/app", component: SignedInFeature });
  const dashboard = createRoute({
    getParentRoute: () => app,
    path: "dashboard",
    component: () => <p>Tablero de prueba</p>,
  });
  const pair = createRoute({
    getParentRoute: () => root,
    path: "/auth/pair",
    component: () => <p>Emparejar de prueba</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([app.addChildren([dashboard]), pair]),
    context: { webAuthClient },
    history: createMemoryHistory({ initialEntries: ["/app/dashboard"] }),
  });
  render(
    <SessionRegistryProvider>
      <RouterProvider router={router} />
    </SessionRegistryProvider>
  );
};

const wait = (assertion: () => void): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() => waitFor(assertion));
const clientFor = (
  respond: (
    request: Parameters<typeof HttpClientResponse.fromWeb>[0]
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>
): WebAuthClient =>
  makeWebAuthClient({
    apiOrigin: "https://api.fidyapp.com",
    httpClient: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.makeWith<
        HttpClientError.HttpClientError,
        never,
        HttpClientError.HttpClientError,
        never
      >((effect) => Effect.flatMap(effect, respond), Effect.succeed)
    ),
  });

afterEach(cleanup);

const unavailableStatus = 503;
const temporaryRedirectStatus = 307;

it.effect.each([unavailableStatus, temporaryRedirectStatus])(
  "observes failed logout status %s, retains local authentication and permits an explicit retry",
  (status) =>
    Effect.gen(function* () {
      let calls = 0;
      let response = new Response(null, {
        status,
        headers:
          status === temporaryRedirectStatus ? { location: "https://other.example/logout" } : {},
      });
      renderShell(
        clientFor((request) => {
          calls += 1;
          return Effect.succeed(HttpClientResponse.fromWeb(request, response));
        })
      );
      yield* wait(() =>
        expect(screen.getByRole("button", { name: "Iniciar sesión de prueba" })).toBeInTheDocument()
      );
      fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión de prueba" }));
      yield* wait(() => expect(screen.getByText("Estado: signed-in")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
      yield* wait(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "No pudimos confirmar el cierre de sesión"
        )
      );
      expect(screen.getByText("Estado: signed-in")).toBeInTheDocument();
      expect(screen.queryByText("Emparejar de prueba")).toBeNull();
      expect(calls).toBe(1);
      response = new Response(null, { status: 204 });
      fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
      yield* wait(() => expect(screen.getByText("Emparejar de prueba")).toBeInTheDocument());
      expect(screen.getByText("Estado: signed-out")).toBeInTheDocument();
      expect(calls).toBe(2);
    })
);

it.effect(
  "disables overlapping logout while transport is pending and publishes success only afterwards",
  () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      let calls = 0;
      renderShell(
        clientFor((request) => {
          calls += 1;
          return Deferred.await(release).pipe(
            Effect.as(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })))
          );
        })
      );
      yield* wait(() =>
        expect(screen.getByRole("button", { name: "Iniciar sesión de prueba" })).toBeInTheDocument()
      );
      fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión de prueba" }));
      yield* wait(() => expect(screen.getByText("Estado: signed-in")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
      yield* wait(() =>
        expect(screen.getByRole("button", { name: "Cerrando sesión…" })).toBeDisabled()
      );
      fireEvent.click(screen.getByRole("button", { name: "Cerrando sesión…" }));
      expect(calls).toBe(1);
      expect(screen.getByText("Estado: signed-in")).toBeInTheDocument();
      yield* Deferred.succeed(release, undefined);
      yield* wait(() => expect(screen.getByText("Emparejar de prueba")).toBeInTheDocument());
      expect(screen.getByText("Estado: signed-out")).toBeInTheDocument();
    })
);
