import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { Effect, Layer, Option } from "effect";
import { HttpClient } from "effect/http";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionRegistryProvider } from "@/session/session";
import { makeFidyClient, makeHostedTurnClient, makeWebAuthClient } from "@/transport/client";
import { ProviderAuthenticationFeature } from "./feature";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderAuthentication = (httpClient: HttpClient.HttpClient): ReturnType<typeof render> => {
  const options = {
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(HttpClient.HttpClient, httpClient),
  };
  const context = {
    apiClient: makeFidyClient(options),
    hostedTurnClient: makeHostedTurnClient(options),
    webAuthClient: makeWebAuthClient(options),
  };
  const root = createRootRouteWithContext<typeof context>()();
  const route = createRoute({
    getParentRoute: () => root,
    path: "/auth/google",
    component: () => (
      <ProviderAuthenticationFeature provider="google" handoffReference={Option.none()} />
    ),
  });
  const router = createRouter({
    context,
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/auth/google"] }),
  });
  return render(
    <StrictMode>
      <SessionRegistryProvider>
        <RouterProvider router={router} />
      </SessionRegistryProvider>
    </StrictMode>
  );
};

const authenticationLifetime = Effect.gen(function* () {
  const started = vi.fn<() => void>();
  const interrupted = vi.fn<() => void>();
  const httpClient = HttpClient.make((request) =>
    request.method === "POST"
      ? Effect.sync(started).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Effect.sync(interrupted))
        )
      : Effect.never
  );
  const opened = vi.spyOn(window, "open").mockReturnValue(window);
  const closed = vi.spyOn(window, "close").mockImplementation(() => {});
  const mounted = renderAuthentication(httpClient);
  fireEvent.click(
    yield* Effect.tryPromise(() =>
      screen.findByRole("button", { name: "Ya tengo cuenta · Iniciar sesión" })
    )
  );
  yield* Effect.tryPromise(() =>
    waitFor(() => expect(screen.getByRole("heading", { name: "Inicia sesión" })).toBeVisible())
  );
  fireEvent.click(screen.getByRole("button", { name: "Continuar con Google" }));
  yield* Effect.tryPromise(() => waitFor(() => expect(started).toHaveBeenCalledTimes(1)));
  expect(opened).toHaveBeenCalledTimes(1);
  mounted.unmount();
  expect(closed).toHaveBeenCalledTimes(1);
  yield* Effect.tryPromise(() => waitFor(() => expect(interrupted).toHaveBeenCalledTimes(1)));
  renderAuthentication(httpClient);
  expect(
    yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "Crea tu cuenta" }))
  ).toBeVisible();
  expect(screen.queryByText("Esperando confirmación…")).not.toBeInTheDocument();
  expect(started).toHaveBeenCalledTimes(1);
});

it("survives Strict Mode replay and revokes pending authentication on unmount", () =>
  Effect.runPromise(authenticationLifetime));
